"""AgentCore Runtime entrypoint for the research supervisor.

Reached through the agents gateway (HTTP target `research`). The runtime's JWT authorizer validates
the user's Cognito token, and the Authorization header is allow-listed so the agent can call the
tools gateway as the same user.

Actions:
- `plan`: drafts a plan for the user to review (the project is created as a draft); async.
- `start`: returns at once; research continues as a registered async task so the session stays
  alive (the ping reports HealthyBusy) while progress streams to the UI as AppSync events. With
  `plan` it researches the plan the user approved; with `mode: "incremental"` it re-runs a completed
  project for newer data.
- `ask`: answers a follow-up question about a report from its verified claims; async.
- `stop`: stops a run (contracts/events.md, "Stopping a run"). The run is cancelled cooperatively,
  then this AgentCore session is terminated with StopRuntimeSession.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from .gateway import ToolCallError, ToolsGateway
from .llm import StrandsLlm
from .orchestrator import Brief, Orchestrator, Settings
from .progress import Publisher, make_sigv4_sender
from .stopping import ResearchStopped, StopSignal, jwt_subject, stop_runtime_session
from .watch import Tracker, Watchdog, WatchSettings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("research")
app = BedrockAgentCoreApp()

TOOLS_GATEWAY_URL = os.environ.get("TOOLS_GATEWAY_URL", "")
REGION = os.environ.get("AWS_REGION", "us-west-2")
PROJECT_ID = re.compile(r"^p-[a-z0-9-]{4,60}$")
QA_ID = re.compile(r"^qa-[a-z0-9-]{4,40}$")
ACTIONS = ("plan", "start", "ask", "stop")
UNWIND_SEC = 15.0     # after a stop, end the session even if the run has not unwound by then
END_DELAY_SEC = 2.0   # let the HTTP response that asked for the stop leave before the microVM goes


def _bearer(headers: dict | None) -> str:
    for key, value in (headers or {}).items():
        if key.lower() == "authorization" and isinstance(value, str) and value.lower().startswith("bearer "):
            return value.split(" ", 1)[1]
    return ""


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _publisher(project_id: str) -> Publisher:
    domain = os.environ.get("EVENTS_HTTP_DOMAIN", "")
    if not domain:
        log.warning("EVENTS_HTTP_DOMAIN is not set; live progress will not be published")
        return Publisher(project_id, send=None)
    return Publisher(project_id, send=make_sigv4_sender(domain, REGION)).start()


# --- runs in this process -------------------------------------------------------------------------

@dataclass
class Run:
    project_id: str
    session_id: str
    subject: str                       # Cognito `sub` of the user who started it
    stop: StopSignal
    done: threading.Event = field(default_factory=threading.Event)


_runs: dict[str, Run] = {}
_runs_lock = threading.Lock()


def _register(run: Run) -> None:
    with _runs_lock:
        _runs[run.project_id] = run


def _unregister(run: Run) -> None:
    with _runs_lock:
        if _runs.get(run.project_id) is run:
            del _runs[run.project_id]


def _find(project_id: str) -> Run | None:
    with _runs_lock:
        return _runs.get(project_id)


def _others(ignore: Iterable[str]) -> list[str]:
    with _runs_lock:
        return [pid for pid in _runs if pid not in set(ignore)]


# --- ending the AgentCore session -----------------------------------------------------------------

def _terminate(session_id: str, token: str) -> str:
    arn = os.environ.get("RESEARCH_RUNTIME_ARN", "")
    if not arn:
        raise RuntimeError("RESEARCH_RUNTIME_ARN is not set; re-run scripts/deploy_agentcore.py")
    return stop_runtime_session(arn, session_id, token, REGION)


def _end_session(session_id: str, token: str, *, ignore: Iterable[str] = (), delay: float | None = None) -> threading.Thread | None:
    """Terminate this session soon, unless another run still uses it (an agents gateway that keys
    sessions by user puts all of a user's runs in one session)."""
    ignore = tuple(ignore)
    delay = END_DELAY_SEC if delay is None else delay
    if not session_id:
        return None
    if _others(ignore):
        log.info("not ending session: other runs are active here (%s)", _others(ignore))
        return None

    def end() -> None:
        time.sleep(delay)
        if _others(ignore):
            return
        try:
            log.info("ending AgentCore session %s…", session_id[:8])
            _terminate(session_id, token)  # on success this process is gone before the next line
        except Exception:  # noqa: BLE001
            log.exception("could not end the session; it ends after the idle timeout instead")

    thread = threading.Thread(target=end, name="end-session", daemon=True)
    thread.start()
    return thread


def _request_stop(run: Run, reason: str, token: str = "") -> bool:
    """Cancel the run; the run thread ends the session once it has unwound, or we do after UNWIND_SEC."""
    if not run.stop.stop(reason, token):
        return False

    def deadline() -> None:
        if run.done.wait(UNWIND_SEC):
            return
        log.warning("run %s did not unwind within %.0fs; ending the session anyway", run.project_id, UNWIND_SEC)
        _end_session(run.session_id, run.stop.token, ignore=[run.project_id], delay=0)

    threading.Thread(target=deadline, name="stop-deadline", daemon=True).start()
    return True


# --- start ------------------------------------------------------------------------------------------

def _heartbeat(gw, project_id: str, on_stopped: Callable[[], None],
               on_steering: Callable[[list], None] = lambda steers: None) -> Callable[[], None]:
    """Refreshes project.updatedAt (so a reloaded page can tell a live run from a dead one), notices a
    stop made elsewhere (project_save is refused with `stopped` once the user stopped it) and picks up
    the user's steering, which project_save returns while the project runs."""

    def beat() -> None:
        try:
            res = gw.call("project-tools", "project_save", projectId=project_id, status="running")
        except ToolCallError as err:
            if not err.stopped:
                raise
            on_stopped()
            return
        on_steering(res.get("steering") or [])

    return beat


def _settings(brief: Brief) -> Settings:
    settings = Settings.for_depth(brief.depth)
    settings.max_parallel = min(settings.max_parallel, int(os.environ.get("MAX_PARALLEL", "6")))
    if os.environ.get("FOLLOW_UP_ROUNDS"):  # an operator cap on the depth preset (0 turns follow-ups off)
        settings.follow_up_rounds = min(settings.follow_up_rounds, max(0, int(os.environ["FOLLOW_UP_ROUNDS"])))
    return settings


def _run(task_id: int, token: str, payload: dict, session_id: str) -> None:
    project_id = payload["projectId"]
    publisher = _publisher(project_id)
    tracker = Tracker(publisher.emit)
    run = Run(project_id, session_id, jwt_subject(token), StopSignal(tracker))
    _register(run)
    watchdog = None
    try:
        with ToolsGateway(TOOLS_GATEWAY_URL, token) as gw:
            incremental = payload.get("mode") == "incremental"
            brief = Brief.from_payload(payload)
            orchestrator = Orchestrator(gw, StrandsLlm(), None if incremental else _settings(brief), tracker=tracker,
                                        on_report_text=publisher.append_text, stop=run.stop,
                                        secondary_search=os.environ.get("SECONDARY_SEARCH", "false").lower() == "true",
                                        max_parallel=int(os.environ.get("MAX_PARALLEL", "6")))
            watch = WatchSettings(stall_sec=_env_float("STALL_SEC", 120), budget_sec=_env_float("STEP_BUDGET_SEC", 600))
            watchdog = Watchdog(tracker, watch, persist=_heartbeat(
                gw, project_id, lambda: _request_stop(run, "stopped by another client"), orchestrator.receive_steering)).start()
            if incremental:
                extra = [q for q in payload.get("extraQuestions") or [] if isinstance(q, str)][:3]
                result = orchestrator.run_incremental(project_id=project_id, topic=payload["topic"], session_id=session_id,
                                                      overrides=payload, extra_questions=extra)
            else:
                result = orchestrator.run(project_id=project_id, topic=payload["topic"], parent_project_id=payload.get("parentProjectId"),
                                          session_id=session_id, brief=brief, plan=Orchestrator.approved_plan(payload.get("plan")))
            log.info("research finished: %s", result)
    except ResearchStopped:  # stopped before the run had started
        log.info("research stopped before it started")
    except Exception:  # noqa: BLE001 - already reported to the UI as project.failed
        log.exception("research task ended with an error")
    finally:
        if watchdog:
            watchdog.stop()
        publisher.close()
        log.info("progress events sent=%d dropped=%d", publisher.sent, publisher.dropped)
        _unregister(run)
        run.done.set()
        app.complete_async_task(task_id)
        if run.stop.is_set:
            # Cancelled model calls may still wait on Bedrock for up to 120 s: end the microVM now.
            _end_session(session_id, run.stop.token or token)


def _start(payload: dict, context) -> dict:
    pid, topic = payload.get("projectId"), payload.get("topic")
    if not (isinstance(topic, str) and 3 <= len(topic.strip()) <= 300):
        return {"error": "topic must be 3-300 characters"}
    token = _bearer(getattr(context, "request_headers", None))
    if not token:
        return {"error": "Missing Authorization header. Check the runtime's request header allowlist."}
    if not TOOLS_GATEWAY_URL:
        return {"error": "TOOLS_GATEWAY_URL is not configured"}
    if _find(pid):
        return {"projectId": pid, "status": "accepted"}  # already running here: a retried start is a no-op

    task_id = app.add_async_task("research", {"projectId": pid})
    threading.Thread(target=_run, args=(task_id, token, {**payload, "topic": topic.strip()}, context.session_id), daemon=True).start()
    return {"projectId": pid, "status": "accepted"}


# --- plan and ask: short tasks that write through the tools gateway ------------------------------------

def _side_task(name: str, payload: dict, context, work: Callable[[Orchestrator], dict]) -> dict:
    token = _bearer(getattr(context, "request_headers", None))
    if not token:
        return {"error": "Missing Authorization header. Check the runtime's request header allowlist."}
    if not TOOLS_GATEWAY_URL:
        return {"error": "TOOLS_GATEWAY_URL is not configured"}
    pid = payload["projectId"]
    task_id = app.add_async_task(name, {"projectId": pid})

    def go() -> None:
        publisher = _publisher(pid)
        try:
            with ToolsGateway(TOOLS_GATEWAY_URL, token) as gw:
                result = work(Orchestrator(gw, StrandsLlm(), tracker=Tracker(publisher.emit)))
                log.info("%s finished: %s", name, result)
        except Exception:  # noqa: BLE001 - already reported to the UI (plan.failed / qa.failed)
            log.exception("%s failed", name)
        finally:
            publisher.close()
            app.complete_async_task(task_id)

    threading.Thread(target=go, name=name, daemon=True).start()
    return {"projectId": pid, "status": "accepted"}


def _plan(payload: dict, context) -> dict:
    topic = payload.get("topic")
    if not (isinstance(topic, str) and 3 <= len(topic.strip()) <= 300):
        return {"error": "topic must be 3-300 characters"}
    brief = Brief.from_payload(payload)
    return _side_task("plan", payload, context, lambda orch: orch.propose(
        project_id=payload["projectId"], topic=topic.strip(), parent_project_id=payload.get("parentProjectId"), brief=brief))


def _ask(payload: dict, context) -> dict:
    question, qa_id, selection = payload.get("question"), payload.get("qaId"), payload.get("selection") or ""
    if not (isinstance(question, str) and 2 <= len(question.strip()) <= 1000):
        return {"error": "question must be 2-1000 characters"}
    if not (isinstance(qa_id, str) and QA_ID.match(qa_id)):
        return {"error": "qaId must match ^qa-[a-z0-9-]{4,40}$"}
    if not isinstance(selection, str):
        return {"error": "selection must be text"}
    return _side_task("ask", payload, context, lambda orch: orch.answer(
        project_id=payload["projectId"], qa_id=qa_id, question=question.strip(), selection=selection[:2000]))


# --- stop -------------------------------------------------------------------------------------------

def _stop(payload: dict, context) -> dict:
    pid = payload["projectId"]
    token = _bearer(getattr(context, "request_headers", None))
    if not token:
        return {"error": "Missing Authorization header. Check the runtime's request header allowlist."}
    own_session = getattr(context, "session_id", "") or ""

    # project_stop is the owner check and the durable stop; it also tells us where the run lives.
    owner_ok, stored_session, problem = False, None, "TOOLS_GATEWAY_URL is not configured"
    if TOOLS_GATEWAY_URL:
        try:
            with ToolsGateway(TOOLS_GATEWAY_URL, token) as gw:
                info = gw.call("project-tools", "project_stop", projectId=pid)
            owner_ok, stored_session = True, info.get("runtimeSessionId")
        except Exception as err:  # noqa: BLE001
            log.exception("project_stop failed for %s", pid)
            problem = str(err)[:300]

    run = _find(pid)
    if run is not None and (owner_ok or (run.subject and run.subject == jwt_subject(token))):
        _request_stop(run, "stopped by the user", token)
        return {"projectId": pid, "status": "stopping"}
    if not owner_ok:
        return {"error": f"Could not stop {pid}: {problem}"}

    status, warning = "not_running", ""
    if stored_session and stored_session != own_session:
        # The request reached a different session than the run (the gateway did not route by our
        # session header): terminate the run's session directly.
        try:
            status = "terminated" if _terminate(stored_session, token) == "stopped" else "not_running"
        except Exception as err:  # noqa: BLE001
            log.exception("could not terminate session of %s", pid)
            status, warning = "stopping", f"the run notices the stop within 30 s ({str(err)[:200]})"
    # This session holds no run of that project; don't leave it idle until the idle timeout.
    _end_session(own_session, token)
    out = {"projectId": pid, "status": status}
    if warning:
        out["warning"] = warning
    return out


@app.entrypoint
def invoke(payload: dict, context) -> dict:
    action = payload.get("action")
    if action not in ACTIONS:
        return {"error": "Unsupported action. Send {action: 'plan' | 'start', projectId, topic, depth?, audience?, startDate?, "
                         "includeDomains?, excludeDomains?, notes?, plan?, mode?, extraQuestions?}, "
                         "{action: 'ask', projectId, qaId, question, selection?} or {action: 'stop', projectId}."}
    if not (isinstance(payload.get("projectId"), str) and PROJECT_ID.match(payload["projectId"])):
        return {"error": "projectId must match ^p-[a-z0-9-]{4,60}$"}
    handler = {"plan": _plan, "start": _start, "ask": _ask, "stop": _stop}[action]
    return handler(payload, context)


if __name__ == "__main__":
    app.run()
