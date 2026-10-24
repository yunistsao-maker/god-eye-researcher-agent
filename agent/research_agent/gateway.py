"""Thin client for the tools gateway (MCP). Deterministic steps call tools directly; research
sub-agents get the web tools as Strands tools from the same MCP connection."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from strands.tools.mcp import MCPClient

log = logging.getLogger(__name__)


class ToolCallError(RuntimeError):
    """A tool failed. `stopped` is true when the tool refused because the user stopped the project."""

    def __init__(self, message: str, *, stopped: bool = False):
        super().__init__(message)
        self.stopped = stopped


def check_result(name: str, payload: dict) -> dict:
    """Turn a business error ({ok: false, error}) into ToolCallError. Validation results such as
    finding_write's {ok: false, errors} are returned for the caller to handle."""
    if payload.get("ok") is False and "error" in payload:
        raise ToolCallError(f"{name}: {payload['error']}", stopped=payload.get("stopped") is True)
    return payload


class ToolsGateway:
    """Calls `{target}___{tool}` on the tools gateway with the end user's JWT, so the gateway's
    interceptor attributes every call to that user."""

    def __init__(self, url: str, bearer_token: str):
        self._client = MCPClient(url=url, headers={"Authorization": f"Bearer {bearer_token}"}, startup_timeout=30)

    def __enter__(self) -> "ToolsGateway":
        self._client.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._client.stop(None, None, None)

    def call(self, target: str, tool: str, **arguments: Any) -> dict:
        name = f"{target}___{tool}"
        # The gateway validates arguments against the tool schema and rejects null for typed fields
        # (e.g. parentProjectId on a new project). The Lambdas treat a missing argument as None.
        arguments = {k: v for k, v in arguments.items() if v is not None}
        result = self._client.call_tool_sync(f"call-{uuid.uuid4().hex[:12]}", name, arguments)
        text = "".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
        if result.get("status") == "error" or result.get("isError"):
            raise ToolCallError(f"{name} failed: {text[:500]}")
        structured = result.get("structuredContent")
        payload = structured if isinstance(structured, dict) else _parse(text)
        return check_result(name, payload)

    def web_tools(self) -> list:
        """The gateway tools research depends on, checked at start-up (they are called through `call`)."""
        tools = self._client.list_tools_sync()
        picked = [t for t in tools if t.tool_name in RESEARCH_TOOLS]
        missing = RESEARCH_TOOLS - {t.tool_name for t in picked}
        if missing:
            raise ToolCallError(f"tools gateway is missing {sorted(missing)}; re-run scripts/deploy_agentcore.py")
        return picked


# Names as the tools gateway lists them: {target}___{tool}. Research sub-agents never get these
# directly; research_tools.py wraps them (web_search, read_page) and calls them through `call`.
WEB_SEARCH_TOOL = "web-search___WebSearch"
FETCH_PAGE_TOOL = "web-tools___fetch_page"
SEARCH_WEB_TOOL = "web-tools___search_web"
URL_CHECK_TOOL = "web-tools___url_check"
RESEARCH_TOOLS = {WEB_SEARCH_TOOL, FETCH_PAGE_TOOL, SEARCH_WEB_TOOL, URL_CHECK_TOOL}


def _parse(text: str) -> dict:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}
    # Some gateways wrap the Lambda result once more as a JSON string.
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {"text": value}
    return value if isinstance(value, dict) else {"value": value}
