"""Runs the real orchestrator against the real tool Lambdas (moto) with a scripted LLM.
Covers: plan -> parallel findings -> relations -> template cache -> sub-UI -> review -> follow-up
round -> streamed report -> completion, the retry after a rejected finding, the watchdog cancelling
and retrying a stalled sub-agent, the failure path, and stopping a run."""
import json
import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent.models import (  # noqa: E402
    ComparisonData, EntityDraft, FindingDraft, MetricItem, PlanDraft, RelationDraft, ReviewDraft, SourceDraft,
    SubQuestionDraft, TimelineItem, UiSpecDraft,
)
from research_agent.gateway import check_result  # noqa: E402
from research_agent.orchestrator import Orchestrator, Settings, build_spec, to_finding  # noqa: E402
from research_agent.watch import AgentCancelled, Tracker, Watchdog, WatchSettings  # noqa: E402

REPORT_CHUNKS = ["## 摘要\n\n", "最早導入的是知識檢索 [F1]，", "時程從 2024 年開始 [F2]。\n\n",
                 "## 主要發現\n\n- 部署以混合為主 [F3]\n\n## 矛盾與不確定性\n\n- 成效數字為自評 [F4]\n\n## 尚待研究\n\n- 成本"]

PID = "p-20261022-0a0b0c0d"
USER = "sub-alice"


class FakeGateway:
    """Stands in for the tools gateway: injects _caller like the interceptor, then invokes the Lambda."""

    def __init__(self, mods, user=USER):
        self.handlers = {"project-tools": mods["project_tools"].handler, "data-tools": mods["data_tools"].handler}
        self.user = user
        self.calls = []

    def call(self, target, tool, **arguments):
        self.calls.append(tool)
        result = self.handlers[target]({**arguments, "_caller": self.user, "__tool": f"{target}___{tool}"}, None)
        return check_result(f"{target}___{tool}", result)  # same error mapping as the real ToolsGateway

    def web_tools(self):
        return ["web-search___WebSearch", "web-tools___fetch_page"]


def draft(shape, entities, bad=False, relations=()):
    return FindingDraft(
        summary="太短" if bad else "一段足夠長的摘要，說明這個子題的答案。",
        keyPoints=["重點一", "重點二"],
        entities=[EntityDraft(name=n, type="org") for n in entities],
        relations=[RelationDraft(fromEntity=a, toEntity=b, type=t) for a, b, t in relations],
        sources=[SourceDraft(title="Report", url="https://example.com/r")],
        confidence=0.7,
        comparison=ComparisonData(columns=["項目", "階段"], rows=[["知識檢索", "上線"], ["良率", "試行", "extra"]]) if shape == "comparison" else None,
        timeline=[TimelineItem(when="2024", what="試行")] if shape == "timeline" else None,
        metrics=[MetricItem(label="時間", value=-35, unit="%")] if shape == "metrics" else None,
    )


class ScriptedLlm:
    def __init__(self, fail_first_for=None, follow_ups=()):
        self.fail_first_for = fail_first_for
        self.follow_ups = list(follow_ups)
        self.seen = {}
        self.ui_calls = 0
        self.reviewed = None
        self.reviews = []

    def plan(self, topic, seed, brief="", min_subs=3, max_subs=5, activity=None):
        return PlanDraft(subQuestions=[
            SubQuestionDraft(question="哪些環節最早導入？", dataShape="comparison"),
            SubQuestionDraft(question="導入時程？", dataShape="timeline"),
            SubQuestionDraft(question="部署模式比較？", dataShape="comparison"),
            SubQuestionDraft(question="成效數字？", dataShape="metrics"),
            SubQuestionDraft(question="主要風險？", dataShape="list"),
        ])

    def research(self, question, shape, tools, feedback="", activity=None, reads=4):
        assert [t.tool_name for t in tools] == ["web_search", "read_page"]
        n = self.seen[question] = self.seen.get(question, 0) + 1
        if question == self.fail_first_for and n == 1:
            return draft(shape, ["晶圓廠 A"], bad=True)  # summary under 10 chars -> finding_write rejects it
        if question == self.fail_first_for:
            assert "rejected" in feedback
        return draft(shape, ["晶圓廠 A", "RAG"], relations=[("RAG", "晶圓廠 A", "supports")])

    def design_ui(self, finding, activity=None):
        self.ui_calls += 1
        return UiSpecDraft(component="Compare" if finding["dataShape"] == "comparison" else "KeyPoints", title="比較", emphasizeColumn=1)

    def review(self, topic, findings, requirements, max_follow_ups=3, activity=None):
        self.reviewed = [f["findingId"] for f in findings]
        self.reviews.append(self.reviewed)
        return ReviewDraft(contradictions=["F3 與 F4 對成效的說法不一致"], gaps=["缺少導入成本資料"],
                           followUps=self.follow_ups)

    def report(self, topic, requirements, catalog, review, words=800, activity=None, on_text=None):
        assert catalog.startswith("NO_VERIFIED_CLAIMS ")  # these drafts carry no claims: legacy [F#] report
        self.report_input = ["f-" + row["id"][1:] for row in json.loads(catalog[len("NO_VERIFIED_CLAIMS "):])]
        for chunk in REPORT_CHUNKS:
            if on_text:
                on_text(chunk)
        return "".join(REPORT_CHUNKS)


def recorder(published):
    """Tracker emit + report-text sink that record progress events next to the tool events,
    in the order they happen, so the fixture looks like the real AppSync stream."""
    seq = {"n": 0}

    def emit(event_type, data):
        published.append({"type": event_type, "projectId": PID, "ts": "2026-10-23T08:00:00.000Z", "data": data})

    def on_text(text):
        seq["n"] += 1
        emit("synthesis.delta", {"seq": seq["n"], "text": text})

    return Tracker(emit), on_text


def test_research_run_end_to_end(aws):
    m, published = aws["mods"], aws["published"]
    gw, llm = FakeGateway(m), ScriptedLlm(fail_first_for="導入時程？")
    tracker, on_text = recorder(published)
    # max_parallel=1 keeps the order deterministic so the template cache hit is guaranteed
    result = Orchestrator(gw, llm, Settings(max_parallel=1), tracker=tracker, on_report_text=on_text).run(
        project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40)
    assert result["findings"] == 5 and result["followUps"] == 0

    kinds = [e["type"] for e in published if not e["type"].startswith(("agent.", "synthesis.delta"))]
    assert kinds[0] == "project.created" and kinds[1] == "plan.ready" and kinds[-1] == "project.completed"
    assert kinds[-2] == "synthesis.ready"
    assert kinds.count("finding.ready") == 5 and kinds.count("relation.added") == 5
    ui = [e["data"] for e in published if e["type"] == "ui.ready"]
    # comparison, timeline, comparison(cached), metrics -> 4 sub-UIs; the list finding keeps its card
    assert len(ui) == 4 and [u["cache"] for u in ui].count(True) == 1
    # only the first comparison asked the designer; the second one came from the template cache
    assert llm.ui_calls == 3
    # the rejected finding was retried once with feedback
    assert llm.seen["導入時程？"] == 2

    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    assert got["project"]["status"] == "completed" and len(got["findings"]) == 5
    shares = [e for e in got["edges"] if e["type"] == "shares_entity"]
    assert shares, "findings mentioning the same entity must be linked"
    rows = next(f for f in got["findings"] if f["findingId"] == "f-1")["data"]["rows"]
    assert all(len(r) == 2 for r in rows), "ragged rows are padded/truncated to the column count"

    synthesis = got["synthesis"]
    assert synthesis["report"] == "".join(REPORT_CHUNKS).strip() and synthesis["gaps"] == ["缺少導入成本資料"]
    deltas = [e["data"] for e in published if e["type"] == "synthesis.delta"]
    assert [d["seq"] for d in deltas] == [1, 2, 3, 4] and "".join(d["text"] for d in deltas) == "".join(REPORT_CHUNKS)
    phases = [(e["data"]["agentId"], e["data"]["phase"]) for e in published if e["type"] == "agent.activity"]
    assert phases[0] == ("supervisor", "planning") and ("supervisor", "waiting") in phases
    assert ("supervisor", "reviewing") in phases and ("supervisor", "reporting") in phases and phases[-1] == ("supervisor", "done")
    for fid in ["f-1", "f-2", "f-3", "f-4", "f-5"]:
        assert (fid, "writing") in phases and (fid, "done") in phases
    assert ("f-1", "designing") in phases and ("f-5", "designing") not in phases  # list findings get no sub-UI

    # Golden fixture for the frontend contract test (frontend/src/contract.test.ts).
    fixture = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "sample-run.json"
    if os.environ.get("WRITE_CONTRACT_FIXTURE") or not fixture.exists():
        fixture.parent.mkdir(exist_ok=True)
        fixture.write_text(json.dumps({"events": published, "projectGet": got}, ensure_ascii=False, indent=1) + "\n")


def test_restart_uses_parent_as_seed(aws):
    m = aws["mods"]
    Orchestrator(FakeGateway(m), ScriptedLlm(), Settings(max_parallel=2)).run(
        project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40)
    child = m["project_tools"].handler({"__tool": "x___project_restart", "_caller": USER, "parentProjectId": PID}, None)["projectId"]

    class SeedCheck(ScriptedLlm):
        def plan(self, topic, seed, brief="", min_subs=3, max_subs=5, activity=None):
            assert "哪些環節最早導入？" in seed and "缺少導入成本資料" in seed  # parent's report gaps are carried over
            return super().plan(topic, seed)

    Orchestrator(FakeGateway(m), SeedCheck(), Settings(max_parallel=2)).run(
        project_id=child, topic="半導體導入生成式 AI", parent_project_id=PID, session_id="t" * 40)
    meta = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": child}, None)["project"]
    assert meta["parentProjectId"] == PID and meta["status"] == "completed"


def test_failure_is_reported(aws):
    m, published = aws["mods"], aws["published"]

    class Broken(ScriptedLlm):
        def plan(self, topic, seed, brief="", min_subs=3, max_subs=5, activity=None):
            raise RuntimeError("model unavailable")

    with pytest.raises(RuntimeError):
        Orchestrator(FakeGateway(m), Broken()).run(project_id=PID, topic="主題測試", parent_project_id=None, session_id="s" * 40)
    assert published[-1]["type"] == "project.failed" and "model unavailable" in published[-1]["data"]["message"]


def test_spec_builder_never_leaves_the_whitelist():
    from common.validate import validate_spec
    for shape in ["comparison", "timeline", "metrics", "list"]:
        for comp in ["Compare", "Timeline", "MetricBars", "KeyPoints"]:
            spec = build_spec(UiSpecDraft(component=comp, title="t", emphasizeColumn=2), shape)
            assert validate_spec(spec) == [], (shape, comp, spec)


def test_missing_shape_data_downgrades_to_list():
    d = draft("list", ["A"])
    f = to_finding(d, project_id=PID, finding_id="f-1", question="時程？", shape="timeline")
    assert f["dataShape"] == "list" and f["data"] == {}


def test_review_adds_a_follow_up_round(aws):
    m, published = aws["mods"], aws["published"]
    llm = ScriptedLlm(follow_ups=[SubQuestionDraft(question="導入成本是多少？", dataShape="metrics"),
                                  SubQuestionDraft(question="人才缺口？", dataShape="list")])
    tracker, on_text = recorder(published)
    result = Orchestrator(FakeGateway(m), llm, Settings(max_parallel=3), tracker=tracker, on_report_text=on_text).run(
        project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40)
    assert result == {**result, "findings": 7, "followUps": 2}

    plans = [e["data"]["subQuestions"] for e in published if e["type"] == "plan.ready"]
    assert len(plans) == 2 and len(plans[1]) == 7
    assert [q["round"] for q in plans[1]] == [1, 1, 1, 1, 1, 2, 2]
    assert [q["findingId"] for q in plans[1][5:]] == ["f-6", "f-7"]
    assert llm.reviews[0] == ["f-1", "f-2", "f-3", "f-4", "f-5"]        # the first review sees round 1 only
    assert len(llm.reviews) == 2 and len(llm.reviews[1]) == 7          # coverage is re-checked after round 2
    assert sorted(llm.report_input) == [f"f-{i}" for i in range(1, 8)]  # the report sees both rounds
    round2 = {e["data"]["agentId"] for e in published if e["type"] == "agent.activity" and e["data"].get("round") == 2}
    assert round2 == {"f-6", "f-7"}
    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    assert len(got["findings"]) == 7 and got["synthesis"]["followUps"] == ["導入成本是多少？", "人才缺口？"]


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class StallingLlm(ScriptedLlm):
    """The research for one question hangs (no tokens) on its first `stalls` attempts until cancelled."""

    def __init__(self, question, stalls):
        super().__init__()
        self.question, self.stalls = question, stalls
        self.hanging = threading.Event()
        self.attempts = 0

    def research(self, question, shape, tools, feedback="", activity=None, reads=4):
        if question == self.question:
            self.attempts += 1
            if self.attempts <= self.stalls:
                released = threading.Event()
                activity.bind_cancel(released.set)   # what llm._agent does with agent.cancel
                self.hanging.set()
                assert released.wait(10), "the watchdog never cancelled the hung call"
                raise AgentCancelled(activity.agent_id)
        return super().research(question, shape, tools, feedback, activity)


def _run_with_watchdog(m, published, llm, stalls_to_trigger):
    clock = Clock()
    tracker = Tracker(lambda t, d: published.append({"type": t, "projectId": PID, "data": d}), clock=clock)
    persisted = []
    watchdog = Watchdog(tracker, WatchSettings(stall_sec=120, budget_sec=600, heartbeat_sec=10, persist_sec=60),
                        persist=lambda: persisted.append(clock.now))
    orch = Orchestrator(FakeGateway(m), llm, Settings(max_parallel=1), tracker=tracker)
    errors = []
    worker = threading.Thread(target=lambda: _capture(errors, lambda: orch.run(
        project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40)))
    worker.start()
    for _ in range(stalls_to_trigger):
        assert llm.hanging.wait(10), "the stalling call never started"
        llm.hanging.clear()
        watchdog.tick()               # nothing idle yet: no cancel
        clock.now += 130              # 130 s without a token or tool call
        watchdog.tick()
    worker.join(30)
    assert not worker.is_alive() and not errors, errors
    return persisted


def _capture(errors, fn):
    try:
        fn()
    except Exception as err:  # noqa: BLE001
        errors.append(err)


def test_watchdog_cancels_a_stalled_sub_agent_and_the_retry_succeeds(aws):
    m, published = aws["mods"], aws["published"]
    llm = StallingLlm("導入時程？", stalls=1)
    persisted = _run_with_watchdog(m, published, llm, stalls_to_trigger=1)
    stalled = [e["data"] for e in published if e["type"] == "agent.stalled"]
    assert stalled == [{"agentId": "f-2", "idleSec": 130, "action": "retrying"}]
    assert llm.attempts == 2
    heartbeats = [e["data"] for e in published if e["type"] == "agent.heartbeat"]
    assert heartbeats and any(a["agentId"] == "f-2" for h in heartbeats for a in h["agents"])
    assert persisted, "project.updatedAt is refreshed while the run is alive"
    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    assert len(got["findings"]) == 5 and got["project"]["status"] == "completed"


def test_watchdog_gives_up_after_the_second_stall_and_the_run_still_completes(aws):
    m, published = aws["mods"], aws["published"]
    llm = StallingLlm("導入時程？", stalls=2)
    _run_with_watchdog(m, published, llm, stalls_to_trigger=2)
    stalled = [e["data"]["action"] for e in published if e["type"] == "agent.stalled"]
    assert stalled == ["retrying", "gave_up"]
    failed = [e["data"] for e in published if e["type"] == "agent.activity" and e["data"]["phase"] == "failed"]
    assert failed == [{"agentId": "f-2", "phase": "failed", "round": 1, "detail": "停滯，已放棄"}]
    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    assert sorted(f["findingId"] for f in got["findings"]) == ["f-1", "f-3", "f-4", "f-5"]
    assert got["project"]["status"] == "completed" and got["synthesis"] is not None


def test_watchdog_never_cancels_a_waiting_supervisor_or_a_finished_step():
    clock = Clock()
    events = []
    tracker = Tracker(lambda t, d: events.append((t, d)), clock=clock)
    sup = tracker.agent("supervisor")
    sup.begin_attempt(retries_left=1)
    sup.bind_cancel(lambda: events.append(("cancelled", {})))
    sup.end_attempt()                       # the planning call finished
    sup.set_phase("waiting", "等待 5 個 sub-agent")
    worker = tracker.agent("f-1")
    worker.set_phase("writing")             # a tool call, no LLM step bound
    clock.now += 1000
    Watchdog(tracker, WatchSettings()).tick()
    assert not [e for e in events if e[0] in ("cancelled", "agent.stalled")]


def test_publisher_batches_events_and_orders_report_text():
    from research_agent.progress import Publisher
    sent = []
    pub = Publisher(PID, send=lambda channel, events: sent.append((channel, events)))
    for i in range(7):
        pub.emit("agent.activity", {"agentId": f"f-{i}", "phase": "searching"})
    pub.append_text("## 摘")
    pub.append_text("要")
    pub.flush()
    pub.append_text("\n內容")
    pub.close()
    assert all(channel == f"/research/{PID}" for channel, _ in sent)
    assert [len(batch) for _, batch in sent] == [5, 3, 1]       # at most 5 events per AppSync request
    deltas = [e["data"] for _, batch in sent for e in batch if e["type"] == "synthesis.delta"]
    assert deltas == [{"seq": 1, "text": "## 摘要"}, {"seq": 2, "text": "\n內容"}]


def test_publisher_failures_never_reach_the_research():
    from research_agent.progress import Publisher

    def broken(channel, events):
        raise OSError("AppSync unreachable")

    pub = Publisher(PID, send=broken)
    pub.emit("agent.heartbeat", {"elapsedSec": 1, "agents": []})
    pub.close()
    assert pub.dropped == 1 and pub.sent == 0


# --- stopping a run ---------------------------------------------------------------------------------
import time  # noqa: E402

from research_agent.stopping import StopSignal  # noqa: E402


class HangingLlm(ScriptedLlm):
    """Research for the listed questions hangs like a silent model stream until the call is cancelled."""

    def __init__(self, hang):
        super().__init__()
        self.hang = set(hang)
        self.started = []
        self.hanging = threading.Semaphore(0)

    def research(self, question, shape, tools, feedback="", activity=None, reads=4):
        self.started.append(question)
        if question in self.hang:
            released = threading.Event()
            activity.bind_cancel(released.set)   # what llm._agent does with agent.cancel
            self.hanging.release()
            assert released.wait(10), "the stop never cancelled the hung call"
            raise AgentCancelled(activity.agent_id)
        return super().research(question, shape, tools, feedback, activity)


def project_stop(m):
    """What the browser does first: the durable stop through the tools gateway."""
    return m["project_tools"].handler({"__tool": "x___project_stop", "_caller": USER, "projectId": PID}, None)


def test_user_stop_mid_run_settles_without_failing(aws):
    m, published = aws["mods"], aws["published"]
    tracker, on_text = recorder(published)
    stop = StopSignal(tracker)
    llm = HangingLlm(hang={"部署模式比較？"})            # f-3; f-1 and f-2 finish first (max_parallel=1)
    orch = Orchestrator(FakeGateway(m), llm, Settings(max_parallel=1), tracker=tracker, on_report_text=on_text, stop=stop)
    out, errors = {}, []
    worker = threading.Thread(target=lambda: _capture(errors, lambda: out.update(orch.run(
        project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40))))
    worker.start()
    assert llm.hanging.acquire(timeout=10), "f-3 never started"

    res = project_stop(m)                              # 1. browser: project_stop
    assert res["stopped"] is True and res["runtimeSessionId"] == "s" * 40
    started = time.monotonic()
    assert stop.stop("stopped by the user") is True   # 2. runtime: action "stop"
    worker.join(5)
    assert not worker.is_alive() and not errors, errors
    assert time.monotonic() - started < 3
    assert out == {**out, "stopped": True, "findings": 2}

    assert "成效數字？" not in llm.started and "主要風險？" not in llm.started, "queued sub-questions never start"
    kinds = [e["type"] for e in published]
    assert "project.failed" not in kinds and "project.completed" not in kinds and "synthesis.ready" not in kinds
    assert kinds.count("project.stopped") == 1 and kinds.count("finding.ready") == 2
    after = published[kinds.index("project.stopped") + 1:]
    assert all(e["type"] == "agent.activity" for e in after), [e["type"] for e in after]
    stopped = {e["data"]["agentId"] for e in after if e["data"]["phase"] == "stopped"}
    assert stopped == {"supervisor", "f-3", "f-4", "f-5"}

    got = m["project_tools"].handler({"__tool": "x___project_get", "_caller": USER, "projectId": PID}, None)
    assert got["project"]["status"] == "stopped" and len(got["findings"]) == 2 and len(got["plan"]) == 5
    assert got["synthesis"] is None

    # Batched progress sent just before the stop can still reach the browser after project.stopped.
    tracker.emit("agent.heartbeat", {"elapsedSec": 42, "agents": [{"agentId": "f-3", "phase": "thinking", "idleSec": 3}]})
    on_text("## 摘要\n\n")
    fixture = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "stopped-run.json"
    if os.environ.get("WRITE_CONTRACT_FIXTURE") or not fixture.exists():
        fixture.write_text(json.dumps({"events": published, "projectGet": got}, ensure_ascii=False, indent=1) + "\n")


def test_a_stop_from_another_client_is_noticed_at_the_next_tool_call(aws):
    """The browser stopped the project but the runtime never got the stop message: the next write is
    refused with `stopped`, and the run unwinds as stopped (not failed)."""
    m, published = aws["mods"], aws["published"]

    class StopsMidway(ScriptedLlm):
        def research(self, question, shape, tools, feedback="", activity=None, reads=4):
            if question == "導入時程？":
                project_stop(m)
            return super().research(question, shape, tools, feedback, activity)

    llm = StopsMidway()
    orch = Orchestrator(FakeGateway(m), llm, Settings(max_parallel=1))
    out = orch.run(project_id=PID, topic="半導體導入生成式 AI", parent_project_id=None, session_id="s" * 40)
    assert out == {**out, "stopped": True, "findings": 1}
    assert orch.stop.is_set and orch.tracker.halted
    assert set(llm.seen) == {"哪些環節最早導入？", "導入時程？"}
    kinds = [e["type"] for e in published]
    assert "project.failed" not in kinds and kinds.count("finding.ready") == 1


def test_halt_cancels_running_calls_and_calls_that_start_later():
    tracker = Tracker(lambda t, d: None)
    busy = tracker.agent("f-1")
    busy.begin_attempt(retries_left=1)
    fired = []
    busy.bind_cancel(lambda: fired.append("f-1"))
    tracker.halt()
    assert fired == ["f-1"]
    late = tracker.agent("f-2")                 # created after the stop
    late.begin_attempt(retries_left=1)
    late.bind_cancel(lambda: fired.append("f-2"))
    assert fired == ["f-1", "f-2"] and late.cancelled
    clock = Clock()
    halted = Tracker(lambda t, d: fired.append(t), clock=clock)
    halted.agent("f-3").set_phase("searching")
    halted.halt()
    clock.now += 1000
    Watchdog(halted, WatchSettings()).tick()
    assert "agent.stalled" not in fired, "a stopped agent is not a stalled one"
