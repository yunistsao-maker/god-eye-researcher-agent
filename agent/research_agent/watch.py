"""Keeps the research honest about being alive.

- Every agent (the supervisor and each sub-agent) has an `AgentActivity`. Model tokens, reasoning
  tokens and tool calls `touch()` it; step changes call `set_phase()`, which is published as
  `agent.activity`.
- The `Watchdog` thread publishes `agent.heartbeat` every few seconds, refreshes the project's
  `updatedAt` every 30 s (so a reloaded page can tell a dead run from a live one), and cancels
  any agent that produced nothing for `stall_sec` or ran past `budget_sec`. The orchestrator then
  retries that step once (`agent.stalled` with action `retrying`) or gives up (`gave_up`).
- When the user stops the research, `Tracker.halt()` cancels every agent's model call and makes any
  call that starts afterwards cancel itself at once (see stopping.py).
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

log = logging.getLogger(__name__)

ACTIVE_PHASES = {"planning", "thinking", "searching", "reading", "writing", "designing", "reviewing", "reporting", "verifying"}
# `waiting` (the supervisor while its sub-agents run), `done`, `failed` and `stopped` are not watched.


class AgentCancelled(RuntimeError):
    """The watchdog cancelled the agent's model call."""


class Stalled(RuntimeError):
    """An agent stalled on every attempt."""


@dataclass
class WatchSettings:
    stall_sec: float = 120.0
    budget_sec: float = 600.0
    heartbeat_sec: float = 10.0
    persist_sec: float = 15.0   # also how soon a stop or a steer made elsewhere is noticed
    tick_sec: float = 1.0


@dataclass
class AgentActivity:
    agent_id: str
    emit: Callable[[str, dict], None]
    clock: Callable[[], float]
    round: int = 1
    phase: str = "thinking"
    detail: str = ""
    last: float = 0.0
    attempt_started: float = 0.0
    retries_left: int = 0
    cancelled: bool = False
    halted: bool = False          # the research was stopped: never run another model call
    _cancel: Optional[Callable[[], None]] = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # --- called from agent code -------------------------------------------------------------
    def touch(self) -> None:
        self.last = self.clock()

    def set_phase(self, phase: str, detail: str = "") -> None:
        detail = (detail or "")[:200]
        self.touch()
        if phase == self.phase and detail == self.detail:
            return
        self.phase, self.detail = phase, detail
        data = {"agentId": self.agent_id, "phase": phase, "round": self.round}
        if detail:
            data["detail"] = detail
        self.emit("agent.activity", data)

    def bind_cancel(self, cancel: Callable[[], None]) -> None:
        with self._lock:
            self._cancel = cancel
            fire = self.halted and not self.cancelled
            if fire:
                self.cancelled = True
        if fire:  # a call that starts after the stop is cancelled before it reaches the model
            self._invoke(cancel)

    def begin_attempt(self, retries_left: int) -> None:
        with self._lock:
            self.cancelled = False
            self._cancel = None
            self.retries_left = retries_left
        self.attempt_started = self.clock()
        self.touch()

    def end_attempt(self) -> None:
        """The LLM call is over; nothing is left for the watchdog to cancel."""
        with self._lock:
            self._cancel = None
        self.attempt_started = 0.0
        self.touch()

    # --- called from the watchdog -------------------------------------------------------------
    def cancel(self) -> bool:
        with self._lock:
            if self.cancelled or self._cancel is None:
                return False
            self.cancelled = True
            cancel = self._cancel
        self._invoke(cancel)
        return True

    def halt(self) -> None:
        """Stop for good: cancel the current model call, if any, and every later one."""
        with self._lock:
            self.halted = True
        self.cancel()

    def _invoke(self, cancel: Callable[[], None]) -> None:
        try:
            cancel()
        except Exception:  # noqa: BLE001
            log.exception("cancelling %s failed", self.agent_id)

    @property
    def active(self) -> bool:
        return self.phase in ACTIVE_PHASES


class Tracker:
    def __init__(self, emit: Callable[[str, dict], None], clock: Callable[[], float] = time.monotonic):
        self.emit = emit
        self.clock = clock
        self.started = clock()
        self.halted = False
        self._agents: dict[str, AgentActivity] = {}
        self._lock = threading.Lock()

    def agent(self, agent_id: str, round: int = 1) -> AgentActivity:
        act = AgentActivity(agent_id=agent_id, emit=self.emit, clock=self.clock, round=round, last=self.clock())
        with self._lock:
            act.halted = self.halted
            self._agents[agent_id] = act
        return act

    def halt(self) -> None:
        """The research was stopped: cancel every agent, including ones created from now on."""
        with self._lock:
            self.halted = True
            agents = list(self._agents.values())
        for act in agents:
            act.halt()

    def agents(self) -> list[AgentActivity]:
        with self._lock:
            return list(self._agents.values())


class Watchdog:
    def __init__(self, tracker: Tracker, settings: WatchSettings, persist: Optional[Callable[[], None]] = None):
        self.tracker = tracker
        self.settings = settings
        self.persist = persist
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        now = tracker.clock()
        self._next_heartbeat = now
        self._next_persist = now + settings.persist_sec

    def start(self) -> "Watchdog":
        self._thread = threading.Thread(target=self._loop, name="watchdog", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.wait(self.settings.tick_sec):
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the watchdog must outlive any single failure
                log.exception("watchdog tick failed")

    def tick(self) -> None:
        now = self.tracker.clock()
        agents = self.tracker.agents()
        for act in agents:
            if not act.active or act.cancelled or act.halted:
                continue
            idle = now - act.last
            over_budget = act.attempt_started and now - act.attempt_started > self.settings.budget_sec
            if idle > self.settings.stall_sec or over_budget:
                if act.cancel():
                    action = "retrying" if act.retries_left > 0 else "gave_up"
                    log.warning("%s stalled (idle %.0fs, budget exceeded=%s): %s", act.agent_id, idle, bool(over_budget), action)
                    self.tracker.emit("agent.stalled", {"agentId": act.agent_id, "idleSec": round(idle), "action": action})
        if now >= self._next_heartbeat:
            self._next_heartbeat = now + self.settings.heartbeat_sec
            self.tracker.emit("agent.heartbeat", {
                "elapsedSec": round(now - self.tracker.started),
                "agents": [{"agentId": a.agent_id, "phase": a.phase, "idleSec": round(now - a.last)} for a in agents if a.active],
            })
        if self.persist and now >= self._next_persist:
            self._next_persist = now + self.settings.persist_sec
            try:
                self.persist()
            except Exception:  # noqa: BLE001
                log.exception("persisting the heartbeat failed")
