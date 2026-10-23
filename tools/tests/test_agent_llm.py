"""Runs the real Strands agents in llm.py against a fake Bedrock client and checks every Converse
request: Claude Opus 5.5 rejects sampling parameters (temperature/top_p/top_k) and forced
toolChoice ("any"/"tool"), so neither may ever be sent, including on Strands' structured-output retry."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))

from research_agent import llm  # noqa: E402


def _stream(text: str, stop: str = "end_turn") -> dict:
    events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}, "contentBlockIndex": 0}},
        {"contentBlockDelta": {"delta": {"text": text}, "contentBlockIndex": 0}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": stop}},
        {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 10, "totalTokens": 20}, "metrics": {"latencyMs": 1}}},
    ]
    return {"stream": iter(events)}


class Recorder:
    """Replaces the boto3 bedrock-runtime client: first answers in prose (forcing Strands to retry
    for structured output), then with JSON that matches the requested schema."""

    def __init__(self, answers: list[str]):
        self.answers = list(answers)
        self.requests: list[dict] = []

    def converse_stream(self, **request):
        self.requests.append(request)
        return _stream(self.answers.pop(0))

    def converse(self, **request):
        raise AssertionError("streaming is expected")


def _run(monkeypatch, model_id_attr: str, answers: list[str], call):
    rec = Recorder(answers)
    real = llm._model

    def patched(model_id, max_tokens):
        model = real(model_id, max_tokens)
        model.client.converse_stream = rec.converse_stream
        model.client.converse = rec.converse
        return model

    monkeypatch.setattr(llm, "_model", patched)
    result = call()
    return result, rec.requests


def _assert_opus_safe(requests, model_id):
    assert requests, "no request was sent"
    for req in requests:
        assert req["modelId"] == model_id
        inference = req.get("inferenceConfig", {})
        assert inference.get("maxTokens", 0) >= 8000, "leave room for adaptive thinking"
        for banned in ("temperature", "topP", "topK"):
            assert banned not in inference, f"{banned} would be rejected"
        assert "top_k" not in json.dumps(req.get("additionalModelRequestFields", {}))
        choice = req.get("toolConfig", {}).get("toolChoice", {"auto": {}})
        assert "any" not in choice and "tool" not in choice, f"forced toolChoice would be rejected: {choice}"


def test_defaults_are_claude_5_5_inference_profiles():
    assert llm.SUPERVISOR_MODEL_ID == "us.anthropic.claude-opus-5-5"
    assert llm.WORKER_MODEL_ID == "us.anthropic.claude-sonnet-5-5"


def test_planner_requests_are_valid_for_opus_5_5(monkeypatch):
    plan = {"subQuestions": [{"question": "哪些環節最早導入？", "dataShape": "comparison"},
                             {"question": "導入時程？", "dataShape": "timeline"}]}
    result, requests = _run(monkeypatch, "SUPERVISOR_MODEL_ID", ["我會把主題拆成兩個子題。", json.dumps(plan, ensure_ascii=False)],
                            lambda: llm.StrandsLlm().plan("半導體導入生成式 AI", ""))
    assert [s.question for s in result.subQuestions] == ["哪些環節最早導入？", "導入時程？"]
    assert len(requests) == 2, "prose answer, then the structured-output retry"
    assert "outputConfig" in requests[1], "the retry must use Bedrock native structured output"
    _assert_opus_safe(requests, llm.SUPERVISOR_MODEL_ID)


def test_research_requests_are_valid(monkeypatch):
    finding = {"summary": "一段足夠長的摘要，說明這個子題的答案。", "keyPoints": ["重點"], "entities": [{"name": "TSMC", "type": "org"}],
               "relations": [], "sources": [{"title": "Report", "url": "https://example.com/r"}], "confidence": 0.7,
               "comparison": None, "timeline": [{"when": "2024", "what": "試行"}], "metrics": None}
    result, requests = _run(monkeypatch, "WORKER_MODEL_ID", ["我查到了。", json.dumps(finding, ensure_ascii=False)],
                            lambda: llm.StrandsLlm().research("導入時程？", "timeline", []))
    assert result.timeline[0].when == "2024"
    _assert_opus_safe(requests, llm.WORKER_MODEL_ID)


def test_ui_designer_requests_are_valid(monkeypatch):
    spec = {"component": "Compare", "title": "比較", "emphasizeColumn": 1}
    result, requests = _run(monkeypatch, "WORKER_MODEL_ID", ["好的。", json.dumps(spec, ensure_ascii=False)],
                            lambda: llm.StrandsLlm().design_ui({"question": "q", "dataShape": "comparison", "keyPoints": [], "data": {}}))
    assert result.component == "Compare"
    _assert_opus_safe(requests, llm.WORKER_MODEL_ID)


# --- live progress: the real Strands wiring in llm._agent -------------------------------------------
import threading  # noqa: E402
import time  # noqa: E402

import pytest  # noqa: E402
from strands import tool  # noqa: E402

from research_agent.watch import AgentCancelled, Tracker  # noqa: E402


def _tool_use_stream(name: str, args: dict) -> dict:
    events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t-1", "name": name}}, "contentBlockIndex": 0}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(args)}}, "contentBlockIndex": 0}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "tool_use"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}, "metrics": {"latencyMs": 1}}},
    ]
    return {"stream": iter(events)}


def _patch_client(monkeypatch, streams):
    real = llm._model

    def patched(model_id, max_tokens):
        model = real(model_id, max_tokens)
        model.client.converse_stream = lambda **request: streams.pop(0)()
        return model

    monkeypatch.setattr(llm, "_model", patched)


def _tracked(agent_id="f-1"):
    events = []
    act = Tracker(lambda t, d: events.append((t, d))).agent(agent_id)
    act.begin_attempt(retries_left=1)
    return act, events


def test_tool_calls_are_reported_as_searching_and_reading(monkeypatch):
    @tool(name="web_search")
    def web_search(query: str) -> str:
        """Search the web."""
        return json.dumps({"results": [{"text": "TSMC uses GenAI", "url": "https://example.com/a"}]})

    @tool(name="read_page")
    def fetch_page(url: str) -> str:
        """Read a page."""
        return "page text"

    finding = {"summary": "一段足夠長的摘要，說明這個子題的答案。", "keyPoints": [], "entities": [], "relations": [],
               "sources": [{"title": "A", "url": "https://example.com/a"}], "confidence": 0.6,
               "comparison": None, "timeline": None, "metrics": None}
    _patch_client(monkeypatch, [
        lambda: _tool_use_stream("web_search", {"query": "TSMC 生成式 AI"}),
        lambda: _tool_use_stream("read_page", {"url": "https://example.com/a"}),
        lambda: _stream("我讀完了。"),
        lambda: _stream(json.dumps(finding, ensure_ascii=False)),
    ])
    act, events = _tracked()
    llm.StrandsLlm().research("台積電如何使用生成式 AI？", "list", [web_search, fetch_page], activity=act)
    phases = [(d["phase"], d.get("detail")) for t, d in events if t == "agent.activity"]
    assert ("searching", "TSMC 生成式 AI") in phases and ("reading", "https://example.com/a") in phases
    assert phases.index(("searching", "TSMC 生成式 AI")) < phases.index(("reading", "https://example.com/a"))
    assert ("thinking", None) in phases[phases.index(("reading", "https://example.com/a")):]


def test_report_streams_text_as_it_is_generated(monkeypatch):
    _patch_client(monkeypatch, [lambda: _stream("## 摘要\n\n半導體業已導入 [F1]。")])
    chunks = []
    act, _ = _tracked("supervisor")
    text = llm.StrandsLlm().report("主題", [], "[]", None, activity=act, on_text=chunks.append)
    assert "".join(chunks) == text == "## 摘要\n\n半導體業已導入 [F1]。"


def test_watchdog_cancel_interrupts_a_real_strands_call(monkeypatch):
    first_token = threading.Event()

    def hanging_stream():
        def events():
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}, "contentBlockIndex": 0}}
            yield {"contentBlockDelta": {"delta": {"text": "## 摘要"}, "contentBlockIndex": 0}}
            time.sleep(8)  # the model goes silent mid-answer
            yield {"contentBlockStop": {"contentBlockIndex": 0}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        return {"stream": events()}

    _patch_client(monkeypatch, [hanging_stream])
    act, _ = _tracked("supervisor")
    outcome = {}

    def call():
        try:
            llm.StrandsLlm().report("主題", [], "[]", None, activity=act, on_text=lambda t: first_token.set())
        except Exception as err:  # noqa: BLE001
            outcome["error"] = err

    worker = threading.Thread(target=call)
    started = time.monotonic()
    worker.start()
    assert first_token.wait(5)
    assert act.cancel() is True              # what the watchdog does after STALL_SEC
    worker.join(6)
    assert not worker.is_alive(), "cancel did not stop the call"
    assert isinstance(outcome.get("error"), AgentCancelled)
    assert time.monotonic() - started < 6


def test_a_stopped_agent_never_waits_on_the_model(monkeypatch):
    """After a stop, a model call that starts anyway (a race with the stop) is cancelled before it
    produces anything, through the real Strands agent."""
    def hanging_stream():
        def events():
            time.sleep(8)
            yield {"messageStart": {"role": "assistant"}}
        return {"stream": events()}

    _patch_client(monkeypatch, [hanging_stream])
    tracker = Tracker(lambda t, d: None)
    tracker.halt()
    act = tracker.agent("supervisor")
    act.begin_attempt(retries_left=0)
    started = time.monotonic()
    with pytest.raises(AgentCancelled):
        llm.StrandsLlm().report("主題", [], "[]", None, activity=act, on_text=lambda t: None)
    assert time.monotonic() - started < llm.CANCEL_GRACE_SEC + 1.5
