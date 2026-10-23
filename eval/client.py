"""Talks to a deployed God Eye the way the web app does: start a run on the agents gateway, then
read the project back through the tools gateway (MCP over Streamable HTTP) until it finishes."""
from __future__ import annotations

import json
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

MCP_PROTOCOL_VERSION = "2025-06-18"
FINAL = {"completed", "failed", "stopped", "archived"}


def new_project_id() -> str:
    return f"p-{datetime.now(timezone.utc):%Y%m%d}-{secrets.token_hex(4)}"


def parse_rpc_body(text: str, content_type: str, rpc_id: int) -> Optional[dict]:
    """The JSON-RPC response with this id, from a JSON body or an SSE stream."""
    def pick(value: Any) -> Optional[dict]:
        candidates = value if isinstance(value, list) else [value]
        for v in reversed(candidates):
            if isinstance(v, dict) and ("result" in v or "error" in v) and v.get("id") in (rpc_id, None):
                return v
        return None

    body = text.strip()
    if "text/event-stream" not in (content_type or "") and not body.startswith(("event:", "data:", "id:")):
        try:
            return pick(json.loads(body))
        except ValueError:
            return None
    found = None
    for block in body.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(line[5:].lstrip(" ") for line in block.split("\n") if line.startswith("data:"))
        if data:
            try:
                found = pick(json.loads(data)) or found
            except ValueError:
                continue
    return found


class McpClient:
    def __init__(self, url: str, token: str):
        self.url, self.token = url, token
        self.session: Optional[str] = None
        self.seq = 0

    def _post(self, body: dict, expect: bool) -> Optional[dict]:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": f"Bearer {self.token}"}
        if self.session:
            headers.update({"Mcp-Session-Id": self.session, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION})
        req = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - the deployment's own gateway
                self.session = resp.headers.get("Mcp-Session-Id") or self.session
                text, ctype = resp.read().decode("utf-8"), resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            if err.code == 404 and self.session:
                self.session = None
            raise RuntimeError(f"MCP HTTP {err.code}: {err.read().decode('utf-8', 'replace')[:300]}") from err
        if not expect:
            return None
        parsed = parse_rpc_body(text, ctype, body["id"])
        if not parsed:
            raise RuntimeError("could not parse the MCP response")
        if parsed.get("error"):
            raise RuntimeError(f"MCP {parsed['error'].get('code')}: {parsed['error'].get('message')}")
        return parsed

    def _init(self) -> None:
        if self.session:
            return
        self.seq += 1
        self._post({"jsonrpc": "2.0", "id": self.seq, "method": "initialize",
                    "params": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
                               "clientInfo": {"name": "god-eye-eval", "version": "0.1.0"}}}, True)
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, False)

    def call(self, name: str, arguments: dict) -> dict:
        self._init()
        self.seq += 1
        res = self._post({"jsonrpc": "2.0", "id": self.seq, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, True)
        result = (res or {}).get("result") or {}
        text = next((c.get("text") for c in result.get("content", []) if c.get("type") == "text"), None)
        value: Any = result.get("structuredContent") if text is None else text
        if isinstance(value, str):
            value = json.loads(value)
            if isinstance(value, str):
                value = json.loads(value)
        if result.get("isError") or (isinstance(value, dict) and value.get("ok") is False):
            raise RuntimeError(f"{name}: {value}")
        return value


def start_research(agents_base: str, token: str, project_id: str, topic: str, brief: dict) -> dict:
    body = {"action": "start", "projectId": project_id, "topic": topic, **brief}
    req = urllib.request.Request(
        agents_base.rstrip("/") + "/research/invocations", data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                 "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": f"sess-{project_id}-{secrets.token_hex(16)}"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def wait_for(mcp: McpClient, project_id: str, timeout_sec: float, poll_sec: float = 20.0) -> dict:
    deadline = time.time() + timeout_sec
    last: dict = {}
    while time.time() < deadline:
        try:
            last = mcp.call("project-tools___project_get", {"projectId": project_id})
        except RuntimeError as err:
            if "not found" not in str(err):  # the runtime creates the project a moment after the start call
                raise
        if (last.get("project") or {}).get("status") in FINAL:
            return last
        time.sleep(poll_sec)
    return last
