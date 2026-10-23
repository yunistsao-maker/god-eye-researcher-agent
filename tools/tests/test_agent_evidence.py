"""End to end with evidence: sub-agents search and read through the wrapped tools, cite verbatim
quotes, finding_write verifies them, the reviewer saves coverage, the writer cites claims [C#], the
verifier and reviser fix unsupported sentences, and dead links are reported. Real tool Lambdas (moto),
scripted LLM. Also unit tests for the sentence checker and the search merge."""
import json
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent import verify as v  # noqa: E402
from research_agent.gateway import check_result  # noqa: E402
from research_agent.models import (  # noqa: E402
    ClaimDraft, CoverageDraft, EntityDraft, EvidenceDraft, FindingDraft, PlanDraft, ReviewDraft, ReviseDraft, SentenceEdit,
    SentenceVerdict, SubQuestionDraft, VerifyDraft,
)
from research_agent.orchestrator import Brief, Orchestrator, Settings  # noqa: E402
from research_agent.research_tools import Budget, ResearchToolkit, SearchOptions  # noqa: E402
from research_agent.watch import Tracker  # noqa: E402

PID = "p-20261024-0e0f0a0b"
USER = "sub-alice"
GOV = "https://www.stat.example.gov.tw/ai-survey"
NEWS = "https://news.example.com/ai-inspection"
COPY = "https://copy.example.org/syndicated"
VENDOR = "https://vendor.example.net/whitepaper"
PAGES = {
    GOV: {"title": "製造業 AI 導入調查", "publishedDate": "2026-05-01",
          "text": "2025 年製造業調查顯示，導入 AI 視覺檢測的廠商多半保留既有 AOI 設備，並在其後加上 AI 複判。" * 10
                  + "\n多數受訪廠商表示，標註資料的人力是持續性成本，而不是一次性投資。"},
    NEWS: {"title": "AI inspection goes mainstream", "publishedDate": "2026-06-10",
           "text": "Factories in Taiwan keep their AOI machines and add AI re-inspection on top. " * 8
                   + "Surveys report payback periods longer than vendors suggest, because labelling labour is left out."},
    COPY: {"title": "AI inspection (syndicated)", "publishedDate": "2026-06-11",
           "text": "Factories in Taiwan keep their AOI machines and add AI re-inspection on top. " * 8
                   + "Surveys report payback periods longer than vendors suggest, because labelling labour is left out."},
    VENDOR: {"title": "Vendor whitepaper", "publishedDate": None,
             "text": "Our customers recover their investment within six months on a single production line. " * 6},
}
SEARCH = {"現況": [GOV, NEWS, COPY], "回收期": [VENDOR, NEWS]}


class FakeGateway:
    def __init__(self, mods):
        self.handlers = {"project-tools": mods["project_tools"].handler, "data-tools": mods["data_tools"].handler,
                         "web-tools": mods["web_tools"].handler}
        self.calls = []

    def call(self, target, tool, **arguments):
        self.calls.append(f"{target}___{tool}")
        if target == "web-search":  # the managed connector: {results: [{text, url, title, publishedDate}]}
            key = next((k for k in SEARCH if k in arguments["query"]), None)
            urls = SEARCH.get(key, [])
            return {"id": "x", "results": [{"text": PAGES[u]["text"][:120], "url": u, "title": PAGES[u]["title"],
                                            "publishedDate": PAGES[u]["publishedDate"]} for u in urls]}
        result = self.handlers[target]({**arguments, "_caller": USER, "__tool": f"{target}___{tool}"}, None)
        return check_result(f"{target}___{tool}", result)


@pytest.fixture()
def wired(aws, monkeypatch):
    wt = aws["mods"]["web_tools"]
    monkeypatch.setattr(wt, "_fetch_direct", lambda url: {**PAGES[url], "finalUrl": url, "via": "direct"})
    monkeypatch.setattr(wt, "_robots_allowed", lambda parsed: True)
    monkeypatch.setattr(wt, "_is_public_host", lambda host: True)
    monkeypatch.setattr(wt, "_check_one", lambda url: {"url": url, "ok": url != VENDOR, "status": 404 if url == VENDOR else 200})
    return aws


def doc_of(page_text: str) -> str:
    return re.search(r"docId: (d-[0-9a-f]{12})", page_text).group(1)


class EvidenceLlm:
    def __init__(self):
        self.verify_calls = []
        self.revise_items = None
        self.report_catalog = None

    def plan(self, topic, seed, brief="", min_subs=3, max_subs=5, activity=None):
        assert "only sources published on or after 2025-01-01" in brief
        return PlanDraft(subQuestions=[SubQuestionDraft(question="導入現況？", dataShape="list"),
                                       SubQuestionDraft(question="投資回收期？", dataShape="list")],
                         requirements=["導入現況", "成本與回收期", "法規要求"])

    def research(self, question, shape, tools, feedback="", activity=None, reads=4):
        web_search, read_page = tools
        if question == "導入現況？":
            assert "stat.example.gov.tw" in web_search(query="AI 視覺檢測 現況")
            gov, news, copy = (doc_of(read_page(url=u)) for u in (GOV, NEWS, COPY))
            assert "repeats" in read_page(url=COPY)  # the syndicated copy is flagged to the agent
            claims = [ClaimDraft(text="多數廠商保留 AOI 設備並加上 AI 複判", evidence=[
                          EvidenceDraft(docId=gov, quote="導入 AI 視覺檢測的廠商多半保留既有 AOI 設備"),
                          EvidenceDraft(docId=copy, quote="keep their AOI machines and add AI re-inspection on top")]),
                      ClaimDraft(text="標註資料的人力是持續性成本", evidence=[
                          EvidenceDraft(docId=gov, quote="標註資料的人力是持續性成本")])]
        else:
            web_search(query="AI 檢測 回收期")
            vendor, news = (doc_of(read_page(url=u)) for u in (VENDOR, NEWS))
            claims = [ClaimDraft(text="設備商宣稱單一產線六個月內回收", evidence=[
                EvidenceDraft(docId=vendor, quote="recover their investment within six months on a single production line"),
                EvidenceDraft(docId=news, quote="Surveys report payback periods longer than vendors suggest", stance="contradicts")])]
        return FindingDraft(summary="一段足夠長的摘要，說明這個子題的答案。", keyPoints=["重點"], claims=claims,
                            entities=[EntityDraft(name="AOI", type="tech")], confidence=0.7)

    def design_ui(self, finding, activity=None):
        raise AssertionError("list findings get no sub-UI")

    def review(self, topic, findings, requirements, max_follow_ups=3, activity=None):
        ids = [c["claimId"] for f in findings for c in f["claims"]]
        return ReviewDraft(coverage=[CoverageDraft(requirementId="q1", status="covered", claimIds=ids[:1]),
                                     CoverageDraft(requirementId="q2", status="weak", claimIds=[ids[-1], "c-bogus-1"], note="說法分歧"),
                                     CoverageDraft(requirementId="q9", status="covered")],
                           gaps=["法規要求沒有資料"])

    def report(self, topic, requirements, catalog, review, words=800, activity=None, on_text=None):
        self.report_catalog = json.loads(catalog)
        label = {row["claim"]: row["label"] for row in self.report_catalog}
        aoi, labour, payback = label["多數廠商保留 AOI 設備並加上 AI 複判"], label["標註資料的人力是持續性成本"], label["設備商宣稱單一產線六個月內回收"]
        text = (f"## 摘要\n\n多數廠商保留既有 AOI 設備並加上 AI 複判 [{aoi}]。投資回收期的說法分歧 [{payback}]。"
                f"這句話引用了一個根本不存在的主張編號 [C99]。\n\n## 主要發現\n\n- 標註資料的人力是持續性成本 [{labour}]。\n"
                f"- 回收期一定少於三個月 [{payback}]。\n\n## 矛盾與不確定性\n\n- 設備商案例與調查的回收期完全一致 [{payback}]。\n\n"
                "## 尚待研究\n\n- 法規要求仍待後續研究與確認。")
        if on_text:
            on_text(text)
        return text

    def verify(self, items, activity=None):
        self.verify_calls.append(items)
        verdicts = []
        for it in items:
            if "一定少於三個月" in it["sentence"]:
                verdicts.append(SentenceVerdict(id=it["id"], verdict="unsupported", reason="no such number"))
            elif "完全一致" in it["sentence"]:
                verdicts.append(SentenceVerdict(id=it["id"], verdict="partial", reason="the claims say they differ"))
            else:
                verdicts.append(SentenceVerdict(id=it["id"], verdict="supported"))
        return VerifyDraft(verdicts=verdicts)

    def revise(self, items, activity=None):
        self.revise_items = items
        edits = []
        for it in items:
            if "一定少於三個月" in it["sentence"]:
                edits.append(SentenceEdit(id=it["id"], action="delete"))
            else:
                edits.append(SentenceEdit(id=it["id"], action="rewrite",
                                          text=f"設備商案例與調查對回收期的說法不同 [{it['allowedLabels'][0]}][C42]。"))
        return ReviseDraft(edits=edits)


def test_evidence_run_end_to_end(wired):
    m, published = wired["mods"], wired["published"]
    tracker = Tracker(lambda t, d: published.append({"type": t, "projectId": PID, "ts": "2026-10-24T08:00:00.000Z", "data": d}))
    llm = EvidenceLlm()
    gw = FakeGateway(m)
    result = Orchestrator(gw, llm, Settings(max_parallel=1), tracker=tracker).run(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40,
        brief=Brief(start_date="2025-01-01"))
    assert result["findings"] == 2 and result["claims"] == 3

    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    claims = {c["text"]: c for f in got["findings"] for c in f["claims"]}
    assert claims["多數廠商保留 AOI 設備並加上 AI 複判"]["status"] == "corroborated"   # gov + syndicated copy of news
    assert claims["標註資料的人力是持續性成本"]["status"] == "asserted"
    assert claims["設備商宣稱單一產線六個月內回收"]["status"] == "contested"
    assert len(got["docs"]) == 4 and sum(1 for d in got["docs"] if d["duplicateOf"]) == 1
    assert [r["id"] for r in got["requirements"]] == ["q1", "q2", "q3"]

    cov = {c["id"]: c for c in got["coverage"]["requirements"]}
    assert cov["q1"]["status"] == "covered" and cov["q2"]["claimIds"] == [claims["設備商宣稱單一產線六個月內回收"]["claimId"]]
    assert cov["q3"]["status"] == "missing" and "q9" not in cov      # skipped requirement -> missing; unknown one dropped

    syn = got["synthesis"]
    report = syn["report"]
    assert "一定少於三個月" not in report and "完全一致" not in report and "[C99]" not in report and "[C42]" not in report
    assert "設備商案例與調查對回收期的說法不同" in report
    assert set(syn["citations"]) == set(re.findall(r"\[(C\d+)\]", report))
    ver = syn["verification"]
    assert ver == {**ver, "citedSentences": 5, "supported": 3, "partial": 1, "unsupported": 1, "revised": 1, "removed": 1,
                   "unknownCitations": 1, "uncitedSentences": 1, "precisionBefore": 0.6, "precisionAfter": 1.0}
    assert ver["deadUrls"] == [VENDOR] and ver["claimsCited"] == 3
    assert len(llm.verify_calls) == 2 and len(llm.verify_calls[1]) == 1    # the rewrite was checked once more
    assert all("allowedLabels" in it and it["claims"] for it in llm.revise_items)

    kinds = [e["type"] for e in published]
    assert kinds.count("source.added") == 4 and "coverage.updated" in kinds
    assert ("supervisor", "verifying") in [(e["data"].get("agentId"), e["data"].get("phase")) for e in published if e["type"] == "agent.activity"]
    assert "web-tools___url_check" in gw.calls and "web-tools___search_web" not in gw.calls   # second index is off by default

    fixture = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "evidence-run.json"
    if os.environ.get("WRITE_CONTRACT_FIXTURE") or not fixture.exists():
        fixture.write_text(json.dumps({"events": published, "projectGet": got}, ensure_ascii=False, indent=1) + "\n")


def test_rejected_quotes_go_back_to_the_agent_with_reasons(wired):
    m = wired["mods"]

    class Sloppy(EvidenceLlm):
        def __init__(self):
            super().__init__()
            self.feedback = []

        def research(self, question, shape, tools, feedback="", activity=None, reads=4):
            self.feedback.append(feedback)
            if feedback:
                return super().research(question, shape, tools, feedback, activity, reads)
            gov = doc_of(tools[1](url=GOV))
            return FindingDraft(summary="一段足夠長的摘要，說明這個子題的答案。", keyPoints=[], entities=[], confidence=0.5,
                                claims=[ClaimDraft(text="一個改寫過的引文", evidence=[EvidenceDraft(docId=gov, quote="廠商幾乎都保留了舊的 AOI 機台")])])

    llm = Sloppy()
    Orchestrator(FakeGateway(m), llm, Settings(max_parallel=1, verify=False, check_links=False)).run(
        project_id=PID, topic="AI 視覺檢測導入", parent_project_id=None, session_id="s" * 40, brief=Brief(start_date="2025-01-01"))
    retried = [f for f in llm.feedback if f]
    assert len(retried) == 2 and all("not found" in f and "Quote each passage exactly" in f for f in retried)


# --- unit tests -------------------------------------------------------------------------------------

def test_sentence_split_keeps_markers_with_their_sentence():
    assert v.split_sentences("第一句 [C1]。第二句。[C2][C3]第三句！") == ["第一句 [C1]。", "第二句。[C2][C3]", "第三句！"]
    assert v.split_sentences("One claim [C1]. Two claims [C2][C3]. Three") == ["One claim [C1].", "Two claims [C2][C3].", "Three"]
    blocks = v.parse_report("## 摘要\n\n- 甲 [C1]。乙 [C7]。\n\n## 尚待研究\n\n- 還不知道的事情需要後續的研究來確認。")
    assert v.strip_unknown_markers(blocks, {"C1"}) == 1
    sents = v.sentences(blocks)
    assert [s.labels for s in sents] == [["C1"], [], []]
    assert not v.needs_citation(sents[2])                     # open-questions section needs no citation
    revised, removed = v.apply_edits(blocks, sents, {1: "甲改寫 [C1][C5]。", 2: None}, {"C1"})
    assert (revised, removed) == (1, 1)
    assert v.render(blocks) == "## 摘要\n\n- 甲改寫 [C1]。\n\n## 尚待研究\n\n- 還不知道的事情需要後續的研究來確認。"


def test_search_merge_dedupes_and_caps_per_publisher():
    kit = ResearchToolkit(None, PID, SearchOptions(exclude_domains=["spam.example"], max_results=5), Budget())
    primary = [{"url": "https://www.a.example/x?utm_source=1", "title": "A"}, {"url": "https://a.example/y", "title": "A2"},
               {"url": "https://a.example/z", "title": "A3"}, {"url": "https://spam.example/1", "title": "S"}]
    secondary = [{"url": "https://a.example/x", "title": "dup"}, {"url": "https://b.example/1", "title": "B"}]
    merged = kit.merge(primary, secondary)
    assert [r["title"] for r in merged] == ["A", "A2", "B"]   # interleaved; A3 is the third from a.example; spam excluded


def test_toolkit_budget_tells_the_agent_to_stop(wired):
    gw = FakeGateway(wired["mods"])
    m = wired["mods"]
    m["project_tools"].handler({"__tool": "x___project_save", "_caller": USER, "projectId": PID, "status": "running", "topic": "主題測試"}, None)
    kit = ResearchToolkit(gw, PID, SearchOptions(), Budget(searches=1, reads=1))
    web_search, read_page = kit.tools()
    assert "Results for" in web_search(query="現況")
    assert "budget reached" in web_search(query="現況").lower()
    first = read_page(url=GOV)
    assert "docId: d-" in first and "showing characters 0-" in first
    assert "budget reached" in read_page(url=NEWS).lower()
    assert "showing characters 6000-" in read_page(url=GOV, offset=6000) or "of " in first  # continuing a page is free
