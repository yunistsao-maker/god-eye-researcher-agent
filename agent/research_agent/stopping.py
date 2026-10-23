"""Stopping a research run when the user asks (contracts/events.md, "Stopping a run").

Two layers:

- Cooperative. `StopSignal.stop()` halts the tracker, which cancels every agent's model call (and
  any call that starts later). The orchestrator checks the signal between steps and before every
  tool call; `ResearchStopped` then unwinds the run without marking it failed.
- Hard. Once the run has unwound, the runtime ends its own AgentCore session with
  StopRuntimeSession. That terminates the microVM, including model calls the cancel could only
  abandon (they wait on a Bedrock socket for up to 120 s). The runtime uses a JWT authorizer,
  which refuses SigV4 calls ("Authorization method mismatch"), so the call carries the user's
  bearer token, the same way the runtime is invoked.
"""
from __future__ import annotations

import base64
import json
import logging
import threading
import time
import uuid
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)


class ResearchStopped(BaseException):
    """The research was stopped on purpose.

    Like asyncio.CancelledError this derives from BaseException, so the `except Exception` blocks
    that keep one failing sub-agent from taking down the others let it through untouched."""


class StopSignal:
    def __init__(self, tracker: Any = None):
        self.tracker = tracker
        self.reason = ""
        self.token = ""          # the freshest bearer token of whoever asked to stop
        self._event = threading.Event()
        self._lock = threading.Lock()

    def stop(self, reason: str, token: str = "") -> bool:
        """Returns True for the call that stopped the run, False if it was already stopped."""
        with self._lock:
            if token:
                self.token = token
            if self._event.is_set():
                return False
            self.reason = reason
            self._event.set()
        log.info("research stop requested (%s)", reason)
        if self.tracker is not None:
            self.tracker.halt()
        return True

    @property
    def is_set(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise ResearchStopped(self.reason or "stopped")


def jwt_subject(token: str) -> str:
    """The `sub` claim of a JWT, read without verification. Only use it on tokens the runtime's JWT
    authorizer already validated (every bearer token that reaches the entrypoint)."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        sub = claims.get("sub")
        return sub if isinstance(sub, str) else ""
    except (IndexError, ValueError, AttributeError):
        return ""


class StopSessionError(RuntimeError):
    pass


RETRYABLE = {409, 429, 500, 502, 503, 504}   # 409 = RetryableConflictException (session still starting or ending)


def stop_runtime_session(runtime_arn: str, session_id: str, bearer_token: str, region: str, *,
                         qualifier: str = "DEFAULT", timeout: float = 10.0, attempts: int = 4,
                         opener: Callable[..., Any] = urlopen, sleep: Callable[[float], None] = time.sleep) -> str:
    """Call the AgentCore data plane's StopRuntimeSession with an OAuth bearer token.

    Returns "stopped", or "not_found" when the session is already gone. Raises StopSessionError
    otherwise. One client token is reused across retries, so a retry never stops twice."""
    if not (runtime_arn and session_id and bearer_token):
        raise StopSessionError("runtime ARN, session id and bearer token are all required")
    url = (f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{quote(runtime_arn, safe='')}"
           f"/stopruntimesession?qualifier={quote(qualifier, safe='')}")
    body = json.dumps({"clientToken": str(uuid.uuid4())}).encode()
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
    }
    for attempt in range(attempts):
        try:
            with opener(Request(url, data=body, headers=headers, method="POST"), timeout=timeout):
                return "stopped"
        except HTTPError as err:
            if err.code == 404:
                return "not_found"
            detail = ""
            try:
                detail = err.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            if err.code in RETRYABLE and attempt < attempts - 1:
                sleep(0.5 * 2 ** attempt)
                continue
            raise StopSessionError(f"StopRuntimeSession HTTP {err.code}: {detail}") from None
        except (URLError, TimeoutError) as err:
            if attempt < attempts - 1:
                sleep(0.5 * 2 ** attempt)
                continue
            raise StopSessionError(f"StopRuntimeSession unreachable: {err}") from None
    raise StopSessionError("StopRuntimeSession: no attempts made")
