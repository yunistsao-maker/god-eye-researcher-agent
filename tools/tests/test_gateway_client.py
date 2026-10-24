"""The runtime's tools-gateway client: what it actually sends to the gateway."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent.gateway import ToolsGateway  # noqa: E402


class RecordingClient:
    def __init__(self):
        self.calls = []

    def call_tool_sync(self, call_id, name, arguments):
        self.calls.append((name, arguments))
        return {"status": "success", "structuredContent": {"ok": True}}


def test_none_arguments_are_not_sent():
    """The gateway rejects null for typed schema fields: a new project's project_save without a
    parent failed with "Field '/parentProjectId' has invalid type: null found, string expected"."""
    gw = ToolsGateway.__new__(ToolsGateway)
    gw._client = RecordingClient()
    gw.call("project-tools", "project_save", projectId="p-1", status="draft", parentProjectId=None, brief={"depth": "standard"})
    assert gw._client.calls == [("project-tools___project_save", {"projectId": "p-1", "status": "draft", "brief": {"depth": "standard"}})]
