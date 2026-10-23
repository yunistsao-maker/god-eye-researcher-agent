"""project-tools target: project_save, project_stop, project_list, project_get, project_restart,
project_cleanup.

These are deterministic operations. The frontend calls them directly through the tools
gateway (no LLM involved); the supervisor agent calls project_save (and project_stop when it is
asked to stop) as well.
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

from common import appsync, store
from common.toolkit import ProjectStopped, ToolError, caller, dispatch, require_owner, require_project_id

_sfn = boto3.client("stepfunctions")

STATUSES = {"running", "completed", "failed"}   # what project_save may set; `stopped` comes from project_stop
FINAL = ("stopped", "archiving", "archived")      # project_save never overwrites these


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


def project_save(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    status = event.get("status")
    if status not in STATUSES:
        raise ToolError(f"status must be one of {sorted(STATUSES)}")
    tbl = store.table()
    meta = store.get_meta(pid)

    if meta is None:
        if status != "running":
            raise ToolError(f"Project {pid} does not exist; create it with status 'running'")
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
            "status": "running", "parentProjectId": parent, "createdAt": now, "updatedAt": now, "findingCount": 0,
            "createdEpoch": store.epoch(), "ownerSk": f"PROJECT#{now}#{pid}",
            "runtimeSessionId": event.get("runtimeSessionId"),
        }
        tbl.put_item(Item=meta, ConditionExpression="attribute_not_exists(PK)")
        tbl.put_item(Item={"PK": f"OWNER#{sub}", "SK": meta["ownerSk"], "projectId": pid})
        store.put_json(f"{store.project_prefix(pid)}manifest.json", meta)
        appsync.publish(pid, [("project.created", {"topic": topic, "parentProjectId": parent})])
        return {"ok": True, "project": _public(meta), "created": True}

    if meta.get("owner") != sub:
        raise ToolError(f"Project {pid} belongs to another user")
    _refuse_final(pid, meta)

    previous = meta.get("status")
    updates = {"status": status, "updatedAt": store.now_iso()}
    if event.get("runtimeSessionId"):
        updates["runtimeSessionId"] = event["runtimeSessionId"]
    try:
        tbl.update_item(
            Key={"PK": store.project_pk(pid), "SK": "META"},
            UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in updates),
            # Atomic with project_stop: a stop that lands between the read above and this write wins.
            ConditionExpression="NOT #status IN (:f0, :f1, :f2)",
            ExpressionAttributeNames={f"#{k}": k for k in updates},
            ExpressionAttributeValues={**{f":{k}": v for k, v in updates.items()},
                                       **{f":f{i}": v for i, v in enumerate(FINAL)}},
        )
    except ClientError as err:
        if err.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        _refuse_final(pid, store.get_meta(pid) or {"status": "archived"})
        raise
    meta.update(updates)
    saved: list[str] = []
    if status == "completed":
        stats = _stats(pid)
        stats["elapsedSec"] = max(0, store.epoch() - int(meta.get("createdEpoch", store.epoch())))
        saved = _snapshot(pid, meta)
        if previous != "completed":
            appsync.publish(pid, [("project.completed", {"stats": stats})])
    elif status == "failed" and previous != "failed":
        appsync.publish(pid, [("project.failed", {"message": str(event.get("message") or "Research failed")[:500]})])
    return {"ok": True, "project": _public(meta), "saved": saved}


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
    stats["elapsedSec"] = max(0, store.epoch() - int(meta.get("createdEpoch", store.epoch())))
    saved = _snapshot(pid, meta)  # keep S3 consistent with what was finished before the stop
    appsync.publish(pid, [("project.stopped", {"stats": stats})])
    return {"ok": True, "project": _public(meta), "stopped": True, "runtimeSessionId": session, "saved": saved}


def _public(meta: dict) -> dict:
    keys = ("projectId", "topic", "status", "parentProjectId", "createdAt", "updatedAt", "findingCount")
    return {k: store.to_plain(meta.get(k)) for k in keys}


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
    synthesis = next(({k: i.get(k) for k in ("report", "contradictions", "gaps", "followUps", "createdAt", "citations", "verification")
                       if k in i or k in ("report", "contradictions", "gaps", "followUps", "createdAt")}
                      for i in items if i["SK"] == "SYNTHESIS"), None)
    requirements = next((i.get("requirements", []) for i in items if i["SK"] == "PLAN"), [])
    coverage = next(({k: i.get(k) for k in ("round", "requirements", "updatedAt")} for i in items if i["SK"] == "COVERAGE"), None)
    doc_keys = ("docId", "url", "canonicalUrl", "title", "publisher", "publishedDate", "sourceType", "score", "duplicateOf", "via", "fetchedAt")
    docs = [{k: i.get(k) for k in doc_keys} for i in items if i["SK"].startswith("DOC#") and i.get("status") == "ok"]
    return {"ok": True, "project": _public(meta), "plan": plan, "requirements": requirements, "findings": findings, "uiSpecs": ui_specs,
            "entities": entities, "edges": edges, "docs": docs, "coverage": coverage, "synthesis": synthesis}


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
    "project_list": project_list,
    "project_get": project_get,
    "project_restart": project_restart,
    "project_cleanup": project_cleanup,
}


def handler(event: dict, context: Any) -> dict:
    return dispatch(HANDLERS, event, context)
