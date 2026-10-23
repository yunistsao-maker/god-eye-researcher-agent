import json

import boto3

from fixtures import ALICE, BAD_SPEC, BOB, COMPARE_SPEC, PID, TIMELINE_SPEC, finding


def call(mod, tool, **args):
    return mod.handler({"__tool": f"x___{tool}", **args}, None)


def types(published):
    return [e["type"] for e in published]


def start_project(m, sub=ALICE):
    return call(m["project_tools"], "project_save", _caller=sub, projectId=PID, status="running", topic="半導體導入生成式 AI")


def test_full_research_flow(aws):
    m, published = aws["mods"], aws["published"]
    assert start_project(m)["created"] is True

    plan = [{"findingId": "f-1", "question": "最早導入的環節？", "dataShape": "comparison"},
            {"findingId": "f-2", "question": "導入時程？", "dataShape": "timeline"}]
    assert call(m["data_tools"], "plan_save", _caller=ALICE, projectId=PID, subQuestions=plan)["ok"]

    r1 = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=finding("f-1"))
    assert r1["ok"], r1
    # entity ids are canonicalised from names, so the same entity links across findings
    r2 = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID,
              finding=finding("f-2", "timeline", entities=[{"id": "e-other-id", "type": "org", "name": "晶圓廠 A"}],
                              relations=[{"from": "f-2", "to": "f-1", "type": "supports"}]))
    assert r2["ok"], r2
    rel = [e for e in published if e["type"] == "relation.added"][-1]["data"]["edges"]
    assert {"from": "f-2", "to": "f-1", "type": "shares_entity", "via": r2["entities"][0]} in rel
    assert {"from": "f-2", "to": "f-1", "type": "supports"} in rel

    # template cache: miss, generate, then hit
    assert call(m["data_tools"], "ui_template_get", _caller=ALICE, dataShape="comparison")["hit"] is False
    w = call(m["data_tools"], "ui_spec_write", _caller=ALICE, projectId=PID, findingId="f-1", spec=COMPARE_SPEC)
    assert w == {"ok": True, "templateSaved": True}
    hit = call(m["data_tools"], "ui_template_get", _caller=ALICE, dataShape="comparison")
    assert hit["hit"] is True and hit["spec"] == COMPARE_SPEC

    # a spec for the wrong shape is rejected and announced as ui.failed
    bad = call(m["data_tools"], "ui_spec_write", _caller=ALICE, projectId=PID, findingId="f-2", spec=COMPARE_SPEC)
    assert bad["ok"] is False and "comparison" in bad["reason"]
    assert call(m["data_tools"], "ui_spec_write", _caller=ALICE, projectId=PID, findingId="f-2", spec=TIMELINE_SPEC)["ok"]

    done = call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="completed")
    assert done["ok"] and any(k.endswith("graph/graph.json") for k in done["saved"])
    completed = [e for e in published if e["type"] == "project.completed"][0]["data"]["stats"]
    assert completed["findings"] == 2 and completed["uiReady"] == 2

    assert types(published)[:3] == ["project.created", "plan.ready", "finding.ready"]
    assert "ui.failed" in types(published) and types(published).count("ui.ready") == 2

    got = call(m["project_tools"], "project_get", _caller=ALICE, projectId=PID)
    assert len(got["findings"]) == 2 and set(got["uiSpecs"]) == {"f-1", "f-2"} and got["plan"] == plan
    listed = call(m["project_tools"], "project_list", _caller=ALICE)
    assert [p["projectId"] for p in listed["projects"]] == [PID]
    assert listed["projects"][0]["findingCount"] == 2

    graph = json.loads(boto3.client("s3").get_object(Bucket="research-bucket-test", Key=f"projects/{PID}/graph/graph.json")["Body"].read())
    assert len(graph["edges"]) == len(got["edges"]) > 0


def test_ui_spec_whitelist(aws):
    m = aws["mods"]
    start_project(m)
    call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=finding("f-9", "list"))
    res = call(m["data_tools"], "ui_spec_write", _caller=ALICE, projectId=PID, findingId="f-9", spec=BAD_SPEC)
    assert res["ok"] is False and "RiskMatrix" in res["reason"]
    assert aws["published"][-1]["type"] == "ui.failed"


def test_invalid_finding_is_rejected_without_events(aws):
    m = aws["mods"]
    start_project(m)
    before = len(aws["published"])
    bad = finding("f-1")
    bad["confidence"] = 3
    bad["sources"] = [{"title": "x", "url": "javascript:alert(1)"}]
    res = call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=bad)
    assert res["ok"] is False and len(res["errors"]) == 2
    assert len(aws["published"]) == before


def test_other_users_cannot_touch_a_project(aws):
    m = aws["mods"]
    start_project(m)
    for tool, args in [("project_get", {}), ("project_cleanup", {}), ("project_save", {"status": "completed"}), ("project_stop", {})]:
        res = call(m["project_tools"], tool, _caller=BOB, projectId=PID, **args)
        assert res["ok"] is False and "another user" in res["error"], (tool, res)
    res = call(m["data_tools"], "finding_write", _caller=BOB, projectId=PID, finding=finding("f-1"))
    assert res["ok"] is False
    assert call(m["project_tools"], "project_list", _caller=BOB)["projects"] == []


def test_missing_caller_is_refused(aws):
    res = call(aws["mods"]["project_tools"], "project_list")
    assert res["ok"] is False and "caller" in res["error"]


def test_restart_and_parent_link(aws):
    m = aws["mods"]
    start_project(m)
    r = call(m["project_tools"], "project_restart", _caller=ALICE, parentProjectId=PID)
    assert r["ok"] and r["projectId"].startswith("p-") and r["projectId"] != PID
    child = call(m["project_tools"], "project_save", _caller=ALICE, projectId=r["projectId"], status="running",
                 topic=r["topic"], parentProjectId=PID)
    assert child["project"]["parentProjectId"] == PID
    assert call(m["project_tools"], "project_restart", _caller=BOB, parentProjectId=PID)["ok"] is False


def test_cleanup_steps(aws):
    m = aws["mods"]
    start_project(m)
    call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=finding("f-1"))
    call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="completed")
    started = call(m["project_tools"], "project_cleanup", _caller=ALICE, projectId=PID)
    assert started["status"] == "archiving" and started["executionArn"]

    state = {"projectId": PID, "owner": ALICE}
    for step in ["stop_session", "export_archive", "tag_objects", "set_ttl", "delete_vectors", "publish_archived"]:
        state = m["cleanup"].handler({"step": step, **state}, None)
    assert state["archivedObjects"] >= 3 and state["taggedObjects"] >= 3 and state["expiringItems"] >= 4
    s3 = boto3.client("s3")
    tags = s3.get_object_tagging(Bucket="research-bucket-test", Key=f"projects/{PID}/manifest.json")["TagSet"]
    assert {"Key": "status", "Value": "archived"} in tags
    assert aws["published"][-1]["type"] == "project.archived"
    assert call(m["project_tools"], "project_list", _caller=ALICE)["projects"] == []
    # running cleanup again is harmless
    assert call(m["project_tools"], "project_cleanup", _caller=ALICE, projectId=PID)["status"] == "archived"


def test_stop_freezes_a_running_project(aws):
    m, published = aws["mods"], aws["published"]
    call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="running", topic="半導體導入生成式 AI",
         runtimeSessionId="s" * 40)
    plan = [{"findingId": "f-1", "question": "最早導入的環節？", "dataShape": "comparison"},
            {"findingId": "f-2", "question": "導入時程？", "dataShape": "timeline"}]
    call(m["data_tools"], "plan_save", _caller=ALICE, projectId=PID, subQuestions=plan)
    call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=finding("f-1"))

    res = call(m["project_tools"], "project_stop", _caller=ALICE, projectId=PID)
    assert res["ok"] and res["stopped"] is True and res["runtimeSessionId"] == "s" * 40
    assert res["project"]["status"] == "stopped" and any(k.endswith("graph/graph.json") for k in res["saved"])
    stopped = [e for e in published if e["type"] == "project.stopped"]
    assert len(stopped) == 1 and stopped[0]["data"]["stats"]["findings"] == 1

    # idempotent: a second stop changes nothing and announces nothing
    again = call(m["project_tools"], "project_stop", _caller=ALICE, projectId=PID)
    assert again["ok"] and again["stopped"] is False and again["project"]["status"] == "stopped"
    assert types(published).count("project.stopped") == 1

    # nothing can change a stopped project; the refusal carries stopped: true for the runtime
    before = len(published)
    refused = [
        call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="running"),
        call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="completed"),
        call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="failed", message="x"),
        call(m["data_tools"], "plan_save", _caller=ALICE, projectId=PID, subQuestions=plan),
        call(m["data_tools"], "finding_write", _caller=ALICE, projectId=PID, finding=finding("f-2", "timeline")),
        call(m["data_tools"], "ui_spec_write", _caller=ALICE, projectId=PID, findingId="f-1", spec=COMPARE_SPEC),
        call(m["data_tools"], "synthesis_write", _caller=ALICE, projectId=PID, report="## 摘要"),
    ]
    for r in refused:
        assert r == {"ok": False, "error": f"Project {PID} was stopped", "stopped": True}, r
    assert len(published) == before

    got = call(m["project_tools"], "project_get", _caller=ALICE, projectId=PID)
    assert got["project"]["status"] == "stopped" and len(got["findings"]) == 1 and len(got["plan"]) == 2
    assert call(m["project_tools"], "project_list", _caller=ALICE)["projects"][0]["status"] == "stopped"
    # a stopped project can be continued as a new project, and archived
    assert call(m["project_tools"], "project_restart", _caller=ALICE, parentProjectId=PID)["ok"]
    assert call(m["project_tools"], "project_cleanup", _caller=ALICE, projectId=PID)["status"] == "archiving"


def test_stop_is_a_no_op_once_the_run_ended(aws):
    m, published = aws["mods"], aws["published"]
    start_project(m)
    call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="completed")
    res = call(m["project_tools"], "project_stop", _caller=ALICE, projectId=PID)
    assert res["ok"] and res["stopped"] is False and res["project"]["status"] == "completed"
    assert "project.stopped" not in types(published)


def test_cleanup_refuses_a_running_project(aws):
    m = aws["mods"]
    start_project(m)
    res = call(m["project_tools"], "project_cleanup", _caller=ALICE, projectId=PID)
    assert res["ok"] is False and "project_stop" in res["error"]


def test_a_stop_between_read_and_write_wins(aws, monkeypatch):
    """project_save reads META, then writes it; a stop landing in between must not be overwritten."""
    m = aws["mods"]
    start_project(m)
    stale = m["common.store"].get_meta(PID)
    call(m["project_tools"], "project_stop", _caller=ALICE, projectId=PID)
    real = m["project_tools"].store.get_meta
    reads = iter([stale])
    monkeypatch.setattr(m["project_tools"].store, "get_meta", lambda pid: next(reads, None) or real(pid))
    res = call(m["project_tools"], "project_save", _caller=ALICE, projectId=PID, status="completed")
    assert res == {"ok": False, "error": f"Project {PID} was stopped", "stopped": True}
    assert real(PID)["status"] == "stopped"
