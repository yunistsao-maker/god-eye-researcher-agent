"""The v2 workflow end to end, real tool Lambdas (moto) and a scripted LLM: a proposed plan the user
edits and approves, steering a running project (redirect and finish), an incremental re-run whose
claims supersede earlier ones, and follow-up questions answered from the claims."""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent.models import (  # noqa: E402
    AnswerDraft, ClaimDraft, CoverageDraft, EntityDraft, EvidenceDraft, FindingDraft, PlanDraft, ReviewDraft, SubQuestionDraft,
)
from research_agent.orchestrator import Brief, Orchestrator, Settings, qa_catalog  # noqa: E402
from research_agent.watch import Tracker  # noqa: E402

from test_agent_evidence import COPY, GOV, NEWS, PAGES, USER, FakeGateway, doc_of, wired  # noqa: E402,F401

PID = "p-20261024-0e0f0a0b"
NEW_PAGE = "https://www.stat.example.gov.tw/ai-survey-2026"
NEW_TEXT = ("2026 年追蹤調查顯示，導入 AI 視覺檢測的廠商中，已有六成汰換部分 AOI 設備改用全 AI 檢測站。" * 8)


class WorkflowLlm:
    """Plans two sub-questions, researches them from the evidence pages, reviews, reports and answers."""

    def __init__(self):
        self.plans = 0
        self.reviews = []
        self.reports = []
        self.research_calls = []
        self.answers = []
        self.on_research = None   # hook: called with the question before researching

    def plan(self, topic, seed, brief="", min_subs=3, max_subs=5, activity=None):
        self.plans += 1
        return PlanDraft(subQuestions=[SubQuestionDraft(question="導入現況？", dataShape="list"),
                                       SubQuestionDraft(question="投資回收期？", dataShape="list")],
                         requirements=["導入現況", "成本與回收期"])

    def research(self, question, shape, tools, feedback="", activity=None, reads=4, context=""):
        self.research_calls.append((question, context))
        if self.on_research:
            self.on_research(question)
        web_search, read_page = tools
        if "known claims" in context.lower() or "Known claims" in context:
            new = doc_of(read_page(url=NEW_PAGE))
            old_id = re.search(r"(c-[a-z0-9-]+) \(asserted\): 多數廠商保留", context) or re.search(r"(c-[a-z0-9-]+) \([a-z]+\): 多數廠商保留", context)
            claims = [ClaimDraft(text="六成廠商已汰換部分 AOI 設備", evidence=[EvidenceDraft(docId=new, quote="已有六成汰換部分 AOI 設備")],
                                 updates=old_id.group(1) if old_id else "")] if "導入現況" in question else []
            return FindingDraft(summary="2026 年的新資料改變了導入形態的說法。" if claims else "沒有找到更新的資料，維持既有結論。",
                                keyPoints=[], claims=claims, entities=[], confidence=0.6)
        gov = doc_of(read_page(url=GOV))
        news = doc_of(read_page(url=NEWS))
        if "回收" in question:
            claims = [ClaimDraft(text="調查顯示回收期比設備商說的長", evidence=[
                EvidenceDraft(docId=news, quote="Surveys report payback periods longer than vendors suggest")])]
        else:
            claims = [ClaimDraft(text="多數廠商保留 AOI 設備並加上 AI 複判", evidence=[
                EvidenceDraft(docId=gov, quote="導入 AI 視覺檢測的廠商多半保留既有 AOI 設備"),
                EvidenceDraft(docId=news, quote="keep their AOI machines and add AI re-inspection on top")])]
        return FindingDraft(summary="一段足夠長的摘要，說明這個子題的答案。", keyPoints=["重點"], claims=claims,
                            entities=[EntityDraft(name="AOI", type="tech")], confidence=0.7)

    def design_ui(self, finding, activity=None):
        raise AssertionError("list findings get no sub-UI")

    def review(self, topic, findings, requirements, max_follow_ups=3, activity=None, steering=None):
        self.reviews.append({"steering": steering, "max": max_follow_ups,
                             "claims": [c["claimId"] for f in findings for c in f.get("claims") or []]})
        follow = [SubQuestionDraft(question="半導體封測廠的導入？", dataShape="list")] if steering else []
        ids = [c["claimId"] for f in findings for c in f.get("claims") or []]
        return ReviewDraft(coverage=[CoverageDraft(requirementId="q1", status="covered", claimIds=ids[:1])], followUps=follow)

    def report(self, topic, requirements, catalog, review, words=800, activity=None, on_text=None, steering=None, update=None, brief=""):
        rows = json.loads(catalog)
        self.reports.append({"steering": steering, "update": update, "rows": rows})
        text = "## 摘要\n\n" + "".join(f"{r['claim']} [{r['label']}]。" for r in rows) + "\n\n## 尚待研究\n\n- 還有待確認的部分需要後續研究。"
        if on_text:
            on_text(text)
        return text

    def verify(self, items, activity=None):
        from research_agent.models import SentenceVerdict, VerifyDraft
        return VerifyDraft(verdicts=[SentenceVerdict(id=i["id"], verdict="supported") for i in items])

    def revise(self, items, activity=None):
        raise AssertionError("everything is supported")

    def answer(self, question, selection, report, catalog, activity=None):
        rows = json.loads(catalog)
        self.answers.append({"question": question, "selection": selection, "rows": rows})
        if "日本" in question:
            return AnswerDraft(answer="目前的主張沒有日本的資料 [C99]。", needsResearch=True, researchQuestion="日本廠商導入 AI 視覺檢測的現況")
        return AnswerDraft(answer=f"{rows[0]['claim']} [{rows[0]['label']}]。")


def tool(m, target, name, **args):
    mod = {"project-tools": "project_tools", "data-tools": "data_tools"}[target]
    return m[mod].handler({**args, "_caller": USER, "__tool": f"{target}___{name}"}, None)


def get(m):
    return tool(m, "project-tools", "project_get", projectId=PID)


def tracker_for(published):
    return Tracker(lambda t, d: published.append({"type": t, "projectId": PID, "ts": "2026-10-24T08:00:00.000Z", "data": d}))


def quick():
    return Settings(max_parallel=1, follow_up_rounds=0, max_follow_ups=0, check_links=False)


# --- plan review ------------------------------------------------------------------------------------

def test_proposed_plan_is_edited_and_approved(wired):
    m, published = wired["mods"], wired["published"]
    llm = WorkflowLlm()
    brief = Brief(depth="quick", audience="廠長")
    out = Orchestrator(FakeGateway(m), llm, tracker=tracker_for(published)).propose(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, brief=brief)
    assert out["proposed"] == 2
    got = get(m)
    assert got["project"]["status"] == "draft" and got["project"]["brief"] == {"depth": "quick", "audience": "廠長"}
    assert [q["question"] for q in got["proposedPlan"]["subQuestions"]] == ["導入現況？", "投資回收期？"]
    assert [e["type"] for e in published if e["type"] in ("project.created", "plan.proposed")] == ["project.created", "plan.proposed"]

    approved = Orchestrator.approved_plan({"subQuestions": [{"question": "投資回收期？", "dataShape": "bogus"}, {"question": "x"}],
                                           "requirements": ["成本與回收期", {"text": "法規要求"}, "ab"]})
    assert approved == ([{"findingId": "f-1", "question": "投資回收期？", "dataShape": "list", "round": 1}],
                        [{"id": "q1", "text": "成本與回收期"}, {"id": "q2", "text": "法規要求"}])
    assert Orchestrator.approved_plan({"subQuestions": []}) is None and Orchestrator.approved_plan(None) is None

    result = Orchestrator(FakeGateway(m), llm, quick(), tracker=tracker_for(published)).run(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=brief, plan=approved)
    assert result["findings"] == 1 and llm.plans == 1          # the approved plan was not re-planned
    got = get(m)
    assert got["project"]["status"] == "completed" and [q["question"] for q in got["plan"]] == ["投資回收期？"]
    assert [r["text"] for r in got["requirements"]] == ["成本與回收期", "法規要求"]
    started = [e for e in published if e["type"] == "project.started"]
    assert started[-1]["data"] == {"version": 1, "mode": "full", "since": None}


def test_a_failed_plan_is_reported(wired):
    m, published = wired["mods"], wired["published"]

    class Broken(WorkflowLlm):
        def plan(self, *a, **k):
            raise RuntimeError("model unavailable")

    with pytest.raises(RuntimeError):
        Orchestrator(FakeGateway(m), Broken(), quick(), tracker=tracker_for(published)).propose(
            project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None)
    assert published[-1]["type"] == "plan.failed" and "model unavailable" in published[-1]["data"]["message"]
    assert get(m)["project"]["status"] == "draft"


# --- steering ---------------------------------------------------------------------------------------

def test_a_redirect_adds_a_round_and_reaches_the_report(wired):
    m, published = wired["mods"], wired["published"]
    llm = WorkflowLlm()
    orch = Orchestrator(FakeGateway(m), llm, quick(), tracker=tracker_for(published))

    def steer_once(question):
        if question == "導入現況？" and not any(e["type"] == "steer.received" for e in published):
            tool(m, "project-tools", "project_steer", projectId=PID, kind="redirect", text="多看半導體封測")
            beat = tool(m, "project-tools", "project_save", projectId=PID, status="running")  # what the heartbeat does
            orch.receive_steering(beat["steering"])

    llm.on_research = steer_once
    orch.run(project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=Brief(depth="quick"))
    # follow_up_rounds is 0, yet the redirect earned one round with its own follow-up question.
    assert [r["steering"] for r in llm.reviews] == [["多看半導體封測"], None]
    assert llm.reviews[0]["max"] == 2
    got = get(m)
    assert [q["question"] for q in got["plan"]][-1] == "半導體封測廠的導入？" and got["plan"][-1]["round"] == 2
    steer_id = got["steering"][0]["steerId"]
    assert got["steering"][0]["appliedRound"] == 2
    plans = [e for e in published if e["type"] == "plan.ready"]
    assert plans[-1]["data"]["steerIds"] == [steer_id]
    assert "多看半導體封測" in next(c for q, c in llm.research_calls if q == "半導體封測廠的導入？")
    assert llm.reports[-1]["steering"] == ["多看半導體封測"]


def test_finish_skips_queued_questions_and_writes_the_report(wired):
    m, published = wired["mods"], wired["published"]
    llm = WorkflowLlm()
    orch = Orchestrator(FakeGateway(m), llm, Settings(max_parallel=1, follow_up_rounds=2, max_follow_ups=3, check_links=False),
                        tracker=tracker_for(published))

    def finish(question):
        if question == "導入現況？":
            tool(m, "project-tools", "project_steer", projectId=PID, kind="finish")
            orch.receive_steering(tool(m, "project-tools", "project_save", projectId=PID, status="running")["steering"])

    llm.on_research = finish
    result = orch.run(project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=Brief())
    assert result["findings"] == 1 and [q for q, _ in llm.research_calls] == ["導入現況？"]
    assert len(llm.reviews) == 1 and len(llm.reports) == 1   # one last review for coverage, no follow-up rounds
    skipped = [e["data"] for e in published if e["type"] == "agent.activity" and e["data"]["agentId"] == "f-2"]
    assert skipped[-1]["phase"] == "done" and "提早收尾" in skipped[-1]["detail"]
    assert get(m)["project"]["status"] == "completed"


# --- incremental ------------------------------------------------------------------------------------

def test_incremental_run_supersedes_claims_and_writes_version_two(wired, monkeypatch):
    m, published = wired["mods"], wired["published"]
    llm = WorkflowLlm()
    Orchestrator(FakeGateway(m), llm, quick(), tracker=tracker_for(published)).run(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=Brief(depth="quick"))
    v1 = get(m)
    old = next(c for f in v1["findings"] for c in f["claims"] if c["text"].startswith("多數廠商保留"))

    monkeypatch.setitem(PAGES, NEW_PAGE, {"title": "2026 追蹤調查", "publishedDate": "2026-09-01", "text": NEW_TEXT})
    published.clear()
    result = Orchestrator(FakeGateway(m), llm, tracker=tracker_for(published)).run_incremental(
        project_id=PID, topic="AI 視覺檢測導入", session_id="t" * 40, extra_questions=["日本廠商的導入現況？"])
    # the extra question adds one claim; the update agent of 導入現況 replaces one
    assert result["version"] == 2 and result["newClaims"] == 1 and result["updatedClaims"] == 1

    # Each earlier sub-question was researched again with its known claims; the extra question too.
    contexts = {q: c for q, c in llm.research_calls[-3:]}
    assert old["claimId"] in contexts["導入現況？"] and "published on or after" in contexts["導入現況？"]
    assert contexts["日本廠商的導入現況？"] == ""

    got = get(m)
    assert got["project"]["version"] == 2 and got["project"]["status"] == "completed"
    plan = got["plan"]
    assert [(q["version"], q.get("updates")) for q in plan[2:]] == [(2, "f-1"), (2, "f-2"), (2, None)]
    claims = {c["claimId"]: c for f in got["findings"] for c in f.get("claims") or []}
    assert claims[old["claimId"]]["status"] == "superseded"
    newer = claims[claims[old["claimId"]]["supersededBy"]]
    assert newer["updates"] == old["claimId"] and newer["text"] == "六成廠商已汰換部分 AOI 設備"
    assert any(e["type"] == "claims.updated" for e in published)
    assert [e["data"]["mode"] for e in published if e["type"] == "project.started"] == ["incremental"]

    report = llm.reports[-1]
    assert report["update"]["version"] == 2 and report["update"]["since"] == v1["project"]["completedAt"][:10]
    assert old["claimId"] not in {r.get("claim") for r in report["rows"]}
    assert [r for r in report["rows"] if r.get("updated")] and all(r.get("new") for r in report["rows"] if r.get("updated"))
    assert got["synthesis"]["version"] == 2 and got["synthesis"]["changes"] == {"newClaims": 1, "updatedClaims": 1}
    assert [h["version"] for h in got["history"]] == [1]
    assert llm.reviews[-1]["claims"] and old["claimId"] not in llm.reviews[-1]["claims"]   # the reviewer sees current claims


# --- follow-up questions ----------------------------------------------------------------------------

def test_answers_cite_the_report_labels_and_flag_missing_research(wired):
    m, published = wired["mods"], wired["published"]
    llm = WorkflowLlm()
    Orchestrator(FakeGateway(m), llm, quick(), tracker=tracker_for(published)).run(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=Brief(depth="quick"))
    synthesis = get(m)["synthesis"]
    orch = Orchestrator(FakeGateway(m), llm, tracker=tracker_for(published))
    orch.answer(project_id=PID, qa_id="qa-0001", question="回收期怎麼說？", selection="投資回收期")
    rows = llm.answers[-1]["rows"]
    assert {r["label"]: r for r in rows}["C1"]["claim"] == next(
        c["text"] for f in get(m)["findings"] for c in f["claims"] if c["claimId"] == synthesis["citations"]["C1"]["claimId"])
    orch.answer(project_id=PID, qa_id="qa-0002", question="日本的情況呢？")
    qa = get(m)["qa"]
    assert [q["qaId"] for q in qa] == ["qa-0001", "qa-0002"]
    assert qa[0]["citations"] == {"C1": synthesis["citations"]["C1"]} and qa[0]["selection"] == "投資回收期"
    assert qa[1]["needsResearch"] and qa[1]["researchQuestion"] == "日本廠商導入 AI 視覺檢測的現況"
    assert "[C99]" not in qa[1]["answer"] and qa[1]["citations"] == {}
    assert [e["type"] for e in published].count("qa.ready") == 2

    class Broken(WorkflowLlm):
        def answer(self, *a, **k):
            raise RuntimeError("no model")

    with pytest.raises(RuntimeError):
        Orchestrator(FakeGateway(m), Broken(), tracker=tracker_for(published)).answer(project_id=PID, qa_id="qa-0003", question="再問一次")
    assert published[-1] == {**published[-1], "type": "qa.failed", "data": {"qaId": "qa-0003", "message": "no model"}}


def test_qa_catalog_keeps_report_labels_and_skips_superseded():
    findings = [{"findingId": "f-1", "claims": [
        {"claimId": "c-1-1", "text": "甲", "status": "asserted", "evidence": [{"quote": "q1"}]},
        {"claimId": "c-1-2", "text": "乙", "status": "superseded", "evidence": []},
        {"claimId": "c-1-3", "text": "丙", "status": "corroborated", "evidence": []}]}]
    rows, labels = qa_catalog(findings, {"C2": {"claimId": "c-1-3", "findingId": "f-1"}, "C5": {"claimId": "c-1-2", "findingId": "f-1"}})
    assert labels == {"C2": {"claimId": "c-1-3", "findingId": "f-1"}, "C3": {"claimId": "c-1-1", "findingId": "f-1"}}
    assert [r["label"] for r in rows] == ["C2", "C3"] and rows[1]["quotes"] == ["q1"]
