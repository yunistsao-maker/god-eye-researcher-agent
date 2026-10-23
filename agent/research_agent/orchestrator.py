"""Research orchestration:

  plan (sub-questions + requirements) -> parallel sub-agents -> review & coverage
      -> follow-up rounds while requirements are weak or missing (depth decides how many)
      -> report written from verified claims [C#] -> sentence-level verification and revision
      -> link check -> synthesis -> done

Deterministic steps (saving, publishing, template lookups) are direct tool calls. Planning,
researching, UI design, review, the report, verification and revision use an LLM, behind the `Llm`
interface so tests can replace it. Every LLM step runs under the watchdog: a step that stalls is
cancelled and retried once.

Research and writing are separate on purpose: sub-agents work in parallel and only produce claims
backed by quotes (finding_write checks every quote against the stored page); one writer then works
sequentially from the claim catalog, and an independent verifier checks each cited sentence against
only the claims it cites.

A stop (StopSignal) can arrive at any moment: it cancels every model call, and the run checks it
before each step and tool call, then unwinds with ResearchStopped. The project's `stopped` status is
written by project_stop, so a stopped run writes nothing more.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, TypeVar

from . import verify as v
from .models import FindingDraft, PlanDraft, ReviewDraft, ReviseDraft, UiSpecDraft, VerifyDraft
from .research_tools import Budget, ResearchToolkit, SearchOptions
from .stopping import ResearchStopped, StopSignal
from .watch import AgentActivity, AgentCancelled, Stalled, Tracker

log = logging.getLogger(__name__)

SHAPED = {"comparison", "timeline", "metrics"}
COMPONENT_FOR_SHAPE = {"comparison": "Compare", "timeline": "Timeline", "metrics": "MetricBars"}
MAX_PLAN_ITEMS = 12  # plan_save accepts up to 12 sub-questions across all rounds
VERIFY_BATCH = 25
CLAIM_ID = re.compile(r"^c-[a-z0-9-]{1,60}$")
DEPTHS = ("quick", "standard", "deep")
T = TypeVar("T")


class Gateway(Protocol):
    def call(self, target: str, tool: str, **arguments: Any) -> dict: ...


class Llm(Protocol):
    def plan(self, topic: str, seed: str, brief: str = "", min_subs: int = 3, max_subs: int = 5,
             activity: Optional[AgentActivity] = None) -> PlanDraft: ...
    def research(self, question: str, shape: str, tools: list, feedback: str = "",
                 activity: Optional[AgentActivity] = None, reads: int = 4) -> FindingDraft: ...
    def design_ui(self, finding: dict, activity: Optional[AgentActivity] = None) -> UiSpecDraft: ...
    def review(self, topic: str, findings: list[dict], requirements: list[dict], max_follow_ups: int = 3,
               activity: Optional[AgentActivity] = None) -> ReviewDraft: ...
    def report(self, topic: str, requirements: list[dict], catalog: str, review: Optional[ReviewDraft], words: int = 800,
               activity: Optional[AgentActivity] = None, on_text: Optional[Callable[[str], None]] = None) -> str: ...
    def verify(self, items: list[dict], activity: Optional[AgentActivity] = None) -> VerifyDraft: ...
    def revise(self, items: list[dict], activity: Optional[AgentActivity] = None) -> ReviseDraft: ...


@dataclass
class Settings:
    max_parallel: int = 5
    min_subquestions: int = 3
    max_subquestions: int = 5
    follow_up_rounds: int = 1   # 0 disables coverage-driven follow-up research
    max_follow_ups: int = 3
    attempts: int = 2           # an LLM step that stalls is retried once
    searches_per_agent: int = 6
    reads_per_agent: int = 8
    report_words: int = 800
    verify: bool = True
    check_links: bool = True

    @classmethod
    def for_depth(cls, depth: str) -> "Settings":
        if depth == "quick":
            return cls(max_parallel=3, min_subquestions=2, max_subquestions=3, follow_up_rounds=0, max_follow_ups=0,
                       searches_per_agent=3, reads_per_agent=4, report_words=450)
        if depth == "deep":
            return cls(max_parallel=6, min_subquestions=4, max_subquestions=7, follow_up_rounds=2, max_follow_ups=4,
                       searches_per_agent=8, reads_per_agent=12, report_words=1500)
        return cls()


@dataclass
class Brief:
    """What the user decided before the run: depth, reader, time window and source preferences."""
    depth: str = "standard"
    audience: str = ""
    start_date: Optional[str] = None
    include_domains: list[str] = field(default_factory=list)
    exclude_domains: list[str] = field(default_factory=list)
    notes: str = ""

    @classmethod
    def from_payload(cls, payload: dict) -> "Brief":
        def domains(key: str) -> list[str]:
            value = payload.get(key) or []
            return [str(d).strip().lower() for d in value if isinstance(d, str) and d.strip()][:50] if isinstance(value, list) else []

        start = payload.get("startDate")
        depth = payload.get("depth") if payload.get("depth") in DEPTHS else "standard"
        return cls(depth=depth, audience=str(payload.get("audience") or "")[:200],
                   start_date=start if isinstance(start, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", start) else None,
                   include_domains=domains("includeDomains"), exclude_domains=domains("excludeDomains"),
                   notes=str(payload.get("notes") or "")[:1000])

    def describe(self) -> str:
        lines = [f"- depth: {self.depth}"]
        if self.audience:
            lines.append(f"- audience: {self.audience}")
        if self.start_date:
            lines.append(f"- only sources published on or after {self.start_date}")
        if self.include_domains:
            lines.append("- prefer these domains: " + ", ".join(self.include_domains))
        if self.exclude_domains:
            lines.append("- never use these domains: " + ", ".join(self.exclude_domains))
        if self.notes:
            lines.append(f"- notes: {self.notes}")
        return "\n".join(lines)


def to_finding(draft: FindingDraft, *, project_id: str, finding_id: str, question: str, shape: str) -> dict:
    """Turn the LLM draft into a contract Finding. Shape data that is missing downgrades to `list`.
    Claims stay in their draft form; finding_write verifies their quotes and stores the result."""
    entities, ids = [], {}
    for i, ent in enumerate(draft.entities[:12], start=1):
        key = ent.name.strip().lower()
        if not key or key in ids:
            continue
        ids[key] = f"e-{i}"
        entities.append({"id": ids[key], "type": ent.type, "name": ent.name.strip()[:80]})
    relations = []
    for rel in draft.relations[:12]:
        a, b = ids.get(rel.fromEntity.strip().lower()), ids.get(rel.toEntity.strip().lower())
        if a and b and a != b:
            relations.append({"from": a, "to": b, "type": rel.type})

    data: dict[str, Any] = {}
    if shape == "comparison" and draft.comparison and draft.comparison.rows:
        width = len(draft.comparison.columns)
        rows = [[str(c) for c in (r + [""] * width)[:width]] for r in draft.comparison.rows]
        data = {"columns": draft.comparison.columns, "rows": rows}
    elif shape == "timeline" and draft.timeline:
        data = {"items": [{"when": t.when, "what": t.what} for t in draft.timeline]}
    elif shape == "metrics" and draft.metrics:
        data = {"items": [{"label": m.label, "value": m.value, "unit": m.unit} for m in draft.metrics]}
    if shape in SHAPED and not data:
        shape = "list"

    sources = [{"title": s.title[:300], "url": s.url} for s in draft.sources if re.match(r"^https?://", s.url)][:10]
    finding: dict[str, Any] = {
        "findingId": finding_id,
        "projectId": project_id,
        "question": question[:300],
        "summary": draft.summary[:1200],
        "keyPoints": [k[:400] for k in draft.keyPoints[:8]],
        "entities": entities,
        "relations": relations,
        "sources": sources,
        "dataShape": shape,
        "data": data,
        "confidence": round(float(draft.confidence), 2),
    }
    if draft.claims:
        finding["claims"] = [{"text": c.text.strip()[:500],
                              "evidence": [{"docId": e.docId.strip(), "quote": e.quote.strip()[:600], "stance": e.stance}
                                           for e in c.evidence[:4]]}
                             for c in draft.claims[:12] if len(c.text.strip()) >= 5]
    return finding


def default_spec(shape: str) -> dict:
    component = COMPONENT_FOR_SHAPE.get(shape, "KeyPoints")
    return build_spec(UiSpecDraft(component=component), shape)


def build_spec(draft: UiSpecDraft, shape: str) -> dict:
    """Map the designer's choice onto whitelisted components; an unfit choice falls back to the default."""
    if draft.component != "KeyPoints" and COMPONENT_FOR_SHAPE.get(shape) != draft.component:
        return default_spec(shape)
    props: dict[str, Any] = {
        "Compare": {"columns": "$.data.columns", "rows": "$.data.rows"},
        "Timeline": {"items": "$.data.items", "label": "when", "text": "what"},
        "MetricBars": {"items": "$.data.items", "label": "label", "value": "value", "unit": "unit"},
        "KeyPoints": {"items": "$.keyPoints"},
    }[draft.component]
    if draft.component == "Compare" and draft.emphasizeColumn is not None:
        props["emphasizeColumn"] = draft.emphasizeColumn
    spec: dict[str, Any] = {"specVersion": 1, "dataShape": shape, "root": {"component": draft.component, "props": props}}
    if draft.title.strip():
        spec["title"] = draft.title.strip()[:80]
    return spec


def _null_emit(event_type: str, data: dict) -> None:
    return None


class Orchestrator:
    def __init__(self, gateway: Gateway, llm: Llm, settings: Optional[Settings] = None,
                 tracker: Optional[Tracker] = None, on_report_text: Optional[Callable[[str], None]] = None,
                 stop: Optional[StopSignal] = None, secondary_search: bool = False,
                 toolkit_factory: Optional[Callable[[str, str, "Brief"], ResearchToolkit]] = None):
        self.gw = gateway
        self.llm = llm
        self._fixed_settings = settings
        self.settings = settings or Settings()
        self.tracker = tracker or Tracker(_null_emit)
        self.on_report_text = on_report_text
        self.stop = stop or StopSignal()
        if self.stop.tracker is None:
            self.stop.tracker = self.tracker
        self.secondary_search = secondary_search
        self.toolkit_factory = toolkit_factory or self._toolkit
        self.findings_written = 0
        self._count_lock = threading.Lock()

    def _toolkit(self, project_id: str, finding_id: str, brief: Brief) -> ResearchToolkit:
        options = SearchOptions(start_date=brief.start_date, include_domains=brief.include_domains,
                                exclude_domains=brief.exclude_domains, secondary=self.secondary_search)
        return ResearchToolkit(self.gw, project_id, options,
                               Budget(searches=self.settings.searches_per_agent, reads=self.settings.reads_per_agent),
                               on_stop_check=self.stop.check)

    def run(self, *, project_id: str, topic: str, parent_project_id: Optional[str], session_id: str,
            brief: Optional[Brief] = None) -> dict:
        started = time.time()
        brief = brief or Brief()
        if self._fixed_settings is None:
            self.settings = Settings.for_depth(brief.depth)
        sup = self.tracker.agent("supervisor")
        self._call("project-tools", "project_save", projectId=project_id, status="running", topic=topic,
                   parentProjectId=parent_project_id, runtimeSessionId=session_id)
        try:
            seed = self._seed(parent_project_id) if parent_project_id else ""
            sup.set_phase("planning")
            plan = self._supervised(sup, lambda act: self.llm.plan(
                topic, seed, brief.describe(), self.settings.min_subquestions, self.settings.max_subquestions, act))
            subs = [{"findingId": f"f-{i + 1}", "question": s.question.strip()[:300], "dataShape": s.dataShape, "round": 1}
                    for i, s in enumerate(plan.subQuestions[: self.settings.max_subquestions])]
            requirements = [{"id": f"q{i + 1}", "text": r.strip()[:300]}
                            for i, r in enumerate([r for r in plan.requirements if len(r.strip()) >= 3][:10])]
            plan_args: dict[str, Any] = {"projectId": project_id, "subQuestions": subs}
            if requirements:
                plan_args["requirements"] = requirements
            self._call("data-tools", "plan_save", **plan_args)

            findings = self._run_round(project_id, subs, sup, brief)
            if not findings:
                raise RuntimeError("No sub-question produced a valid finding")

            review: Optional[ReviewDraft] = None
            follow_ups_total = 0
            for rnd in range(1, self.settings.follow_up_rounds + 2):
                review = self._review(project_id, topic, findings, requirements, rnd, sup) or review
                if rnd > self.settings.follow_up_rounds or review is None:
                    break
                room = min(self.settings.max_follow_ups, MAX_PLAN_ITEMS - len(subs))
                follow = [{"findingId": f"f-{len(subs) + i + 1}", "question": q.question.strip()[:300],
                           "dataShape": q.dataShape, "round": rnd + 1} for i, q in enumerate(review.followUps[:room])]
                if not follow:
                    break
                subs = subs + follow
                self._call("data-tools", "plan_save", projectId=project_id, subQuestions=subs)
                findings += self._run_round(project_id, follow, sup, brief)
                follow_ups_total += len(follow)

            self._write_synthesis(project_id, topic, findings, requirements, review, sup)
            sup.set_phase("done")
            self._call("project-tools", "project_save", projectId=project_id, status="completed")
            return {"projectId": project_id, "findings": len(findings), "followUps": follow_ups_total,
                    "claims": sum(len(f.get("claims") or []) for f in findings), "elapsedSec": round(time.time() - started, 1)}
        except ResearchStopped:
            return self._stopped(project_id, started)
        except Exception as err:  # noqa: BLE001 - report every failure to the UI
            if self.stop.is_set:  # an error caused by the stop itself (a cancelled call) is not a failure
                return self._stopped(project_id, started)
            log.exception("research failed")
            sup.set_phase("failed", str(err)[:200])
            try:
                self._call("project-tools", "project_save", projectId=project_id, status="failed", message=str(err)[:500])
            except ResearchStopped:
                return self._stopped(project_id, started)
            raise

    def _stopped(self, project_id: str, started: float) -> dict:
        # project_stop already wrote `stopped` and told the UI; only the live view is left to settle.
        log.info("research stopped (%s) after %d findings", self.stop.reason, self.findings_written)
        for act in self.tracker.agents():
            if act.phase not in ("done", "failed", "stopped"):
                act.set_phase("stopped")
        return {"projectId": project_id, "stopped": True, "findings": self.findings_written,
                "elapsedSec": round(time.time() - started, 1)}

    def _call(self, target: str, tool: str, **arguments: Any) -> dict:
        """A tool call that honours a stop: refused before it starts, and a tool that answers
        "this project was stopped" (the user stopped it elsewhere) stops the whole run."""
        self.stop.check()
        try:
            return self.gw.call(target, tool, **arguments)
        except Exception as err:
            if getattr(err, "stopped", False):
                self.stop.stop("stopped by another client")
                raise ResearchStopped("the project was stopped") from err
            raise

    # --- watchdog-supervised LLM steps ------------------------------------------------------------
    def _supervised(self, act: AgentActivity, step: Callable[[AgentActivity], T]) -> T:
        """Run one LLM step; if the watchdog cancels it for making no progress, run it again once."""
        for attempt in range(self.settings.attempts):
            self.stop.check()
            act.begin_attempt(retries_left=self.settings.attempts - attempt - 1)
            try:
                return step(act)
            except AgentCancelled:
                if self.stop.is_set:
                    raise ResearchStopped(self.stop.reason) from None
                log.warning("%s stalled (attempt %d)", act.agent_id, attempt + 1)
            finally:
                act.end_attempt()
        raise Stalled(f"{act.agent_id} made no progress after {self.settings.attempts} attempts")

    def _run_round(self, project_id: str, subs: list[dict], sup: AgentActivity, brief: Brief) -> list[dict]:
        sup.set_phase("waiting", f"等待 {len(subs)} 個 sub-agent")
        with ThreadPoolExecutor(max_workers=self.settings.max_parallel) as pool:
            outcomes = list(pool.map(lambda s: self._research_one(project_id, s, brief), subs))
        return [o for o in outcomes if o]

    def _review(self, project_id: str, topic: str, findings: list[dict], requirements: list[dict], rnd: int,
                sup: AgentActivity) -> Optional[ReviewDraft]:
        self.stop.check()
        sup.set_phase("reviewing", f"第 {rnd} 輪")
        try:
            review = self._supervised(sup, lambda act: self.llm.review(topic, findings, requirements,
                                                                       self.settings.max_follow_ups, act))
        except ResearchStopped:
            raise
        except Exception:  # noqa: BLE001 - the report can still be written without review notes
            log.exception("review failed; continuing without it")
            return None
        if requirements and review.coverage:
            known_req = {r["id"] for r in requirements}
            known_claims = {c["claimId"] for f in findings for c in f.get("claims") or []}
            seen: set[str] = set()
            coverage = []
            for c in review.coverage:
                if c.requirementId not in known_req or c.requirementId in seen:
                    continue
                seen.add(c.requirementId)
                item: dict[str, Any] = {"id": c.requirementId, "status": c.status,
                                        "claimIds": [x for x in c.claimIds if CLAIM_ID.match(x) and x in known_claims][:12]}
                if c.note.strip():
                    item["note"] = c.note.strip()[:300]
                coverage.append(item)
            for r in requirements:  # a requirement the reviewer skipped is not covered
                if r["id"] not in seen:
                    coverage.append({"id": r["id"], "status": "missing", "claimIds": []})
            coverage.sort(key=lambda c: int(c["id"][1:]))
            try:
                self._call("data-tools", "coverage_save", projectId=project_id, round=min(rnd, 4), coverage=coverage)
            except ResearchStopped:
                raise
            except Exception:  # noqa: BLE001 - coverage is advisory
                log.exception("coverage_save failed")
        return review

    # --- writing and verification -----------------------------------------------------------------
    def _write_synthesis(self, project_id: str, topic: str, findings: list[dict], requirements: list[dict],
                         review: Optional[ReviewDraft], sup: AgentActivity) -> None:
        self.stop.check()
        sup.set_phase("reporting")
        catalog = v.build_catalog(findings)
        claims_text = v.catalog_brief(catalog) if catalog else _legacy_brief(findings)
        try:
            report = self._supervised(sup, lambda act: self.llm.report(
                topic, requirements, claims_text, review, self.settings.report_words, act, on_text=self.on_report_text))
        except ResearchStopped:
            raise
        except Exception:  # noqa: BLE001 - findings are already saved; the project still completes
            log.exception("report failed; completing without a synthesis")
            return
        verification: Optional[dict] = None
        if catalog and self.settings.verify:
            report, verification = self._verify(report, catalog, sup)
        args: dict[str, Any] = {
            "projectId": project_id, "report": report[:30_000],
            "contradictions": list(review.contradictions) if review else [],
            "gaps": list(review.gaps) if review else [],
            "followUps": [q.question for q in review.followUps] if review else [],
        }
        if catalog:
            used = {f"C{n}" for n in v.MARKER.findall(report)}
            args["citations"] = {k: val for k, val in v.citations(catalog).items() if k in used}
            if verification is not None:
                verification["claimsCited"] = len(used)
                verification["deadUrls"] = self._dead_links(catalog, used) if self.settings.check_links else []
                args["verification"] = verification
        self._call("data-tools", "synthesis_write", **args)

    def _verify(self, report: str, catalog: list[v.CatalogEntry], sup: AgentActivity) -> tuple[str, dict]:
        sup.set_phase("verifying")
        blocks = v.parse_report(report)
        known = {e.label for e in catalog}
        by_label = {e.label: e for e in catalog}
        unknown = v.strip_unknown_markers(blocks, known)
        sents = v.sentences(blocks)
        cited = [s for s in sents if s.labels]
        uncited = [s for s in sents if not s.labels and v.needs_citation(s)]
        stats: dict[str, Any] = {"citedSentences": len(cited), "supported": 0, "partial": 0, "unsupported": 0, "revised": 0,
                                 "removed": 0, "uncitedSentences": len(uncited), "unknownCitations": unknown,
                                 "precisionBefore": None, "precisionAfter": None}
        if not cited:
            return v.render(blocks), stats
        items = v.verification_items(sents, by_label)
        try:
            verdicts = self._verdicts(items, sup)
        except ResearchStopped:
            raise
        except Exception:  # noqa: BLE001 - an unverified report is still better than none
            log.exception("verification failed; keeping the report as written")
            return v.render(blocks), stats
        counts = {"supported": 0, "partial": 0, "unsupported": 0}
        for s in cited:
            counts[verdicts.get(s.id, ("supported", ""))[0]] += 1
        stats.update(counts)
        stats["precisionBefore"] = round(counts["supported"] / len(cited), 3)
        flagged = [s for s in cited if verdicts.get(s.id, ("supported", ""))[0] != "supported"]
        edits: dict[int, Optional[str]] = {}
        fixed_ok = 0
        if flagged:
            try:
                edits, fixed_ok = self._revise(flagged, verdicts, by_label, sup)
            except ResearchStopped:
                raise
            except Exception:  # noqa: BLE001
                log.exception("revision failed; deleting unsupported sentences instead")
                edits = {s.id: None for s in flagged if verdicts[s.id][0] == "unsupported"}
        revised, removed = v.apply_edits(blocks, sents, edits, known)
        stats["revised"], stats["removed"] = revised, removed
        remaining = len(cited) - removed
        stats["precisionAfter"] = round(min(1.0, (counts["supported"] + fixed_ok) / remaining), 3) if remaining else None
        return v.render(blocks), stats

    def _verdicts(self, items: list[dict], sup: AgentActivity) -> dict[int, tuple[str, str]]:
        out: dict[int, tuple[str, str]] = {}
        ids = {i["id"] for i in items}
        for start in range(0, len(items), VERIFY_BATCH):
            batch = items[start:start + VERIFY_BATCH]
            draft = self._supervised(sup, lambda act: self.llm.verify(batch, act))
            for verdict in draft.verdicts:
                if verdict.id in ids:
                    out[verdict.id] = (verdict.verdict, verdict.reason)
        return out

    def _revise(self, flagged: list[v.Sentence], verdicts: dict[int, tuple[str, str]], by_label: dict[str, v.CatalogEntry],
                sup: AgentActivity) -> tuple[dict[int, Optional[str]], int]:
        """Ask for minimal rewrites, re-check each rewrite once, delete what still fails. Returns
        (edits, rewrites that passed the re-check)."""
        items = []
        for s in flagged:
            labels = list(dict.fromkeys(s.labels))
            items.append({"id": s.id, "sentence": s.text, "reason": verdicts[s.id][1], "allowedLabels": labels,
                          "claims": [{"label": lab, "claim": by_label[lab].text, "status": by_label[lab].status,
                                      "quotes": [q["quote"] for q in by_label[lab].quotes[:2]]} for lab in labels if lab in by_label]})
        draft = self._supervised(sup, lambda act: self.llm.revise(items, act))
        allowed = {s.id: set(s.labels) for s in flagged}
        edits: dict[int, Optional[str]] = {}
        rewrites: dict[int, str] = {}
        for e in draft.edits:
            if e.id not in allowed or e.id in edits or e.id in rewrites:
                continue
            if e.action == "delete" or not e.text.strip():
                edits[e.id] = None
            else:
                text = v.MARKER.sub(lambda m: m.group(0) if f"C{m.group(1)}" in allowed[e.id] else "", e.text.strip())
                if v.MARKER.search(text):
                    rewrites[e.id] = text
                else:
                    edits[e.id] = None  # a rewrite that cites nothing cannot stay in the findings
        for s in flagged:  # no edit given: drop what was unsupported, keep what was partly supported
            if s.id not in edits and s.id not in rewrites and verdicts[s.id][0] == "unsupported":
                edits[s.id] = None
        passed = 0
        if rewrites:
            recheck = []
            for sid, text in rewrites.items():
                labels = [f"C{n}" for n in v.MARKER.findall(text)]
                recheck.append({"id": sid, "sentence": v.MARKER.sub("", text).strip(),
                                "claims": [{"label": lab, "claim": by_label[lab].text, "status": by_label[lab].status,
                                            "quotes": [q["quote"] for q in by_label[lab].quotes[:2]]} for lab in dict.fromkeys(labels)
                                           if lab in by_label]})
            results = self._verdicts(recheck, sup)
            for sid, text in rewrites.items():
                verdict = results.get(sid, ("supported", ""))[0]
                if verdict == "unsupported":
                    edits[sid] = None
                else:
                    edits[sid] = text
                    passed += verdict == "supported"
        return edits, passed

    def _dead_links(self, catalog: list[v.CatalogEntry], used: set[str]) -> list[str]:
        urls = list(dict.fromkeys(q["url"] for e in catalog if e.label in used for q in e.quotes if q.get("url")))[:20]
        if not urls:
            return []
        try:
            return list(self._call("web-tools", "url_check", urls=urls).get("dead", []))
        except ResearchStopped:
            raise
        except Exception:  # noqa: BLE001 - a link check is advisory
            log.exception("url_check failed")
            return []

    def _seed(self, parent_project_id: str) -> str:
        parent = self._call("project-tools", "project_get", projectId=parent_project_id)
        lines = [f"- {f.get('question')}: {f.get('summary')}" for f in parent.get("findings", [])]
        synthesis = parent.get("synthesis") or {}
        if synthesis.get("gaps"):
            lines += ["Open gaps from the previous report:"] + [f"- {g}" for g in synthesis["gaps"]]
        return "\n".join(lines)[:3000]

    # --- one sub-agent ----------------------------------------------------------------------------
    def _research_one(self, project_id: str, sub: dict, brief: Brief) -> Optional[dict]:
        act = self.tracker.agent(sub["findingId"], round=sub.get("round", 1))
        try:
            return self._research(project_id, sub, act, brief)
        except ResearchStopped:
            if act.phase not in ("done", "failed"):
                act.set_phase("stopped")
            raise

    def _research(self, project_id: str, sub: dict, act: AgentActivity, brief: Brief) -> Optional[dict]:
        self.stop.check()  # sub-questions still queued when the stop came never start
        act.set_phase("thinking")
        tools = self.toolkit_factory(project_id, sub["findingId"], brief).tools()
        feedback = ""
        for attempt in range(2):
            try:
                draft = self._supervised(act, lambda a: self.llm.research(sub["question"], sub["dataShape"], tools, feedback, a,
                                                                          self.settings.reads_per_agent))
            except Stalled:
                act.set_phase("failed", "停滯，已放棄")
                return None
            except Exception as err:  # noqa: BLE001 - one bad sub-agent must not stop the others
                if self.stop.is_set:  # a call cut short by the stop is not a failure
                    raise ResearchStopped(self.stop.reason) from None
                log.exception("sub-agent failed for %s", sub["findingId"])
                act.set_phase("failed", str(err)[:200])
                return None
            finding = to_finding(draft, project_id=project_id, finding_id=sub["findingId"],
                                 question=sub["question"], shape=sub["dataShape"])
            act.set_phase("writing")
            result = self._call("data-tools", "finding_write", projectId=project_id, finding=finding)
            if result.get("ok"):
                if "claims" in result:
                    finding["claims"] = result["claims"]
                    finding["sources"] = result.get("sources", finding["sources"])
                with self._count_lock:
                    self.findings_written += 1
                self._design_ui(project_id, finding, act)
                act.set_phase("done")
                return finding
            feedback = "The previous answer was rejected: " + "; ".join(result.get("errors", []))[:1200]
            log.warning("finding %s rejected (attempt %d): %s", sub["findingId"], attempt + 1, feedback)
            act.set_phase("thinking", "重新整理答案")
        act.set_phase("failed", "finding 未通過驗證")
        return None

    def _design_ui(self, project_id: str, finding: dict, act: Optional[AgentActivity] = None) -> None:
        shape = finding["dataShape"]
        if shape not in SHAPED:
            return  # list/other findings keep the generic card
        if act:
            act.set_phase("designing")
        cached = self._call("data-tools", "ui_template_get", dataShape=shape)
        if cached.get("hit") and cached.get("spec"):
            res = self._call("data-tools", "ui_spec_write", projectId=project_id, findingId=finding["findingId"],
                             spec=cached["spec"], fromCache=True)
            if res.get("ok"):
                return
        try:
            draft = self._supervised(act, lambda a: self.llm.design_ui(finding, a)) if act else self.llm.design_ui(finding)
            spec = build_spec(draft, shape)
        except Exception:  # noqa: BLE001
            log.exception("UI designer failed; using the default spec")
            spec = default_spec(shape)
        res = self._call("data-tools", "ui_spec_write", projectId=project_id, findingId=finding["findingId"], spec=spec)
        if not res.get("ok") and spec != default_spec(shape):
            self._call("data-tools", "ui_spec_write", projectId=project_id, findingId=finding["findingId"], spec=default_spec(shape))


def _legacy_brief(findings: list[dict]) -> str:
    """When no sub-agent produced verified claims, the writer falls back to finding summaries [F#]."""
    import json
    rows = [{"id": "F" + f["findingId"].split("-", 1)[1], "question": f["question"], "summary": f["summary"],
             "keyPoints": f.get("keyPoints", []), "sources": [s.get("title") or s.get("url") for s in f.get("sources", [])][:6]}
            for f in findings]
    return "NO_VERIFIED_CLAIMS " + json.dumps(rows, ensure_ascii=False)[:60_000]
