"""Research orchestration:

  plan (sub-questions + requirements; proposed for review first, or approved by the user)
      -> parallel sub-agents -> review & coverage
      -> follow-up rounds while requirements are weak or missing (depth decides how many),
         plus rounds for the user's redirections; a "finish" request wraps up early
      -> report written from verified claims [C#] -> sentence-level verification and revision
      -> link check -> synthesis -> done

Also here: an incremental re-run of a completed project (newer evidence only, claims that replace
earlier ones, report version + 1) and answers to follow-up questions about a report.

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

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, TypeVar

from . import verify as v
from . import prompts
from .models import AnswerDraft, FindingDraft, PlanDraft, ReviewDraft, ReviseDraft, UiSpecDraft, VerifyDraft
from .research_tools import Budget, ResearchToolkit, SearchOptions
from .stopping import ResearchStopped, StopSignal
from .watch import AgentActivity, AgentCancelled, Stalled, Tracker

log = logging.getLogger(__name__)

SHAPED = {"comparison", "timeline", "metrics"}
COMPONENT_FOR_SHAPE = {"comparison": "Compare", "timeline": "Timeline", "metrics": "MetricBars"}
MAX_PLAN_ITEMS = 40  # plan_save accepts up to 40 sub-questions across all rounds and versions
MAX_ROUND_ITEMS = 12  # one run plans at most this many sub-questions
MAX_ROUNDS = 10
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
                 activity: Optional[AgentActivity] = None, reads: int = 4, context: str = "") -> FindingDraft: ...
    def design_ui(self, finding: dict, activity: Optional[AgentActivity] = None) -> UiSpecDraft: ...
    def review(self, topic: str, findings: list[dict], requirements: list[dict], max_follow_ups: int = 3,
               activity: Optional[AgentActivity] = None, steering: Optional[list[str]] = None) -> ReviewDraft: ...
    def report(self, topic: str, requirements: list[dict], catalog: str, review: Optional[ReviewDraft], words: int = 800,
               activity: Optional[AgentActivity] = None, on_text: Optional[Callable[[str], None]] = None,
               steering: Optional[list[str]] = None, update: Optional[dict] = None) -> str: ...
    def answer(self, question: str, selection: str, report: str, catalog: str,
               activity: Optional[AgentActivity] = None) -> AnswerDraft: ...
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

    @classmethod
    def from_stored(cls, stored: Optional[dict], payload: Optional[dict] = None) -> "Brief":
        """The brief saved with the project, overridden by any field the request sets."""
        merged = dict(stored or {})
        for key in ("depth", "audience", "startDate", "includeDomains", "excludeDomains", "notes"):
            if payload and payload.get(key) not in (None, "", []):
                merged[key] = payload[key]
        return cls.from_payload(merged)

    def to_dict(self) -> dict:
        out: dict[str, Any] = {"depth": self.depth}
        if self.audience:
            out["audience"] = self.audience
        if self.start_date:
            out["startDate"] = self.start_date
        if self.include_domains:
            out["includeDomains"] = self.include_domains
        if self.exclude_domains:
            out["excludeDomains"] = self.exclude_domains
        if self.notes:
            out["notes"] = self.notes
        return out

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


def to_finding(draft: FindingDraft, *, project_id: str, finding_id: str, question: str, shape: str,
               known_claims: Optional[set[str]] = None) -> dict:
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
        claims = []
        for c in draft.claims[:12]:
            if len(c.text.strip()) < 5:
                continue
            claim: dict[str, Any] = {"text": c.text.strip()[:500],
                                     "evidence": [{"docId": e.docId.strip(), "quote": e.quote.strip()[:600], "stance": e.stance}
                                                  for e in c.evidence[:4]]}
            target = (getattr(c, "updates", "") or "").strip()
            if target and CLAIM_ID.match(target) and (known_claims is None or target in known_claims):
                claim["updates"] = target
            claims.append(claim)
        finding["claims"] = claims
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
                 toolkit_factory: Optional[Callable[[str, str, "Brief"], ResearchToolkit]] = None,
                 max_parallel: Optional[int] = None):
        self.gw = gateway
        self.max_parallel = max_parallel
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
        # The user's steering (project_steer), delivered by the heartbeat thread.
        self._steer_lock = threading.Lock()
        self._steers: dict[str, dict] = {}       # steerId -> steer, in arrival order
        self._given: set[str] = set()            # redirect steers already handed to a reviewer
        self._finish = threading.Event()
        # Per sub-question: extra instructions for its agent and the claim ids it may update.
        self._sub_context: dict[str, tuple[str, Optional[set[str]]]] = {}

    def _derive_settings(self, brief: "Brief") -> None:
        """Settings follow the brief's depth unless fixed by the caller (tests, operators)."""
        if self._fixed_settings is None:
            self.settings = Settings.for_depth(brief.depth)
            if self.max_parallel:
                self.settings.max_parallel = min(self.settings.max_parallel, self.max_parallel)

    # --- steering -----------------------------------------------------------------------------
    def receive_steering(self, steers: Optional[list[dict]]) -> None:
        """Called with every steer the project has (heartbeat); new ones take effect at the next step."""
        for st in steers or []:
            sid = st.get("steerId") if isinstance(st, dict) else None
            if not isinstance(sid, str):
                continue
            with self._steer_lock:
                if sid in self._steers:
                    continue
                self._steers[sid] = st
                if st.get("appliedRound") is not None:
                    self._given.add(sid)   # applied by an earlier run of this project
            if st.get("kind") == "finish" and st.get("appliedRound") is None:
                log.info("the user asked to wrap up")
                self._finish.set()

    def _take_redirects(self) -> list[dict]:
        with self._steer_lock:
            fresh = [st for sid, st in self._steers.items() if st.get("kind") == "redirect" and sid not in self._given]
            self._given.update(st["steerId"] for st in fresh)
            return fresh

    def _has_new_redirects(self) -> bool:
        with self._steer_lock:
            return any(st.get("kind") == "redirect" and sid not in self._given for sid, st in self._steers.items())

    def _redirect_texts(self) -> list[str]:
        with self._steer_lock:
            return [st.get("text", "") for st in self._steers.values() if st.get("kind") == "redirect" and st.get("text")]

    @property
    def finishing(self) -> bool:
        return self._finish.is_set()

    def _toolkit(self, project_id: str, finding_id: str, brief: Brief) -> ResearchToolkit:
        options = SearchOptions(start_date=brief.start_date, include_domains=brief.include_domains,
                                exclude_domains=brief.exclude_domains, secondary=self.secondary_search)
        return ResearchToolkit(self.gw, project_id, options,
                               Budget(searches=self.settings.searches_per_agent, reads=self.settings.reads_per_agent),
                               on_stop_check=self.stop.check)

    # --- plan review ------------------------------------------------------------------------------
    def propose(self, *, project_id: str, topic: str, parent_project_id: Optional[str], brief: Optional[Brief] = None) -> dict:
        """Draft a plan for the user to review: the project is created as a draft and nothing is researched."""
        brief = brief or Brief()
        self._derive_settings(brief)
        sup = self.tracker.agent("supervisor")
        self._call("project-tools", "project_save", projectId=project_id, status="draft", topic=topic,
                   parentProjectId=parent_project_id, brief=brief.to_dict())
        try:
            subs, requirements = self._plan(topic, parent_project_id, brief, sup)
            self._call("data-tools", "plan_propose", projectId=project_id, by="agent", brief=brief.to_dict(),
                       subQuestions=[{k: q[k] for k in ("findingId", "question", "dataShape")} for q in subs], requirements=requirements)
            sup.set_phase("done")
            return {"projectId": project_id, "proposed": len(subs)}
        except Exception as err:  # noqa: BLE001 - the user sees why and can try again
            log.exception("planning failed")
            sup.set_phase("failed", str(err)[:200])
            self.tracker.emit("plan.failed", {"message": str(err)[:300] or "planning failed"})
            raise

    def _plan(self, topic: str, parent_project_id: Optional[str], brief: Brief, sup: AgentActivity) -> tuple[list[dict], list[dict]]:
        seed = self._seed(parent_project_id) if parent_project_id else ""
        sup.set_phase("planning")
        plan = self._supervised(sup, lambda act: self.llm.plan(
            topic, seed, brief.describe(), self.settings.min_subquestions, self.settings.max_subquestions, act))
        subs = [{"findingId": f"f-{i + 1}", "question": q.question.strip()[:300], "dataShape": q.dataShape, "round": 1}
                for i, q in enumerate(plan.subQuestions[: self.settings.max_subquestions])]
        requirements = [{"id": f"q{i + 1}", "text": r.strip()[:300]}
                        for i, r in enumerate([r for r in plan.requirements if len(r.strip()) >= 3][:10])]
        return subs, requirements

    @staticmethod
    def approved_plan(raw: Any) -> Optional[tuple[list[dict], list[dict]]]:
        """The plan the user approved, as sent with `start`: {subQuestions: [{question, dataShape}],
        requirements: [text]}. None when it is missing or has no usable sub-question."""
        if not isinstance(raw, dict) or not isinstance(raw.get("subQuestions"), list):
            return None
        subs = []
        for q in raw["subQuestions"][:MAX_ROUND_ITEMS]:
            text = q.get("question") if isinstance(q, dict) else None
            if not (isinstance(text, str) and len(text.strip()) >= 3):
                continue
            shape = q.get("dataShape") if q.get("dataShape") in ("comparison", "timeline", "metrics", "list", "other") else "list"
            subs.append({"findingId": f"f-{len(subs) + 1}", "question": text.strip()[:300], "dataShape": shape, "round": 1})
        reqs = []
        for r in raw.get("requirements") or []:
            text = r.get("text") if isinstance(r, dict) else r
            if isinstance(text, str) and len(text.strip()) >= 3 and len(reqs) < 12:
                reqs.append({"id": f"q{len(reqs) + 1}", "text": text.strip()[:300]})
        return (subs, reqs) if subs else None

    # --- a full run -------------------------------------------------------------------------------
    def run(self, *, project_id: str, topic: str, parent_project_id: Optional[str], session_id: str,
            brief: Optional[Brief] = None, plan: Optional[tuple[list[dict], list[dict]]] = None) -> dict:
        started = time.time()
        brief = brief or Brief()
        self._derive_settings(brief)
        sup = self.tracker.agent("supervisor")
        res = self._call("project-tools", "project_save", projectId=project_id, status="running", topic=topic,
                         parentProjectId=parent_project_id, runtimeSessionId=session_id, brief=brief.to_dict())
        self.receive_steering(res.get("steering"))
        try:
            subs, requirements = plan if plan else self._plan(topic, parent_project_id, brief, sup)
            plan_args: dict[str, Any] = {"projectId": project_id, "subQuestions": subs}
            if requirements:
                plan_args["requirements"] = requirements
            self._call("data-tools", "plan_save", **plan_args)

            findings = self._run_round(project_id, subs, sup, brief)
            if not findings:
                raise RuntimeError("No sub-question produced a valid finding")
            subs, findings, review, follow_ups_total = self._rounds(project_id, topic, subs, findings, requirements, brief, sup,
                                                                   self.settings.follow_up_rounds)
            self._write_synthesis(project_id, topic, findings, requirements, review, sup)
            sup.set_phase("done")
            self._call("project-tools", "project_save", projectId=project_id, status="completed")
            return {"projectId": project_id, "findings": len(findings), "followUps": follow_ups_total,
                    "claims": sum(len(f.get("claims") or []) for f in findings), "elapsedSec": round(time.time() - started, 1)}
        except ResearchStopped:
            return self._stopped(project_id, started)
        except Exception as err:  # noqa: BLE001 - report every failure to the UI
            return self._failed(project_id, started, sup, err)

    def _failed(self, project_id: str, started: float, sup: AgentActivity, err: Exception) -> dict:
        if self.stop.is_set:  # an error caused by the stop itself (a cancelled call) is not a failure
            return self._stopped(project_id, started)
        log.exception("research failed")
        sup.set_phase("failed", str(err)[:200])
        try:
            self._call("project-tools", "project_save", projectId=project_id, status="failed", message=str(err)[:500])
        except ResearchStopped:
            return self._stopped(project_id, started)
        raise err

    def _rounds(self, project_id: str, topic: str, subs: list[dict], findings: list[dict], requirements: list[dict],
                brief: Brief, sup: AgentActivity, rounds: int, first_round: int = 1,
                version: Optional[int] = None) -> tuple[list[dict], list[dict], Optional[ReviewDraft], int]:
        """Review after each round; plan follow-ups while the depth allows, and an extra round for
        each redirection the user sends. A finish request ends it after one last review."""
        review: Optional[ReviewDraft] = None
        follow_ups_total = 0
        rnd = first_round
        planned_rounds = 0
        while True:
            redirects = [] if self.finishing else self._take_redirects()
            texts = [st.get("text", "") for st in redirects]
            review = self._review(project_id, topic, findings, requirements, rnd, sup, steering=texts) or review
            wants_more = planned_rounds < rounds or bool(redirects)
            if review is None or self.finishing or not wants_more or rnd >= MAX_ROUNDS:
                if redirects:  # considered by this review and the report, without a new round
                    self._call("data-tools", "plan_save", projectId=project_id, subQuestions=subs, steerIds=[st["steerId"] for st in redirects])
                if review is not None and self._has_new_redirects() and not self.finishing and rnd < MAX_ROUNDS:
                    rnd += 1
                    continue
                break
            limit = max(self.settings.max_follow_ups, 2) if redirects else self.settings.max_follow_ups
            room = min(limit, MAX_PLAN_ITEMS - len(subs))
            follow = []
            for q in review.followUps[:max(0, room)]:
                fid = f"f-{len(subs) + len(follow) + 1}"
                item: dict[str, Any] = {"findingId": fid, "question": q.question.strip()[:300], "dataShape": q.dataShape, "round": rnd + 1}
                if version:
                    item["version"] = version
                if texts:
                    self._sub_context[fid] = (prompts.RESEARCHER_DIRECTION.format(direction="\n".join(f"- {t}" for t in texts)), None)
                follow.append(item)
            if not follow:
                if redirects:
                    self._call("data-tools", "plan_save", projectId=project_id, subQuestions=subs, steerIds=[st["steerId"] for st in redirects])
                if self._has_new_redirects() and not self.finishing and rnd < MAX_ROUNDS:
                    rnd += 1
                    continue
                break
            subs = subs + follow
            args: dict[str, Any] = {"projectId": project_id, "subQuestions": subs}
            if redirects:
                args["steerIds"] = [st["steerId"] for st in redirects]
            self._call("data-tools", "plan_save", **args)
            findings += self._run_round(project_id, follow, sup, brief)
            follow_ups_total += len(follow)
            planned_rounds += 0 if redirects and planned_rounds >= rounds else 1
            rnd += 1
        return subs, findings, review, follow_ups_total

    # --- an incremental run -----------------------------------------------------------------------
    def run_incremental(self, *, project_id: str, topic: str, session_id: str, overrides: Optional[dict] = None,
                        extra_questions: Optional[list[str]] = None) -> dict:
        """Re-run a completed project for newer evidence. Every earlier sub-question is researched again
        from `since` with the claims already known; new claims may replace (update) earlier ones; the
        report is rewritten as the next version."""
        started = time.time()
        sup = self.tracker.agent("supervisor")
        res = self._call("project-tools", "project_save", projectId=project_id, status="running", reopen=True,
                         runtimeSessionId=session_id)
        project = res.get("project") or {}
        self.receive_steering(res.get("steering"))
        version, since = int(project.get("version") or 2), project.get("since")
        try:
            current = self._call("project-tools", "project_get", projectId=project_id)
            brief = Brief.from_stored((current.get("project") or {}).get("brief"), overrides)
            self._derive_settings(brief)
            if since and (not brief.start_date or brief.start_date < since):
                brief.start_date = since
            plan = list(current.get("plan") or [])
            requirements = list(current.get("requirements") or [])
            findings = [f for f in current.get("findings") or [] if isinstance(f, dict)]
            by_id = {f["findingId"]: f for f in findings}
            sup.set_phase("planning", f"第 {version} 版：只找 {since} 之後的資料")
            # One lineage per original sub-question: its latest finding carries the claims to update.
            lineage: dict[str, list[str]] = {}
            root_of: dict[str, str] = {}
            for q in plan:
                root = root_of.get(q.get("updates") or "", q["findingId"]) if q.get("updates") else q["findingId"]
                root_of[q["findingId"]] = root
                lineage.setdefault(root, []).append(q["findingId"])
            questions = {q["findingId"]: q for q in plan}
            new_subs: list[dict] = []
            for root, members in lineage.items():
                if len(plan) + len(new_subs) >= MAX_PLAN_ITEMS:
                    break
                known = [c for fid in members for c in (by_id.get(fid) or {}).get("claims") or [] if c.get("status") != "superseded"]
                fid = f"f-{len(plan) + len(new_subs) + 1}"
                base = questions[root]
                new_subs.append({"findingId": fid, "question": base["question"], "dataShape": base.get("dataShape", "list"),
                                 "round": 1, "version": version, "updates": members[-1]})
                listing = "\n".join(f"- {c['claimId']} ({c.get('status')}): {c.get('text')}" for c in known[:40]) or "- (none)"
                self._sub_context[fid] = (prompts.RESEARCHER_UPDATE.format(since=since or "the previous run", known=listing),
                                          {c["claimId"] for c in known})
            for text in (extra_questions or [])[:3]:
                if len(plan) + len(new_subs) >= MAX_PLAN_ITEMS or not (isinstance(text, str) and len(text.strip()) >= 3):
                    continue
                new_subs.append({"findingId": f"f-{len(plan) + len(new_subs) + 1}", "question": text.strip()[:300],
                                 "dataShape": "list", "round": 1, "version": version})
            if not new_subs:
                raise RuntimeError("Nothing to re-run: the project has no sub-questions")
            subs = plan + new_subs
            self._call("data-tools", "plan_save", projectId=project_id, subQuestions=subs)
            fresh = self._run_round(project_id, new_subs, sup, brief)
            # Claims replaced by this run are now superseded; read the project back for the current state.
            current = self._call("project-tools", "project_get", projectId=project_id)
            findings = [f for f in current.get("findings") or [] if isinstance(f, dict)]
            subs, findings, review, follow_ups = self._rounds(project_id, topic, subs, findings, requirements, brief, sup, 0,
                                                              first_round=1, version=version)
            fresh_ids = {f["findingId"] for f in fresh} | {q["findingId"] for q in subs if q.get("version") == version}
            new_claims = [c for f in findings if f["findingId"] in fresh_ids for c in f.get("claims") or []]
            changes = {"newClaims": sum(1 for c in new_claims if not c.get("updates")),
                       "updatedClaims": sum(1 for c in new_claims if c.get("updates"))}
            self._write_synthesis(project_id, topic, findings, requirements, review, sup,
                                  update={"version": version, "since": since, "fresh": fresh_ids, "changes": changes})
            sup.set_phase("done")
            self._call("project-tools", "project_save", projectId=project_id, status="completed")
            return {"projectId": project_id, "version": version, "findings": len(fresh), "followUps": follow_ups,
                    **changes, "elapsedSec": round(time.time() - started, 1)}
        except ResearchStopped:
            return self._stopped(project_id, started)
        except Exception as err:  # noqa: BLE001
            return self._failed(project_id, started, sup, err)

    # --- follow-up questions about the report -----------------------------------------------------
    def answer(self, *, project_id: str, qa_id: str, question: str, selection: str = "") -> dict:
        act = self.tracker.agent("answer")
        try:
            current = self._call("project-tools", "project_get", projectId=project_id)
            synthesis = current.get("synthesis") or {}
            catalog, cites = qa_catalog(current.get("findings") or [], synthesis.get("citations") or {})
            if not catalog:
                raise RuntimeError("This project has no verified claims to answer from")
            act.set_phase("thinking")
            draft = self._supervised(act, lambda a: self.llm.answer(question, selection, synthesis.get("report", ""),
                                                                     json.dumps(catalog, ensure_ascii=False)[:60_000], a))
            text = v.MARKER.sub(lambda m: m.group(0) if f"C{m.group(1)}" in cites else "", draft.answer).strip()
            used = {f"C{n}" for n in v.MARKER.findall(text)}
            args: dict[str, Any] = {"projectId": project_id, "qaId": qa_id, "question": question, "answer": text or "（沒有可以引用的主張）",
                                    "citations": {k: val for k, val in cites.items() if k in used},
                                    "needsResearch": bool(draft.needsResearch)}
            if selection:
                args["selection"] = selection[:2000]
            if draft.needsResearch and draft.researchQuestion.strip():
                args["researchQuestion"] = draft.researchQuestion.strip()[:300]
            self._call("data-tools", "qa_write", **args)
            act.set_phase("done")
            return {"projectId": project_id, "qaId": qa_id, "cited": len(used)}
        except Exception as err:  # noqa: BLE001 - the user sees why
            log.exception("answer failed")
            act.set_phase("failed", str(err)[:200])
            self.tracker.emit("qa.failed", {"qaId": qa_id, "message": str(err)[:300] or "answer failed"})
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
                sup: AgentActivity, steering: Optional[list[str]] = None) -> Optional[ReviewDraft]:
        self.stop.check()
        sup.set_phase("reviewing", f"第 {rnd} 輪" + ("，套用你的新方向" if steering else ""))
        current = [{**f, "claims": [c for c in f.get("claims") or [] if c.get("status") != "superseded"]} for f in findings]
        follow_ups = max(self.settings.max_follow_ups, 2) if steering else self.settings.max_follow_ups
        try:
            if steering:
                review = self._supervised(sup, lambda act: self.llm.review(topic, current, requirements, follow_ups, act,
                                                                           steering=steering))
            else:
                review = self._supervised(sup, lambda act: self.llm.review(topic, current, requirements, follow_ups, act))
        except ResearchStopped:
            raise
        except Exception:  # noqa: BLE001 - the report can still be written without review notes
            log.exception("review failed; continuing without it")
            return None
        if requirements and review.coverage:
            known_req = {r["id"] for r in requirements}
            known_claims = {c["claimId"] for f in current for c in f.get("claims") or []}
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
                self._call("data-tools", "coverage_save", projectId=project_id, round=min(rnd, MAX_ROUNDS), coverage=coverage)
            except ResearchStopped:
                raise
            except Exception:  # noqa: BLE001 - coverage is advisory
                log.exception("coverage_save failed")
        return review

    # --- writing and verification -----------------------------------------------------------------
    def _write_synthesis(self, project_id: str, topic: str, findings: list[dict], requirements: list[dict],
                         review: Optional[ReviewDraft], sup: AgentActivity, update: Optional[dict] = None) -> None:
        self.stop.check()
        sup.set_phase("reporting")
        catalog = v.build_catalog(findings)
        if catalog and update:
            fresh = update.get("fresh") or set()
            claims_text = v.catalog_brief(catalog, marks={e.label: {"new": True, **({"updated": True} if e.updates else {})}
                                                          for e in catalog if e.finding_id in fresh})
        else:
            claims_text = v.catalog_brief(catalog) if catalog else _legacy_brief(findings)
        extra: dict[str, Any] = {}
        steering = self._redirect_texts()
        if steering:
            extra["steering"] = steering
        if update:
            extra["update"] = {"version": update.get("version"), "since": update.get("since")}
        try:
            report = self._supervised(sup, lambda act: self.llm.report(
                topic, requirements, claims_text, review, self.settings.report_words, act, on_text=self.on_report_text, **extra))
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
        if update and update.get("changes"):
            args["changes"] = update["changes"]
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
        if self.finishing:  # the user asked to wrap up: queued sub-questions are skipped
            act.set_phase("done", "提早收尾，未研究")
            return None
        act.set_phase("thinking")
        tools = self.toolkit_factory(project_id, sub["findingId"], brief).tools()
        context, known = self._sub_context.get(sub["findingId"], ("", None))
        feedback = ""
        for attempt in range(2):
            try:
                if context:
                    draft = self._supervised(act, lambda a: self.llm.research(sub["question"], sub["dataShape"], tools, feedback, a,
                                                                              self.settings.reads_per_agent, context=context))
                else:
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
                                 question=sub["question"], shape=sub["dataShape"], known_claims=known or set())
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


def qa_catalog(findings: list[dict], citations: dict) -> tuple[list[dict], dict[str, dict]]:
    """Claims for answering a follow-up question. Claims the report cites keep the report's labels, so
    an answer's [C3] means the same claim as the report's [C3]; the other current claims follow."""
    claims = {c["claimId"]: (f["findingId"], c) for f in findings for c in f.get("claims") or [] if c.get("status") != "superseded"}
    labels: dict[str, dict] = {}
    used = set()
    for label, ref in sorted(citations.items(), key=lambda kv: int(kv[0][1:]) if kv[0][1:].isdigit() else 0):
        cid = ref.get("claimId") if isinstance(ref, dict) else None
        if cid in claims and v.LABEL.match(label):
            labels[label] = {"claimId": cid, "findingId": claims[cid][0]}
            used.add(cid)
    n = max([int(k[1:]) for k in labels] or [0])
    for cid, (fid, _c) in claims.items():
        if cid not in used and n < 300:
            n += 1
            labels[f"C{n}"] = {"claimId": cid, "findingId": fid}
    rows = []
    for label, ref in sorted(labels.items(), key=lambda kv: int(kv[0][1:])):
        c = claims[ref["claimId"]][1]
        rows.append({"label": label, "status": c.get("status"), "independentSources": c.get("independentSources", 0), "claim": c.get("text"),
                     "quotes": [e.get("quote", "")[:200] for e in c.get("evidence", [])][:2]})
    return rows, labels


def _legacy_brief(findings: list[dict]) -> str:
    """When no sub-agent produced verified claims, the writer falls back to finding summaries [F#]."""
    import json
    rows = [{"id": "F" + f["findingId"].split("-", 1)[1], "question": f["question"], "summary": f["summary"],
             "keyPoints": f.get("keyPoints", []), "sources": [s.get("title") or s.get("url") for s in f.get("sources", [])][:6]}
            for f in findings]
    return "NO_VERIFIED_CLAIMS " + json.dumps(rows, ensure_ascii=False)[:60_000]
