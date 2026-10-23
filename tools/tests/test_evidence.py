"""Evidence backbone: pages become project documents, claims are checked against their snapshots,
claim status follows from independent publishers, and coverage/verification are stored."""
import pytest

from fixtures import ALICE, PID, finding

PAGES = {
    "https://www.stat.example.gov.tw/report?utm_source=x": {
        "title": "AI 導入統計", "publishedDate": "2026-05-01",
        "text": "2025 年製造業調查顯示，導入 AI 視覺檢測的廠商多半保留既有 AOI 設備，並在其後加上 AI 複判。" * 12
                + "\n多數受訪廠商表示，標註資料的人力是持續性成本。",
    },
    "https://news.example.com/ai-inspection": {
        "title": "AI inspection goes mainstream", "publishedDate": "2026-06-10",
        "text": "Factories in Taiwan keep their AOI machines and add AI re-inspection on top. " * 8
                + "Vendors claim payback within months, but surveys report longer periods.",
    },
    "https://copy.example.org/syndicated": {  # same text as the news story on another publisher
        "title": "AI inspection goes mainstream (syndicated)", "publishedDate": "2026-06-11",
        "text": "Factories in Taiwan keep their AOI machines and add AI re-inspection on top. " * 8
                + "Vendors claim payback within months, but surveys report longer periods.",
    },
    "https://vendor.example.net/whitepaper": {
        "title": "Vendor whitepaper", "publishedDate": None,
        "text": "Our customers recover their investment within six months on a single line. " * 6,
    },
}


def call(mod, tool, **args):
    return mod.handler({"__tool": f"x___{tool}", **args}, None)


@pytest.fixture()
def web(aws, monkeypatch):
    m = aws["mods"]
    wt = m["web_tools"]

    def fake_fetch(url):
        page = PAGES.get(url)
        if page is None:
            raise wt.Unreadable("Page returned HTTP 403")
        return {**page, "finalUrl": url, "via": "direct"}

    monkeypatch.setattr(wt, "_fetch_direct", fake_fetch)
    monkeypatch.setattr(wt, "_robots_allowed", lambda parsed: True)
    monkeypatch.setattr(wt, "_is_public_host", lambda host: not host.startswith(("127.", "10.", "localhost")))
    call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="running", topic="AI 視覺檢測")
    return aws


def read(m, url, **extra):
    return call(m["web_tools"], "fetch_page", _caller=ALICE, projectId=PID, url=url, **extra)


def test_fetch_registers_documents_and_detects_duplicates(web):
    m, published = web["mods"], web["published"]
    gov = read(m, "https://www.stat.example.gov.tw/report?utm_source=x", maxChars=500)
    assert gov["ok"] and gov["docId"].startswith("d-") and gov["publisher"] == "example.gov.tw"
    assert gov["sourceType"] == "government" and gov["canonicalUrl"] == "https://stat.example.gov.tw/report"
    assert gov["nextOffset"] == 500 and gov["totalChars"] > 500 and gov["cached"] is False
    again = read(m, "http://stat.example.gov.tw/report", offset=500)  # same canonical page -> snapshot slice
    assert again["cached"] is True and again["docId"] == gov["docId"] and again["offset"] == 500

    news = read(m, "https://news.example.com/ai-inspection")
    copy = read(m, "https://copy.example.org/syndicated")
    assert news["duplicateOf"] is None and copy["duplicateOf"] == news["docId"]
    assert [e["type"] for e in published].count("source.added") == 3

    failed = call(m["web_tools"], "fetch_page", _caller=ALICE, projectId=PID, url="https://blocked.example.com/x")
    assert failed["ok"] is False and "403" in failed["error"]
    got = call(m["project_tools"], "project_get", _caller=ALICE, projectId=PID)
    assert {d["docId"] for d in got["docs"]} == {gov["docId"], news["docId"], copy["docId"]}  # failed page not listed


def test_second_tier_extractor_rescues_blocked_pages(web, monkeypatch):
    m = web["mods"]
    monkeypatch.setattr(m["web_tools"].providers, "extract",
                        lambda url: {"title": "PDF report", "text": "Extracted text of a PDF report about inspection. " * 5,
                                     "publishedDate": "2026-01-02", "via": "tavily"})
    res = read(m, "https://pdf.example.com/report.pdf")
    assert res["ok"] and res["via"] == "tavily" and res["publishedDate"] == "2026-01-02"


def test_private_addresses_and_unconfigured_search_are_refused(web):
    m = web["mods"]
    assert call(m["web_tools"], "fetch_page", _caller=ALICE, url="http://127.0.0.1/admin")["ok"] is False
    checked = call(m["web_tools"], "url_check", _caller=ALICE, urls=["http://10.0.0.1/x"])
    assert checked["dead"] == ["http://10.0.0.1/x"]
    res = call(m["web_tools"], "search_web", _caller=ALICE, query="ai inspection")
    assert res["ok"] is False and "not configured" in res["error"]


def _claim(text, *evidence):
    return {"text": text, "evidence": [{"docId": d, "quote": q, "stance": s} for d, q, s in evidence]}


def test_claims_are_verified_against_snapshots(web):
    m, published = web["mods"], web["published"]
    gov = read(m, "https://www.stat.example.gov.tw/report?utm_source=x")["docId"]
    news = read(m, "https://news.example.com/ai-inspection")["docId"]
    copy = read(m, "https://copy.example.org/syndicated")["docId"]
    vendor = read(m, "https://vendor.example.net/whitepaper")["docId"]

    f = finding("f-1", "list")
    f["sources"] = []
    f["claims"] = [
        _claim("多數廠商保留 AOI 並加上 AI 複判",
               (gov, "導入 AI 視覺檢測的廠商多半保留既有 AOI 設備", "supports"),
               (news, "keep their AOI machines and add AI re-inspection on top", "supports")),
        _claim("A syndicated copy does not add an independent source",
               (news, "Vendors claim payback within months", "supports"),
               (copy, "vendors claim payback within months", "supports")),
        _claim("投資回收期說法分歧",
               (vendor, "recover their investment within six months on a single line", "supports"),
               (news, "surveys report longer periods", "contradicts")),
        _claim("A quote that is not on the page",
               (gov, "這句話根本不在頁面上，應該被拒絕", "supports")),
    ]
    res = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=f)
    assert res["ok"], res
    assert [c["status"] for c in res["claims"]] == ["corroborated", "asserted", "contested"]
    assert res["claims"][1]["independentSources"] == 1
    assert len(res["warnings"]) == 1 and "not found" in res["warnings"][0]

    stored = [e for e in published if e["type"] == "finding.ready"][-1]["data"]["finding"]
    first = stored["claims"][0]["evidence"][0]
    assert first["quote"] == "導入 AI 視覺檢測的廠商多半保留既有 AOI 設備" and first["publisher"] == "example.gov.tw"
    assert first["charEnd"] > first["charStart"]
    assert "https://www.stat.example.gov.tw/report?utm_source=x" in {s["url"] for s in stored["sources"]}
    dup_ev = stored["claims"][1]["evidence"][1]
    assert dup_ev["duplicateOf"] == news and dup_ev["publisher"] == "example.com"


def test_mostly_unverifiable_claims_are_sent_back(web):
    m = web["mods"]
    gov = read(m, "https://www.stat.example.gov.tw/report?utm_source=x")["docId"]
    f = finding("f-2", "list")
    f["claims"] = [_claim("bad one", (gov, "完全捏造的引文內容一", "supports")),
                   _claim("bad two", ("d-000000000000", "a quote from a page never read", "supports")),
                   _claim("good claim", (gov, "標註資料的人力是持續性成本", "supports"))]
    res = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=f)
    assert res["ok"] is False
    joined = " ".join(res["errors"])
    assert "not found" in joined and "not a page you read" in joined and "Only 1 of 3" in joined
    bad_shape = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID,
                     finding={**finding("f-3", "list"), "claims": [{"text": "no evidence", "evidence": []}]})
    assert bad_shape["ok"] is False


def test_requirements_coverage_and_verified_synthesis_round_trip(web):
    m, published = web["mods"], web["published"]
    reqs = [{"id": "q1", "text": "導入現況"}, {"id": "q2", "text": "成本與回收期"}]
    plan = [{"findingId": "f-1", "question": "導入現況？", "dataShape": "list"}]
    assert call(m["data_tools"], "plan_save", _caller=ALICE, projectId=PID, subQuestions=plan, requirements=reqs)["ok"]
    # a later plan_save without requirements keeps them
    plan2 = plan + [{"findingId": "f-2", "question": "回收期？", "dataShape": "list", "round": 2}]
    assert call(m["data_tools"], "plan_save", _caller=ALICE, projectId=PID, subQuestions=plan2)["ok"]
    assert [e for e in published if e["type"] == "plan.ready"][-1]["data"]["requirements"] == reqs

    cov = [{"id": "q1", "status": "covered", "claimIds": ["c-1-1"]}, {"id": "q2", "status": "missing", "note": "沒有成本數字"}]
    assert call(m["data_tools"], "coverage_save", _caller=ALICE, projectId=PID, round=1, coverage=cov) == {"ok": True, "covered": 1, "total": 2}
    bad = call(m["data_tools"], "coverage_save", _caller=ALICE, projectId=PID, coverage=[{"id": "q1", "status": "done"}])
    assert bad["ok"] is False

    ver = {"citedSentences": 6, "supported": 5, "partial": 1, "unsupported": 0, "revised": 1, "removed": 0,
           "uncitedSentences": 1, "precisionBefore": 0.8333, "precisionAfter": 1.0, "deadUrls": []}
    res = call(m["data_tools"], "synthesis_write", _caller=ALICE, projectId=PID, report="## 摘要\n\n內容 [C1]",
               citations={"C1": {"claimId": "c-1-1", "findingId": "f-1"}}, verification=ver)
    assert res["ok"], res
    bad = call(m["data_tools"], "synthesis_write", _caller=ALICE, projectId=PID, report="x", citations={"X1": {}})
    assert bad["ok"] is False

    got = call(m["project_tools"], "project_get", _caller=ALICE, projectId=PID)
    assert got["requirements"] == reqs and got["coverage"]["requirements"] == cov
    assert got["synthesis"]["citations"]["C1"]["claimId"] == "c-1-1"
    assert got["synthesis"]["verification"]["precisionBefore"] == 0.833
