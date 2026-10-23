"""Shared plumbing for Lambda functions behind AgentCore Gateway MCP targets.

The gateway invokes the Lambda with the tool arguments as the event and puts the tool
name in context.client_context.custom['bedrockAgentCoreToolName'] as '{target}___{tool}'.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

from . import store

log = logging.getLogger()
log.setLevel(logging.INFO)

PROJECT_ID = re.compile(r"^p-[a-z0-9-]{4,60}$")
FINDING_ID = re.compile(r"^f-[a-z0-9-]{1,40}$")


class ToolError(Exception):
    """A business error returned to the caller as {ok: false, error}."""

    stopped = False


class ProjectStopped(ToolError):
    """The user stopped the project; returned as {ok: false, error, stopped: true} so the research
    runtime can tell "stop now" apart from an ordinary tool error."""

    stopped = True


def tool_name(context: Any, event: dict) -> str:
    name = ""
    try:
        name = context.client_context.custom["bedrockAgentCoreToolName"]
    except Exception:  # noqa: BLE001 - local tests pass the name in the event
        name = event.get("__tool", "")
    return name.split("___", 1)[-1]


def caller(event: dict) -> str:
    sub = event.get("_caller")
    if not isinstance(sub, str) or not sub:
        raise ToolError("Missing caller identity. Calls must come through the tools gateway.")
    return sub


def require_project_id(event: dict, key: str = "projectId") -> str:
    pid = event.get(key)
    if not isinstance(pid, str) or not PROJECT_ID.match(pid):
        raise ToolError(f"{key} must match {PROJECT_ID.pattern}")
    return pid


def require_owner(project_id: str, sub: str) -> dict:
    meta = store.get_meta(project_id)
    if not meta:
        raise ToolError(f"Project {project_id} not found")
    if meta.get("owner") != sub:
        raise ToolError(f"Project {project_id} belongs to another user")
    return meta


def require_writable(project_id: str, sub: str) -> dict:
    """Owner check for writes: a stopped or archived project never changes again."""
    meta = require_owner(project_id, sub)
    status = meta.get("status")
    if status == "stopped":
        raise ProjectStopped(f"Project {project_id} was stopped")
    if status in ("archiving", "archived"):
        raise ToolError(f"Project {project_id} is {status}")
    return meta


def dispatch(handlers: dict[str, Callable[[dict], dict]], event: dict, context: Any) -> dict:
    name = tool_name(context, event)
    fn = handlers.get(name)
    if not fn:
        return {"ok": False, "error": f"Unknown tool '{name}'"}
    try:
        result = fn(event)
        log.info(json.dumps({"tool": name, "ok": result.get("ok", True)}))
        return result
    except ToolError as err:
        log.info(json.dumps({"tool": name, "ok": False, "error": str(err)}))
        out: dict[str, Any] = {"ok": False, "error": str(err)}
        if err.stopped:
            out["stopped"] = True
        return out
