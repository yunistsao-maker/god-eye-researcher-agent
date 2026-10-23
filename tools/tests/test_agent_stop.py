"""The runtime's side of stopping a run: the `stop` action, the heartbeat fallback, and the
StopRuntimeSession call that ends the AgentCore session with the user's bearer token."""
import base64
import io
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent import main  # noqa: E402
from research_agent.gateway import ToolCallError  # noqa: E402
from research_agent.stopping import StopSessionError, StopSignal, jwt_subject, stop_runtime_session  # noqa: E402
from research_agent.watch import Tracker  # noqa: E402

PID = "p-20261022-0a0b0c0d"
ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/god_eye_research-abc"
RUN_SESSION = "r" * 40
OTHER_SESSION = "o" * 40


def token(sub):
    part = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{part({'alg': 'RS256'})}.{part({'sub': sub, 'client_id': 'c'})}.sig"


def context(sub="sub-alice", session=RUN_SESSION):
    return SimpleNamespace(request_headers={"Authorization": f"Bearer {token(sub)}"}, session_id=session)


# --- StopRuntimeSession over HTTPS with a bearer token ---------------------------------------------

class Opener:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, int):
            raise HTTPError(request.full_url, outcome, "err", {}, io.BytesIO(b'{"message":"x"}'))
        return io.BytesIO(b"{}")


def test_stop_runtime_session_request_shape():
    opener = Opener("ok")
    assert stop_runtime_session(ARN, RUN_SESSION, "tok", "us-west-2", opener=opener) == "stopped"
    req = opener.requests[0]
    assert req.get_method() == "POST"
    assert req.full_url == ("https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/"
                            "arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A111122223333%3Aruntime%2Fgod_eye_research-abc"
                            "/stopruntimesession?qualifier=DEFAULT")
    headers = {k.lower(): v for k, v in req.header_items()}
    assert headers["authorization"] == "Bearer tok"
    assert headers["x-amzn-bedrock-agentcore-runtime-session-id"] == RUN_SESSION
    assert 33 <= len(json.loads(req.data)["clientToken"]) <= 256


def test_stop_runtime_session_retries_conflicts_with_one_client_token():
    opener = Opener(409, 409, "ok")
    assert stop_runtime_session(ARN, RUN_SESSION, "tok", "us-west-2", opener=opener, sleep=lambda s: None) == "stopped"
    assert len({r.data for r in opener.requests}) == 1, "retries reuse the idempotency token"


def test_stop_runtime_session_outcomes():
    assert stop_runtime_session(ARN, RUN_SESSION, "tok", "us-west-2", opener=Opener(404)) == "not_found"
    with pytest.raises(StopSessionError, match="403"):
        stop_runtime_session(ARN, RUN_SESSION, "tok", "us-west-2", opener=Opener(403))
    with pytest.raises(StopSessionError):
        stop_runtime_session("", RUN_SESSION, "tok", "us-west-2", opener=Opener("ok"))


def test_jwt_subject():
    assert jwt_subject(token("sub-alice")) == "sub-alice"
    assert jwt_subject("not-a-jwt") == "" and jwt_subject("a.@@@.c") == ""


# --- the `stop` action ------------------------------------------------------------------------------

class StubGateway:
    """ToolsGateway stand-in: project_stop answers as the Lambda would, or fails like a gateway error."""

    calls = []
    answer = {"ok": True, "stopped": True, "runtimeSessionId": RUN_SESSION}
    fail = None

    def __init__(self, url, bearer):
        self.bearer = bearer

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None

    def call(self, target, tool, **args):
        StubGateway.calls.append((tool, args, jwt_subject(self.bearer)))
        if StubGateway.fail:
            raise StubGateway.fail
        return StubGateway.answer


@pytest.fixture()
def runtime(monkeypatch):
    StubGateway.calls, StubGateway.answer, StubGateway.fail = [], {"ok": True, "stopped": True, "runtimeSessionId": RUN_SESSION}, None
    monkeypatch.setattr(main, "ToolsGateway", StubGateway)
    monkeypatch.setattr(main, "TOOLS_GATEWAY_URL", "https://tools.example/mcp")
    monkeypatch.setattr(main, "END_DELAY_SEC", 0)
    monkeypatch.setenv("RESEARCH_RUNTIME_ARN", ARN)
    terminated, ended = [], threading.Event()

    def fake_stop(arn, session, bearer, region, **kw):
        terminated.append((arn, session, jwt_subject(bearer)))
        ended.set()
        return "stopped"

    monkeypatch.setattr(main, "stop_runtime_session", fake_stop)
    main._runs.clear()
    yield SimpleNamespace(terminated=terminated, ended=ended)
    main._runs.clear()


def local_run(sub="sub-alice"):
    run = main.Run(PID, RUN_SESSION, sub, StopSignal(Tracker(lambda t, d: None)))
    main._register(run)
    return run


def test_stop_cancels_a_run_in_this_session(runtime):
    run = local_run()
    out = main.invoke({"action": "stop", "projectId": PID}, context())
    assert out == {"projectId": PID, "status": "stopping"}
    assert run.stop.is_set and run.stop.reason == "stopped by the user"
    assert run.stop.token == token("sub-alice"), "the stop request's (fresh) token ends the session later"
    assert StubGateway.calls == [("project_stop", {"projectId": PID}, "sub-alice")]
    # the run thread ends the session after it unwinds; the stop handler does not kill it mid-run
    assert not runtime.ended.wait(0.3)
    run.done.set()  # the run unwound: the deadline thread stands down


def test_a_run_that_does_not_unwind_is_ended_anyway(runtime, monkeypatch):
    monkeypatch.setattr(main, "UNWIND_SEC", 0.1)
    local_run()
    main.invoke({"action": "stop", "projectId": PID}, context())
    assert runtime.ended.wait(3)
    assert runtime.terminated == [(ARN, RUN_SESSION, "sub-alice")]


def test_stop_reaching_another_session_terminates_the_run_session(runtime):
    out = main.invoke({"action": "stop", "projectId": PID}, context(session=OTHER_SESSION))
    assert out == {"projectId": PID, "status": "terminated"}
    assert runtime.ended.wait(3)
    sessions = [s for _, s, _ in runtime.terminated]
    assert sessions[0] == RUN_SESSION                      # the run's session, at once
    for _ in range(30):                                     # then the session this request opened
        if len(sessions) > 1:
            break
        threading.Event().wait(0.05)
        sessions = [s for _, s, _ in runtime.terminated]
    assert sessions == [RUN_SESSION, OTHER_SESSION]


def test_stop_of_a_finished_run_only_ends_this_session(runtime):
    StubGateway.answer = {"ok": True, "stopped": False, "runtimeSessionId": RUN_SESSION}
    out = main.invoke({"action": "stop", "projectId": PID}, context())
    assert out == {"projectId": PID, "status": "not_running"}
    assert runtime.ended.wait(3) and runtime.terminated == [(ARN, RUN_SESSION, "sub-alice")]


def test_another_user_cannot_stop_a_run(runtime):
    run = local_run(sub="sub-alice")
    StubGateway.fail = ToolCallError("project-tools___project_stop: Project belongs to another user")
    out = main.invoke({"action": "stop", "projectId": PID}, context(sub="sub-bob"))
    assert "error" in out and not run.stop.is_set
    assert not runtime.ended.wait(0.3) and runtime.terminated == []


def test_the_run_owner_can_stop_even_when_the_tools_gateway_is_down(runtime):
    run = local_run(sub="sub-alice")
    StubGateway.fail = ToolCallError("tools gateway unreachable")
    assert main.invoke({"action": "stop", "projectId": PID}, context())["status"] == "stopping"
    assert run.stop.is_set
    run.done.set()


def test_a_session_shared_with_another_run_is_not_ended(runtime):
    other = main.Run("p-20261022-ffffffff", RUN_SESSION, "sub-alice", StopSignal())
    main._register(other)
    StubGateway.answer = {"ok": True, "stopped": False, "runtimeSessionId": RUN_SESSION}
    main.invoke({"action": "stop", "projectId": PID}, context())
    assert not runtime.ended.wait(0.3), "ending the session would kill the other project's run"


def test_unknown_actions_and_bad_ids_are_refused(runtime):
    assert "error" in main.invoke({"action": "pause", "projectId": PID}, context())
    assert "error" in main.invoke({"action": "stop", "projectId": "../x"}, context())


# --- fallback: the heartbeat notices a stop made elsewhere ------------------------------------------

def test_heartbeat_turns_a_stopped_refusal_into_a_stop():
    class Gw:
        def __init__(self, error):
            self.error = error

        def call(self, *a, **k):
            if self.error:
                raise self.error
            return {"ok": True}

    noticed = []
    main._heartbeat(Gw(None), PID, lambda: noticed.append(1))()
    assert noticed == []
    main._heartbeat(Gw(ToolCallError("x", stopped=True)), PID, lambda: noticed.append(1))()
    assert noticed == [1]
    with pytest.raises(ToolCallError):
        main._heartbeat(Gw(ToolCallError("throttled")), PID, lambda: noticed.append(1))()


# --- the other actions ------------------------------------------------------------------------------

def test_plan_and_ask_validate_before_starting(monkeypatch):
    started = []
    monkeypatch.setattr(main, "TOOLS_GATEWAY_URL", "https://gw.example/mcp")
    monkeypatch.setattr(main, "_side_task", lambda name, payload, ctx, work: started.append(name) or {"status": "accepted"})
    assert "Unsupported action" in main.invoke({"action": "pause", "projectId": PID}, context())["error"]
    assert "topic" in main.invoke({"action": "plan", "projectId": PID, "topic": "x"}, context())["error"]
    assert main.invoke({"action": "plan", "projectId": PID, "topic": "AI 視覺檢測"}, context()) == {"status": "accepted"}
    assert "qaId" in main.invoke({"action": "ask", "projectId": PID, "qaId": "1", "question": "為什麼？"}, context())["error"]
    assert "question" in main.invoke({"action": "ask", "projectId": PID, "qaId": "qa-0001", "question": ""}, context())["error"]
    assert main.invoke({"action": "ask", "projectId": PID, "qaId": "qa-0001", "question": "為什麼？"}, context())["status"] == "accepted"
    assert started == ["plan", "ask"]


def test_side_task_needs_a_token(monkeypatch):
    monkeypatch.setattr(main, "TOOLS_GATEWAY_URL", "https://gw.example/mcp")
    no_auth = SimpleNamespace(request_headers={}, session_id=RUN_SESSION)
    assert "Authorization" in main.invoke({"action": "plan", "projectId": PID, "topic": "AI 視覺檢測"}, no_auth)["error"]


def test_heartbeat_hands_steering_to_the_run():
    got = []

    class Gw:
        def call(self, target, tool, **args):
            return {"ok": True, "steering": [{"steerId": "s-abcdef", "kind": "finish"}]}

    main._heartbeat(Gw(), PID, lambda: got.append("stopped"), got.append)()
    assert got == [[{"steerId": "s-abcdef", "kind": "finish"}]]
