"""Tools for the v2 workflow: drafts and plan review, starting and re-opening projects, steering,
superseded claims, report versions, follow-up answers and the end-of-run email."""
import boto3
import pytest

PID = "p-20261024-a1b2c3d4"
ALICE = "sub-alice"
BOB = "sub-bob"
PAGE = "https://www.stat.example.gov.tw/survey"
NEWER = "https://news.example.com/2026-update"
TEXTS = {
    PAGE: "2025 年調查顯示，多數廠商保留既有 AOI 設備並加上 AI 複判，投資回收期約為十八個月。" * 6,
    NEWER: "2026 年更新的調查指出，投資回收期已縮短到十二個月左右，主要因為標註工具成本下降。" * 6,
}


def call(mods, target, tool, user=ALICE, **args):
    mod = {"project-tools": "project_tools", "data-tools": "data_tools", "web-tools": "web_tools"}[target]
    return mods[mod].handler({**args, "_caller": user, "__tool": f"{target}___{tool}"}, None)


def kinds(published):
    return [e["type"] for e in published]


@pytest.fixture()
def env(aws, monkeypatch):
    wt = aws["mods"]["web_tools"]
    monkeypatch.setattr(wt, "_fetch_direct", lambda url: {"text": TEXTS[url], "title": url, "publishedDate": "2026-01-02",
                                                          "finalUrl": url, "via": "direct"})
    monkeypatch.setattr(wt, "_robots_allowed", lambda parsed: True)
    monkeypatch.setattr(wt, "_is_public_host", lambda host: True)
    return aws


def sub_qs(n=2, **extra):
    return [{"findingId": f"f-{i + 1}", "question": f"子題 {i + 1}？", "dataShape": "list", **extra} for i in range(n)]


def draft(mods):
    return call(mods, "project-tools", "project_save", projectId=PID, status="draft", topic="AI 視覺檢測",
                brief={"depth": "deep", "audience": "廠長", "startDate": "2024-01-01", "includeDomains": ["gov.tw"]})


def finding(fid, claims):
    return {"findingId": fid, "question": "回收期？", "summary": "一段足夠長的摘要，說明這個子題的答案。", "keyPoints": [],
            "entities": [], "sources": [], "dataShape": "list", "data": {}, "confidence": 0.6, "claims": claims}


def doc_id(mods, url):
    return call(mods, "web-tools", "fetch_page", url=url, projectId=PID)["docId"]


# --- drafts and plan review -------------------------------------------------------------------------

def test_draft_plan_review_then_start(env):
    m, pub = env["mods"], env["published"]
    created = draft(m)
    assert created["project"]["status"] == "draft" and created["project"]["brief"]["depth"] == "deep"
    assert pub[-1]["type"] == "project.created" and pub[-1]["data"]["status"] == "draft"

    reqs = [{"id": "q1", "text": "導入現況"}, {"id": "q2", "text": "成本與回收期"}]
    assert call(m, "data-tools", "plan_propose", projectId=PID, subQuestions=sub_qs(), requirements=reqs)["ok"]
    assert pub[-1]["type"] == "plan.proposed" and pub[-1]["data"]["by"] == "agent" and pub[-1]["data"]["brief"]["audience"] == "廠長"
    edited = sub_qs(3)
    assert call(m, "data-tools", "plan_propose", projectId=PID, subQuestions=edited, requirements=reqs, by="user",
                brief={"depth": "standard"})["ok"]
    got = call(m, "project-tools", "project_get", projectId=PID)
    assert got["proposedPlan"]["by"] == "user" and len(got["proposedPlan"]["subQuestions"]) == 3
    assert got["project"]["brief"] == {"depth": "standard"} and got["plan"] == []

    # Another user cannot propose; a bad plan is refused.
    assert not call(m, "data-tools", "plan_propose", user=BOB, projectId=PID, subQuestions=edited)["ok"]
    assert "unique" in call(m, "data-tools", "plan_propose", projectId=PID, subQuestions=sub_qs(1) * 2)["error"]

    started = call(m, "project-tools", "project_save", projectId=PID, status="running", runtimeSessionId="s" * 40)
    assert started["project"]["status"] == "running" and started["steering"] == []
    assert [e for e in pub if e["type"] == "project.started"][-1]["data"] == {"version": 1, "mode": "full", "since": None}
    assert "only for a draft" in call(m, "data-tools", "plan_propose", projectId=PID, subQuestions=edited)["error"]
    # A draft cannot be created twice, and a running project is not a draft again.
    assert not call(m, "project-tools", "project_save", projectId=PID, status="draft")["ok"]


def test_status_transitions_and_reopen(env):
    m, pub = env["mods"], env["published"]
    call(m, "project-tools", "project_save", projectId=PID, status="running", topic="AI 視覺檢測")
    assert "only a new project can be a draft" in call(m, "project-tools", "project_save", projectId=PID, status="draft")["error"]
    assert call(m, "project-tools", "project_save", projectId=PID, status="completed")["ok"]
    completed = call(m, "project-tools", "project_get", projectId=PID)["project"]
    assert completed["completedAt"] and completed["stats"]["findings"] == 0 and completed["version"] == 1

    # A late heartbeat after completion must not flip the project back to running.
    late = call(m, "project-tools", "project_save", projectId=PID, status="running")
    assert not late["ok"] and "reopen" in late["error"]

    again = call(m, "project-tools", "project_save", projectId=PID, status="running", reopen=True)
    assert again["project"]["version"] == 2 and again["project"]["since"] == completed["completedAt"][:10]
    assert pub[-1]["type"] == "project.started" and pub[-1]["data"]["mode"] == "incremental"

    call(m, "project-tools", "project_save", projectId=PID, status="failed", message="boom")
    assert not call(m, "project-tools", "project_save", projectId=PID, status="running", reopen=True)["ok"]  # only completed reopens
    listed = call(m, "project-tools", "project_list")["projects"][0]
    assert listed["status"] == "failed" and listed["version"] == 2 and "brief" not in listed


# --- steering ---------------------------------------------------------------------------------------

def test_steering_reaches_the_heartbeat_and_the_plan(env):
    m, pub = env["mods"], env["published"]
    draft(m)
    assert "only a running project" in call(m, "project-tools", "project_steer", projectId=PID, kind="finish")["error"]
    call(m, "project-tools", "project_save", projectId=PID, status="running")
    assert "text (3-500 chars)" in call(m, "project-tools", "project_steer", projectId=PID, kind="redirect", text="")["error"]
    assert not call(m, "project-tools", "project_steer", projectId=PID, kind="pause")["ok"]
    assert not call(m, "project-tools", "project_steer", user=BOB, projectId=PID, kind="finish")["ok"]

    steer = call(m, "project-tools", "project_steer", projectId=PID, kind="redirect", text="多看半導體封測，少看 PCB")["steer"]
    assert steer["steerId"].startswith("s-") and pub[-1] == {**pub[-1], "type": "steer.received"}
    beat = call(m, "project-tools", "project_save", projectId=PID, status="running")
    assert [s["steerId"] for s in beat["steering"]] == [steer["steerId"]]

    call(m, "data-tools", "plan_save", projectId=PID, subQuestions=sub_qs(2, round=1) + [
        {"findingId": "f-3", "question": "半導體封測的導入？", "dataShape": "list", "round": 2}], steerIds=[steer["steerId"]])
    assert pub[-1]["type"] == "plan.ready" and pub[-1]["data"]["steerIds"] == [steer["steerId"]]
    applied = call(m, "project-tools", "project_get", projectId=PID)["steering"][0]
    assert applied["appliedRound"] == 2
    assert not call(m, "data-tools", "plan_save", projectId=PID, subQuestions=sub_qs(), steerIds=["nope"])["ok"]

    for i in range(9):
        assert call(m, "project-tools", "project_steer", projectId=PID, kind="finish")["ok"], i
    assert "At most 10" in call(m, "project-tools", "project_steer", projectId=PID, kind="finish")["error"]


def test_plan_save_accepts_versions_and_rounds(env):
    m = env["mods"]
    call(m, "project-tools", "project_save", projectId=PID, status="running", topic="AI 視覺檢測")
    subs = sub_qs(2, round=1) + [{"findingId": "f-3", "question": "回收期的新資料？", "dataShape": "list", "round": 5, "version": 2,
                                   "updates": "f-2"}]
    assert call(m, "data-tools", "plan_save", projectId=PID, subQuestions=subs)["ok"]
    assert call(m, "project-tools", "project_get", projectId=PID)["plan"][-1] == subs[-1]
    assert not call(m, "data-tools", "plan_save", projectId=PID, subQuestions=sub_qs(1, round=11))["ok"]
    assert not call(m, "data-tools", "plan_save", projectId=PID, subQuestions=sub_qs(1, updates="x"))["ok"]


# --- incremental runs: superseded claims and report versions -----------------------------------------

def test_incremental_claims_supersede_and_reports_keep_history(env):
    m, pub = env["mods"], env["published"]
    call(m, "project-tools", "project_save", projectId=PID, status="running", topic="AI 視覺檢測")
    old_doc = doc_id(m, PAGE)
    first = call(m, "data-tools", "finding_write", projectId=PID, finding=finding("f-1", [
        {"text": "投資回收期約十八個月", "evidence": [{"docId": old_doc, "quote": "投資回收期約為十八個月"}]},
        {"text": "多數廠商保留既有 AOI 設備", "evidence": [{"docId": old_doc, "quote": "多數廠商保留既有 AOI 設備並加上 AI 複判"}]}]))
    assert [c["claimId"] for c in first["claims"]] == ["c-1-1", "c-1-2"]
    call(m, "data-tools", "synthesis_write", projectId=PID, report="## 摘要\n\n回收期約十八個月 [C1]。",
         citations={"C1": {"claimId": "c-1-1", "findingId": "f-1"}})
    call(m, "project-tools", "project_save", projectId=PID, status="completed")
    call(m, "project-tools", "project_save", projectId=PID, status="running", reopen=True)

    new_doc = doc_id(m, NEWER)
    res = call(m, "data-tools", "finding_write", projectId=PID, finding=finding("f-2", [
        {"text": "投資回收期已縮短到約十二個月", "updates": "c-1-1",
         "evidence": [{"docId": new_doc, "quote": "投資回收期已縮短到十二個月左右"}]},
        {"text": "標註工具的成本下降", "updates": "c-9-9", "evidence": [{"docId": new_doc, "quote": "主要因為標註工具成本下降"}]}]))
    assert res["ok"] and any("c-9-9" in w for w in res["warnings"])
    assert res["claims"][0]["updates"] == "c-1-1" and "updates" not in res["claims"][1]
    assert pub[-1]["type"] == "claims.updated"
    assert pub[-1]["data"]["superseded"] == [{"claimId": "c-1-1", "findingId": "f-1", "supersededBy": "c-2-1"}]

    got = call(m, "project-tools", "project_get", projectId=PID)
    claims = {c["claimId"]: c for f in got["findings"] for c in f["claims"]}
    assert claims["c-1-1"]["status"] == "superseded" and claims["c-1-1"]["supersededBy"] == "c-2-1"
    assert claims["c-1-2"]["status"] == "asserted" and "updates" not in claims["c-2-2"]

    # Rewriting the same finding does not supersede twice.
    again = call(m, "data-tools", "finding_write", projectId=PID, finding=finding("f-2", [
        {"text": "投資回收期已縮短到約十二個月", "updates": "c-1-2",
         "evidence": [{"docId": new_doc, "quote": "投資回收期已縮短到十二個月左右"}]}]))
    assert again["ok"] and "updates" not in again["claims"][0]
    assert {c["claimId"]: c for f in call(m, "project-tools", "project_get", projectId=PID)["findings"]
            for c in f["claims"]}["c-1-2"]["status"] == "asserted"

    call(m, "data-tools", "synthesis_write", projectId=PID, report="## 摘要\n\n回收期約十二個月 [C1]。",
         citations={"C1": {"claimId": "c-2-1", "findingId": "f-2"}}, changes={"newClaims": 1, "updatedClaims": 1})
    call(m, "data-tools", "synthesis_write", projectId=PID, report="## 摘要\n\n改寫後的第二版 [C1]。",
         citations={"C1": {"claimId": "c-2-1", "findingId": "f-2"}})  # same version: replaces, no new history entry
    got = call(m, "project-tools", "project_get", projectId=PID)
    assert got["synthesis"]["version"] == 2 and got["synthesis"]["report"].startswith("## 摘要\n\n改寫後")
    assert [h["version"] for h in got["history"]] == [1] and "十八個月" in got["history"][0]["report"]
    assert not call(m, "data-tools", "synthesis_write", projectId=PID, report="x", changes={"newClaims": -1})["ok"]


# --- follow-up questions --------------------------------------------------------------------------

def test_qa_write(env):
    m, pub = env["mods"], env["published"]
    call(m, "project-tools", "project_save", projectId=PID, status="running", topic="AI 視覺檢測")
    call(m, "project-tools", "project_save", projectId=PID, status="completed")
    qa = dict(projectId=PID, qaId="qa-1a2b3c", question="只看封測時結論會不同嗎？", answer="封測的資料只有單一來源 [C2]。",
              citations={"C2": {"claimId": "c-1-2", "findingId": "f-1"}}, needsResearch=True, researchQuestion="半導體封測的導入案例")
    assert call(m, "data-tools", "qa_write", **qa)["ok"]
    assert pub[-1]["type"] == "qa.ready" and pub[-1]["data"]["qa"]["researchQuestion"] == "半導體封測的導入案例"
    assert call(m, "data-tools", "qa_write", **{**qa, "answer": "第二次的回答 [C2]。", "needsResearch": False})["ok"]
    got = call(m, "project-tools", "project_get", projectId=PID)["qa"]
    assert len(got) == 1 and got[0]["answer"] == "第二次的回答 [C2]。" and "researchQuestion" not in got[0]
    for bad in ({"qaId": "x"}, {"answer": ""}, {"citations": {"X1": {}}}, {"needsResearch": "yes"}):
        assert not call(m, "data-tools", "qa_write", **{**qa, **bad})["ok"], bad
    assert not call(m, "data-tools", "qa_write", user=BOB, **qa)["ok"]


# --- email ----------------------------------------------------------------------------------------

def test_notify_off_without_a_sender(env, monkeypatch):
    m = env["mods"]
    monkeypatch.delenv("NOTIFY_FROM", raising=False)
    call(m, "project-tools", "project_save", projectId=PID, status="running", topic="AI 視覺檢測")
    assert call(m, "project-tools", "project_notify", projectId=PID, enabled=True) == {"ok": True, "notify": False, "available": False}
    assert not call(m, "project-tools", "project_notify", projectId=PID, enabled="yes")["ok"]


def test_notify_emails_the_owner_when_the_run_completes(env, monkeypatch):
    m = env["mods"]
    notify = m["project_tools"].notify
    sub = "3f0c1d2e-0000-4000-8000-1234567890ab"
    boto3.client("ses").verify_email_identity(EmailAddress="research@example.com")
    monkeypatch.setenv("NOTIFY_FROM", "research@example.com")
    monkeypatch.setenv("USER_POOL_ID", "us-west-2_pool")
    monkeypatch.setenv("WEB_URL", "https://d111.cloudfront.net/")
    monkeypatch.setattr(notify, "_web_url", None)
    sent, lookups = [], []
    real = notify.boto3.client

    class Users:
        def list_users(self, **args):
            lookups.append(args)
            return {"Users": [{"Attributes": [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": "alice@example.com"}]}]}

    def client(name, *a, **kw):
        if name == "cognito-idp":
            return Users()
        c = real(name, *a, **kw)
        if name == "sesv2":
            orig = c.send_email
            c.send_email = lambda **args: (sent.append(args), orig(**args))[1]
        return c

    monkeypatch.setattr(notify.boto3, "client", client)
    assert notify.email_of('x" or sub = "y') is None and not lookups   # never builds a filter from odd input
    call(m, "project-tools", "project_save", user=sub, projectId=PID, status="running", topic="AI 視覺檢測")
    assert call(m, "project-tools", "project_notify", user=sub, projectId=PID, enabled=True) == {"ok": True, "notify": True, "available": True}
    assert call(m, "project-tools", "project_get", user=sub, projectId=PID)["project"]["notify"] is True
    call(m, "project-tools", "project_save", user=sub, projectId=PID, status="completed")
    assert len(sent) == 1 and lookups == [{"UserPoolId": "us-west-2_pool", "Filter": f'sub = "{sub}"', "Limit": 1}]
    mail = sent[0]
    assert mail["Destination"]["ToAddresses"] == ["alice@example.com"]
    body = mail["Content"]["Simple"]["Body"]["Text"]["Data"]
    assert "研究完成：AI 視覺檢測" == mail["Content"]["Simple"]["Subject"]["Data"]
    assert f"https://d111.cloudfront.net/#/p/{PID}/report" in body
    call(m, "project-tools", "project_save", user=sub, projectId=PID, status="completed")  # already completed: no second email
    assert len(sent) == 1
