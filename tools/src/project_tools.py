"""project-tools target: project_save, project_stop, project_steer, project_notify, project_list,
project_get, project_restart, project_cleanup.

These are deterministic operations. The frontend calls them directly through the tools
gateway (no LLM involved); the supervisor agent calls project_save (and project_stop when it is
asked to stop) as well.

Lifecycle: draft (a proposed plan waiting for approval) -> running -> completed | failed | stopped.
A completed project can run again for newer data (project_save running + reopen): its version
goes up and `since` records the date the new run searches from.
"""
from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from common import appsync, notify, store
from common.toolkit import ProjectStopped, ToolError, caller, dispatch, require_owner, require_project_id
from common.validate import validate_brief

_sfn = boto3.client("stepfunctions")

STATUSES = {"draft", "running", "completed", "failed"}  # what project_save may set; `stopped` comes from project_stop
FINAL = ("stopped", "archiving", "archived")             # project_save never overwrites these
STEER_KINDS = {"redirect", "finish"}
MAX_STEERS = 10


def new_project_id() -> str:
    return f"p-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(4)}"


def _stats(project_id: str) -> dict:
    items = store.query_project(project_id)
    count = lambda prefix: sum(1 for i in items if i["SK"].startswith(prefix))  # noqa: E731
    claims = sum(len(i.get("finding", {}).get("claims", []) or []) for i in items if i["SK"].startswith("FINDING#"))
    sources = sum(1 for i in items if i["SK"].startswith("DOC#") and i.get("status") == "ok")
    return {"findings": count("FINDING#"), "edges": count("EDGE#"), "uiReady": count("UI#"), "sources": sources, "claims": claims}


def _snapshot(project_id: str, meta: dict) -> list[str]:
    items = store.query_project(project_id)
    entities = [{"id": i["SK"][7:], "name": i.get("name"), "type": i.get("type"), "findings": i.get("findings", [])}
                for i in items if i["SK"].startswith("ENTITY#")]
    edges = [{k: i[k] for k in ("from", "to", "type", "via") if k in i} for i in items if i["SK"].startswith("EDGE#")]
    prefix = store.project_prefix(project_id)
    return [
        store.put_json(f"{prefix}graph/graph.json", {"projectId": project_id, "entities": entities, "edges": edges}),
        store.put_json(f"{prefix}manifest.json", meta),
    ]


def _brief(event: dict) -> dict | None:
    brief = event.get("brief")
    if brief is None:
        return None
    errors = validate_brief(brief)
    if errors:
        raise ToolError("; ".join(errors[:3]))
    return brief


def project_save(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    status = event.get("status")
    if status not in STATUSES:
        raise ToolError(f"status must be one of {sorted(STATUSES)}")
    tbl = store.table()
    meta = store.get_meta(pid)
    brief = _brief(event)

    if meta is None:
        if status not in ("draft", "running"):
            raise ToolError(f"Project {pid} does not exist; create it with status 'running' or 'draft'")
        topic = event.get("topic")
        if not (isinstance(topic, str) and 3 <= len(topic) <= 300):
            raise ToolError("topic (3-300 chars) is required when creating a project")
        parent = event.get("parentProjectId")
        if parent is not None:
            require_project_id(event, "parentProjectId")
            require_owner(parent, sub)
        now = store.now_iso()
        meta = {
            "PK": store.project_pk(pid), "SK": "META", "projectId": pid, "owner": sub, "topic": topic,
            "status": status, "parentProjectId": parent, "createdAt": now, "updatedAt": now, "findingCount": 0,
            "createdEpoch": store.epoch(), "startedEpoch": store.epoch(), "ownerSk": f"PROJECT#{now}#{pid}",
            "runtimeSessionId": event.get("runtimeSessionId"), "version": 1,
        }
        if brief is not None:
            meta["brief"] = brief
        tbl.put_item(Item=meta, ConditionExpression="attribute_not_exists(PK)")
        tbl.put_item(Item={"PK": f"OWNER#{sub}", "SK": meta["ownerSk"], "projectId": pid})
        store.put_json(f"{store.project_prefix(pid)}manifest.json", meta)
        appsync.publish(pid, [("project.created", {"topic": topic, "parentProjectId": parent, "status": status})])
        return {"ok": True, "project": _public(meta), "created": True, "steering": []}

    if meta.get("owner") != sub:
        raise ToolError(f"Project {pid} belongs to another user")
    _refuse_final(pid, meta)

    previous = meta.get("status")
    now = store.now_iso()
    updates: dict[str, Any] = {"status": status, "updatedAt": now}
    started: dict[str, Any] | None = None
    if status == "draft" and previous != "draft":
        raise ToolError(f"Project {pid} is {previous}; only a new project can be a draft")
    topic = event.get("topic")
    if previous == "draft" and isinstance(topic, str) and 3 <= len(topic) <= 300 and topic != meta.get("topic"):
        updates["topic"] = topic  # the question may still change while the plan is reviewed
    if status == "running" and previous != "running":
        if previous == "draft":
            started = {"version": int(meta.get("version") or 1), "mode": "full", "since": None}
        elif previous == "completed" and event.get("reopen") is True:
            since = str(meta.get("completedAt") or meta.get("updatedAt") or now)[:10]
            started = {"version": int(meta.get("version") or 1) + 1, "mode": "incremental", "since": since}
            updates.update({"version": started["version"], "since": since})
        else:
            hint = "; pass reopen: true to re-run it for newer data" if previous == "completed" else ""
            raise ToolError(f"Project {pid} is {previous} and cannot run again{hint}")
        updates["startedEpoch"] = store.epoch()
    if status in ("completed", "failed") and previous not in ("running", status):
        raise ToolError(f"Project {pid} is {previous}; only a running project can become {status}")
    if brief is not None:
        updates["brief"] = brief
    if event.get("runtimeSessionId"):
        updates["runtimeSessionId"] = event["runtimeSessionId"]
    if status == "completed" and previous != "completed":
        updates["completedAt"] = now
    try:
        tbl.update_item(
            Key={"PK": store.project_pk(pid), "SK": "META"},
            UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in updates),
            # Atomic with project_stop: a stop that lands between the read above and this write wins.
            ConditionExpression="NOT #status IN (:f0, :f1, :f2)",
            ExpressionAttributeNames={f"#{k}": k for k in updates},
            ExpressionAttributeValues={**{f":{k}": store.to_ddb(v) for k, v in updates.items()},
                                       **{f":f{i}": v for i, v in enumerate(FINAL)}},
        )
    except ClientError as err:
        if err.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        _refuse_final(pid, store.get_meta(pid) or {"status": "archived"})
        raise
    meta.update(updates)
    saved: list[str] = []
    if started is not None:
        appsync.publish(pid, [("project.started", started)])
    if status == "completed":
        stats = _stats(pid)
        stats["elapsedSec"] = max(0, store.epoch() - int(meta.get("startedEpoch") or meta.get("createdEpoch") or store.epoch()))
        _set(pid, stats=stats)
        meta["stats"] = stats
        saved = _snapshot(pid, meta)
        if previous != "completed":
            appsync.publish(pid, [("project.completed", {"stats": stats})])
            notify.project_ended(meta, "completed")
    elif status == "failed" and previous != "failed":
        message = str(event.get("message") or "Research failed")[:500]
        appsync.publish(pid, [("project.failed", {"message": message})])
        notify.project_ended(meta, "failed", message)
    out: dict[str, Any] = {"ok": True, "project": _public(meta), "saved": saved}
    if status == "running":
        out["steering"] = _steering(pid)  # the runtime's heartbeat picks up the user's directions here
    return out


def _set(pid: str, **values: Any) -> None:
    store.table().update_item(
        Key={"PK": store.project_pk(pid), "SK": "META"},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in values),
        ExpressionAttributeNames={f"#{k}": k for k in values},
        ExpressionAttributeValues={f":{k}": store.to_ddb(v) for k, v in values.items()},
    )


def _steering(pid: str) -> list[dict]:
    keys = ("steerId", "kind", "text", "createdAt", "appliedRound")
    return [{k: i.get(k) for k in keys if i.get(k) is not None} for i in store.query_project(pid, "STEER#")]


def _refuse_final(pid: str, meta: dict) -> None:
    if meta.get("status") == "stopped":
        raise ProjectStopped(f"Project {pid} was stopped")
    if meta.get("status") in ("archiving", "archived"):
        raise ToolError(f"Project {pid} is {meta['status']}")


def project_stop(event: dict) -> dict:
    """Stop a running project for good. Idempotent: `stopped` is true only for the call that did it.

    This is the durable half of a stop. The research runtime is told separately (action "stop" on the
    agents gateway) so it cancels its agents at once; if that message never arrives, the runtime's
    next heartbeat project_save is refused with `stopped: true` and it stops itself."""
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_owner(pid, sub)
    session = meta.get("runtimeSessionId")
    if meta.get("status") != "running":
        return {"ok": True, "project": _public(meta), "stopped": False, "runtimeSessionId": session}
    now = store.now_iso()
    try:
        store.table().update_item(
            Key={"PK": store.project_pk(pid), "SK": "META"},
            UpdateExpression="SET #s = :stopped, updatedAt = :now, stoppedAt = :now",
            ConditionExpression="#s = :running",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":stopped": "stopped", ":running": "running", ":now": now},
        )
    except ClientError as err:
        if err.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        meta = store.get_meta(pid) or meta  # it completed, failed or was stopped a moment ago
        return {"ok": True, "project": _public(meta), "stopped": False, "runtimeSessionId": session}
    meta.update({"status": "stopped", "updatedAt": now, "stoppedAt": now})
    stats = _stats(pid)
    stats["elapsedSec"] = max(0, store.epoch() - int(meta.get("startedEpoch") or meta.get("createdEpoch") or store.epoch()))
    _set(pid, stats=stats)
    meta["stats"] = stats
    saved = _snapshot(pid, meta)  # keep S3 consistent with what was finished before the stop
    appsync.publish(pid, [("project.stopped", {"stats": stats})])
    return {"ok": True, "project": _public(meta), "stopped": True, "runtimeSessionId": session, "saved": saved}


def _public(meta: dict) -> dict:
    keys = ("projectId", "topic", "status", "parentProjectId", "createdAt", "updatedAt", "findingCount")
    out = {k: store.to_plain(meta.get(k)) for k in keys}
    out["version"] = int(store.to_plain(meta.get("version")) or 1)
    out["notify"] = bool(meta.get("notify"))
    for key in ("since", "completedAt", "stoppedAt", "brief", "stats"):
        if meta.get(key) is not None:
            out[key] = store.to_plain(meta[key])
    return out


def project_steer(event: dict) -> dict:
    """The user redirects a running project, or asks it to wrap up with what it has. The runtime's
    heartbeat (project_save) returns every steer, and the run applies new ones at its next step."""
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_owner(pid, sub)
    if meta.get("status") != "running":
        raise ToolError(f"Project {pid} is {meta.get('status')}; only a running project can be steered")
    kind = event.get("kind")
    if kind not in STEER_KINDS:
        raise ToolError(f"kind must be one of {sorted(STEER_KINDS)}")
    text = event.get("text") or ""
    if kind == "redirect" and not (isinstance(text, str) and 3 <= len(text.strip()) <= 500):
        raise ToolError("text (3-500 chars) is required to redirect the research")
    if not isinstance(text, str) or len(text) > 500:
        raise ToolError("text must be at most 500 chars")
    if len(store.query_project(pid, "STEER#")) >= MAX_STEERS:
        raise ToolError(f"At most {MAX_STEERS} directions per run")
    now = store.now_iso()
    steer = {"steerId": f"s-{secrets.token_hex(5)}", "kind": kind, "text": text.strip(), "createdAt": now}
    store.table().put_item(Item={"PK": store.project_pk(pid), "SK": f"STEER#{now}#{steer['steerId']}", **steer})
    appsync.publish(pid, [("steer.received", {"steer": steer})])
    return {"ok": True, "steer": steer}


def project_notify(event: dict) -> dict:
    """Turn the email at the end of a run on or off for this project."""
    sub = caller(event)
    pid = require_project_id(event)
    require_owner(pid, sub)
    enabled = event.get("enabled")
    if not isinstance(enabled, bool):
        raise ToolError("enabled must be true or false")
    available = notify.available()
    if enabled and not available:
        return {"ok": True, "notify": False, "available": False}
    _set(pid, notify=enabled)
    return {"ok": True, "notify": enabled, "available": available}


def project_list(event: dict) -> dict:
    sub = caller(event)
    page = store.table().query(KeyConditionExpression=Key("PK").eq(f"OWNER#{sub}"), ScanIndexForward=False, Limit=50)
    ids = [i["projectId"] for i in page.get("Items", [])]
    if not ids:
        return {"ok": True, "projects": []}
    res = boto3.resource("dynamodb").batch_get_item(
        RequestItems={os.environ["TABLE_NAME"]: {"Keys": [{"PK": store.project_pk(p), "SK": "META"} for p in ids]}}
    )
    metas = {m["projectId"]: m for m in res["Responses"].get(os.environ["TABLE_NAME"], [])}
    projects = [_public(store.to_plain(metas[p])) for p in ids if p in metas and metas[p].get("status") != "archived"]
    for proj in projects:
        proj.pop("brief", None)  # the list stays small; project_get has it
    return {"ok": True, "projects": projects}


def project_get(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_owner(pid, sub)
    items = store.query_project(pid)
    plan = next((i.get("subQuestions", []) for i in items if i["SK"] == "PLAN"), [])
    findings = [i["finding"] for i in items if i["SK"].startswith("FINDING#")]
    ui_specs = {i["SK"][3:]: {"spec": i["spec"], "cache": bool(i.get("cache"))} for i in items if i["SK"].startswith("UI#")}
    entities = [{"id": i["SK"][7:], "name": i.get("name"), "type": i.get("type")} for i in items if i["SK"].startswith("ENTITY#")]
    edges = [{k: i[k] for k in ("from", "to", "type", "via") if k in i} for i in items if i["SK"].startswith("EDGE#")]
    synthesis = next(({k: i.get(k) for k in ("report", "contradictions", "gaps", "followUps", "createdAt", "citations", "verification",
                                              "version", "changes")
                       if k in i or k in ("report", "contradictions", "gaps", "followUps", "createdAt")}
                      for i in items if i["SK"] == "SYNTHESIS"), None)
    requirements = next((i.get("requirements", []) for i in items if i["SK"] == "PLAN"), [])
    coverage = next(({k: i.get(k) for k in ("round", "requirements", "updatedAt")} for i in items if i["SK"] == "COVERAGE"), None)
    doc_keys = ("docId", "url", "canonicalUrl", "title", "publisher", "publishedDate", "sourceType", "score", "duplicateOf", "via", "fetchedAt")
    docs = [{k: i.get(k) for k in doc_keys} for i in items if i["SK"].startswith("DOC#") and i.get("status") == "ok"]
    proposed = next(({k: i.get(k) for k in ("subQuestions", "requirements", "by", "updatedAt")} for i in items if i["SK"] == "PROPOSED"), None)
    history = sorted(({k: i.get(k) for k in ("version", "createdAt", "report")} for i in items if i["SK"].startswith("SYNTHESIS#V")),
                     key=lambda h: h.get("version") or 0)
    steering = [{k: i.get(k) for k in ("steerId", "kind", "text", "createdAt", "appliedRound") if i.get(k) is not None}
                for i in items if i["SK"].startswith("STEER#")]
    qa_keys = ("qaId", "question", "selection", "answer", "citations", "needsResearch", "researchQuestion", "createdAt")
    qa = [{k: i.get(k) for k in qa_keys if i.get(k) is not None} for i in items if i["SK"].startswith("QA#")]
    return {"ok": True, "project": _public(meta), "plan": plan, "proposedPlan": proposed, "requirements": requirements,
            "findings": findings, "uiSpecs": ui_specs, "entities": entities, "edges": edges, "docs": docs, "coverage": coverage,
            "synthesis": synthesis, "history": history, "steering": steering, "qa": qa}


def project_restart(event: dict) -> dict:
    sub = caller(event)
    parent = require_project_id(event, "parentProjectId")
    meta = require_owner(parent, sub)
    return {"ok": True, "projectId": new_project_id(), "parentProjectId": parent, "topic": meta["topic"]}


def project_cleanup(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_owner(pid, sub)
    if meta.get("status") in ("archiving", "archived"):
        return {"ok": True, "projectId": pid, "status": meta["status"], "executionArn": None}
    if meta.get("status") == "running":
        raise ToolError(f"Project {pid} is still running; stop it first with project_stop")
    store.table().update_item(
        Key={"PK": store.project_pk(pid), "SK": "META"},
        UpdateExpression="SET #s = :s, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "archiving", ":u": store.now_iso()},
    )
    execution = _sfn.start_execution(
        stateMachineArn=os.environ["CLEANUP_STATE_MACHINE_ARN"],
        name=f"cleanup-{pid}-{secrets.token_hex(3)}",
        input=json.dumps({"projectId": pid, "owner": sub}),
    )
    return {"ok": True, "projectId": pid, "status": "archiving", "executionArn": execution["executionArn"]}


HANDLERS = {
    "project_save": project_save,
    "project_stop": project_stop,
    "project_steer": project_steer,
    "project_notify": project_notify,
    "project_list": project_list,
    "project_get": project_get,
    "project_restart": project_restart,
    "project_cleanup": project_cleanup,
}


def handler(event: dict, context: Any) -> dict:
    return dispatch(HANDLERS, event, context)
