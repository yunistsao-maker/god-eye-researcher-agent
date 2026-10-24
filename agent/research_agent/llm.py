"""Strands + Bedrock implementation of the orchestrator's Llm interface."""
from __future__ import annotations

import contextvars
import json
import logging
import os
import threading
from typing import Any, Callable, Optional

from strands import Agent
from strands.hooks import AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent
from strands.models.bedrock import BedrockModel

from . import prompts
from .models import AnswerDraft, FindingDraft, PlanDraft, ReviewDraft, ReviseDraft, UiSpecDraft, VerifyDraft
from .watch import AgentActivity, AgentCancelled

log = logging.getLogger(__name__)
REGION = os.environ.get("AWS_REGION", "us-west-2")
# Inference profile ids; both models are only callable through a profile (us. / global. / ...).
# The supervisor plans the research; workers research sub-questions and design sub-UIs.
SUPERVISOR_MODEL_ID = os.environ.get("SUPERVISOR_MODEL_ID", "us.anthropic.claude-opus-5-5")
WORKER_MODEL_ID = os.environ.get("WORKER_MODEL_ID", "us.anthropic.claude-sonnet-5-5")

# Output budgets. Both models think adaptively by default (Opus 5.5 cannot turn it off), and the
# reasoning shares max_tokens with the answer, so these leave room for thinking.
PLAN_MAX_TOKENS = 16_000
RESEARCH_MAX_TOKENS = 32_000
UI_MAX_TOKENS = 8_000
REPORT_MAX_TOKENS = 24_000
VERIFY_MAX_TOKENS = 16_000


def _never_force_tool_choice(*model_ids: str) -> None:
    """Claude Opus 5.5 always thinks and rejects a forced toolChoice ("any"/"tool"); Sonnet 5.5 thinks by
    default too. Strands' structured output tries forcing the output tool first and falls back to Bedrock
    native structured output only on error messages it recognises, so mark forcing unsupported up front."""
    try:
        from strands.models._native_output import _record_unsupported_mechanism
    except ImportError:  # moved in a newer strands; tools/tests/test_agent_llm.py fails if forcing comes back
        log.warning("cannot disable forced tool choice in this strands version; structured output may fail")
        return
    for model_id in model_ids:
        _record_unsupported_mechanism("bedrock", model_id, "forced")


_never_force_tool_choice(SUPERVISOR_MODEL_ID, WORKER_MODEL_ID)


def _model(model_id: str, max_tokens: int) -> BedrockModel:
    # No temperature/top_p/top_k: Claude Opus 4.7 and later reject sampling parameters.
    return BedrockModel(model_id=model_id, region_name=REGION, max_tokens=max_tokens)


def _agent(model_id: str, max_tokens: int, system: str, activity: Optional[AgentActivity],
           on_text: Optional[Callable[[str], None]] = None, **kwargs: Any) -> Agent:
    """A Strands agent whose every streamed token and tool call is visible to the watchdog."""

    def callback(**event: Any) -> None:
        if activity is not None and ("data" in event or "reasoningText" in event or "current_tool_use" in event):
            activity.touch()
        if on_text is not None and isinstance(event.get("data"), str):
            on_text(event["data"])

    agent = Agent(model=_model(model_id, max_tokens), system_prompt=system, callback_handler=callback, **kwargs)
    # agent.cancel() alone takes effect only when the next stream event arrives, so a model that went
    # silent would never stop. A cancel_signal passed to the call also interrupts the wait itself.
    signal = threading.Event()
    agent.god_eye_cancel_signal = signal  # type: ignore[attr-defined]
    if activity is not None:
        def cancel() -> None:
            signal.set()
            agent.cancel(message="Stopped by the watchdog: no progress")

        activity.bind_cancel(cancel)

        def before_model(event: BeforeModelCallEvent) -> None:
            if activity.phase in ("searching", "reading"):
                activity.set_phase("thinking")
            else:
                activity.touch()

        def before_tool(event: BeforeToolCallEvent) -> None:
            name = str(event.tool_use.get("name", ""))
            args = event.tool_use.get("input") or {}
            if name.endswith(("WebSearch", "web_search")):
                activity.set_phase("searching", str(args.get("query", "")))
            elif name.endswith(("fetch_page", "read_page")):
                activity.set_phase("reading", str(args.get("url", "")))
            else:
                activity.touch()

        def after_tool(event: AfterToolCallEvent) -> None:
            activity.touch()

        agent.add_hook(before_model, BeforeModelCallEvent)
        agent.add_hook(before_tool, BeforeToolCallEvent)
        agent.add_hook(after_tool, AfterToolCallEvent)
    return agent


CANCEL_GRACE_SEC = 2.0


def _run(agent: Agent, prompt: str, activity: Optional[AgentActivity]) -> Any:
    """Call the agent so that a watchdog cancel returns at once.

    The synchronous agent call runs asyncio.run(), which waits for every worker thread, including one
    blocked on a silent Bedrock stream until its 120 s read timeout. So the call runs on its own thread:
    after a cancel we give Strands a short grace period to stop cleanly, then abandon that thread, which
    ends by itself when the socket read times out."""
    signal: Optional[threading.Event] = getattr(agent, "god_eye_cancel_signal", None)
    box: dict[str, Any] = {}
    done = threading.Event()

    def call() -> None:
        try:
            box["result"] = agent(prompt, cancel_signal=signal)
        except BaseException as err:  # noqa: BLE001 - re-raised on the caller's thread
            box["error"] = err
        finally:
            done.set()

    ctx = contextvars.copy_context()  # keep tracing context for the agent's spans
    threading.Thread(target=ctx.run, args=(call,), name=f"agent-{activity.agent_id if activity else 'call'}", daemon=True).start()
    while not done.wait(0.25):
        if signal is not None and signal.is_set() and not done.wait(CANCEL_GRACE_SEC):
            raise AgentCancelled(activity.agent_id if activity else "agent")
    if "error" in box:
        if activity is not None and activity.cancelled:
            raise AgentCancelled(activity.agent_id) from None
        raise box["error"]
    result = box["result"]
    if result.stop_reason == "cancelled" or (activity is not None and activity.cancelled):
        raise AgentCancelled(activity.agent_id if activity else "agent")
    return result


def _structured(agent: Agent, prompt: str, activity: Optional[AgentActivity]) -> Any:
    out = _run(agent, prompt, activity).structured_output
    if out is None:
        raise RuntimeError("the model returned no structured output")
    return out


def _findings_brief(findings: list[dict]) -> str:
    """Findings for the reviewer: questions, summaries and claims with their ids and status."""
    rows = []
    for f in findings:
        rows.append({
            "id": "F" + f["findingId"].split("-", 1)[1], "question": f["question"], "summary": f["summary"],
            "claims": [{"claimId": c["claimId"], "status": c["status"], "independentSources": c.get("independentSources", 0),
                        "text": c["text"]} for c in f.get("claims") or []],
            "keyPoints": [] if f.get("claims") else f.get("keyPoints", []),
            "sources": [s.get("title") or s.get("url") for s in f.get("sources", [])][:6],
        })
    return json.dumps(rows, ensure_ascii=False)[:60_000]


class StrandsLlm:
    def plan(self, topic: str, seed: str, brief: str = "", min_subs: int = 3, max_subs: int = 5,
             activity: Optional[AgentActivity] = None) -> PlanDraft:
        system = prompts.PLANNER.format(min_subs=min_subs, max_subs=max_subs)
        if seed:
            system += "\n\n" + prompts.PLANNER_SEED.format(seed=seed)
        if brief:
            system += "\n\n" + prompts.PLANNER_BRIEF.format(brief=brief)
        agent = _agent(SUPERVISOR_MODEL_ID, PLAN_MAX_TOKENS, system, activity, structured_output_model=PlanDraft)
        return _structured(agent, f"Research topic: {topic}", activity)

    def research(self, question: str, shape: str, tools: list, feedback: str = "",
                 activity: Optional[AgentActivity] = None, reads: int = 4, context: str = "") -> FindingDraft:
        """`context` adds run-specific instructions: the known claims of an incremental run, or the
        user's direction for a follow-up sub-question."""
        system = prompts.RESEARCHER.format(shape=shape, shape_hint=prompts.SHAPE_HINTS.get(shape, ""), reads=reads)
        if context:
            system += "\n\n" + context
        agent = _agent(WORKER_MODEL_ID, RESEARCH_MAX_TOKENS, system, activity, tools=tools,
                       structured_output_model=FindingDraft)
        prompt = f"Question: {question}" + (f"\n\n{feedback}" if feedback else "")
        return _structured(agent, prompt, activity)

    def design_ui(self, finding: dict, activity: Optional[AgentActivity] = None) -> UiSpecDraft:
        agent = _agent(WORKER_MODEL_ID, UI_MAX_TOKENS, prompts.UI_GENERATOR, activity, structured_output_model=UiSpecDraft)
        brief = {k: finding[k] for k in ("question", "dataShape", "keyPoints")}
        brief["dataPreview"] = json.dumps(finding.get("data", {}), ensure_ascii=False)[:1500]
        return _structured(agent, json.dumps(brief, ensure_ascii=False), activity)

    def review(self, topic: str, findings: list[dict], requirements: list[dict], max_follow_ups: int = 3,
               activity: Optional[AgentActivity] = None, steering: Optional[list[str]] = None) -> ReviewDraft:
        system = prompts.REVIEWER.format(max_follow_ups=max_follow_ups)
        if steering:
            system += "\n\n" + prompts.REVIEWER_STEERING.format(
                steering="\n".join(f"- {t}" for t in steering), max_follow_ups=max_follow_ups)
        agent = _agent(SUPERVISOR_MODEL_ID, PLAN_MAX_TOKENS, system, activity, structured_output_model=ReviewDraft)
        reqs = json.dumps(requirements, ensure_ascii=False)
        return _structured(agent, f"Research topic: {topic}\n\nRequirements:\n{reqs}\n\nFindings:\n{_findings_brief(findings)}",
                           activity)

    def report(self, topic: str, requirements: list[dict], catalog: str, review: Optional[ReviewDraft], words: int = 800,
               activity: Optional[AgentActivity] = None, on_text: Optional[Callable[[str], None]] = None,
               steering: Optional[list[str]] = None, update: Optional[dict] = None, brief: str = "") -> str:
        """Writes the final Markdown report; each text token goes to `on_text` as it is generated.
        `steering` are the user's directions during the run; `update` ({version, since}) marks an
        incremental run, whose report says what changed; `brief` describes the reader and scope."""
        system = prompts.REPORTER.format(words=words)
        if brief:
            system += "\n\n" + prompts.REPORTER_BRIEF.format(brief=brief)
        if steering:
            system += "\n\n" + prompts.REPORTER_STEERING.format(steering="\n".join(f"- {t}" for t in steering))
        if update:
            system += "\n\n" + prompts.REPORTER_UPDATE.format(version=update.get("version"), since=update.get("since"))
        if catalog.startswith("NO_VERIFIED_CLAIMS"):
            system += ("\n\nNo verified claims are available this time. Use the findings instead and cite them as [F1], [F2]; "
                       "say in the uncertainty section that the evidence could not be checked against the pages.")
        agent = _agent(SUPERVISOR_MODEL_ID, REPORT_MAX_TOKENS, system, activity, on_text=on_text)
        notes = review.model_dump_json(exclude={"coverage"}) if review else "{}"
        coverage = json.dumps([c.model_dump() for c in review.coverage], ensure_ascii=False) if review else "[]"
        prompt = (f"Research topic: {topic}\n\nRequirements:\n{json.dumps(requirements, ensure_ascii=False)}\n\n"
                  f"Coverage:\n{coverage}\n\nClaim catalog:\n{catalog}\n\nReview notes:\n{notes}")
        result = _run(agent, prompt, activity)
        text = "".join(block.get("text", "") for block in result.message.get("content", []) if isinstance(block, dict))
        if not text.strip():
            raise RuntimeError("the model returned an empty report")
        return text.strip()

    def verify(self, items: list[dict], activity: Optional[AgentActivity] = None) -> VerifyDraft:
        # The verifier never sees the whole report or the writer's reasoning, only one sentence and its claims.
        agent = _agent(WORKER_MODEL_ID, VERIFY_MAX_TOKENS, prompts.VERIFIER, activity, structured_output_model=VerifyDraft)
        return _structured(agent, json.dumps(items, ensure_ascii=False)[:80_000], activity)

    def revise(self, items: list[dict], activity: Optional[AgentActivity] = None) -> ReviseDraft:
        agent = _agent(WORKER_MODEL_ID, VERIFY_MAX_TOKENS, prompts.REVISER, activity, structured_output_model=ReviseDraft)
        return _structured(agent, json.dumps(items, ensure_ascii=False)[:80_000], activity)

    def answer(self, question: str, selection: str, report: str, catalog: str,
               activity: Optional[AgentActivity] = None) -> AnswerDraft:
        agent = _agent(WORKER_MODEL_ID, VERIFY_MAX_TOKENS, prompts.ANSWERER, activity, structured_output_model=AnswerDraft)
        prompt = f"Question: {question}"
        if selection:
            prompt += f"\n\nSelected passage of the report:\n{selection[:2000]}"
        prompt += f"\n\nReport (for context only; cite claims, not the report):\n{report[:12_000]}\n\nClaims:\n{catalog}"
        return _structured(agent, prompt, activity)
