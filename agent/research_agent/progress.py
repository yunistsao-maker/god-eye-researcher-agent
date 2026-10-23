"""Live progress from the research runtime straight to AppSync Events.

Progress events (agent.activity, agent.heartbeat, agent.stalled, synthesis.delta) are not stored,
so they skip the tools gateway and are published here with the runtime role (IAM / SigV4).
Publishing never blocks or breaks the research: events are queued, flushed in batches by a
background thread, and dropped with a log line if AppSync is unreachable.
"""
from __future__ import annotations

import json
import logging
import threading
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

NAMESPACE = "research"
MAX_EVENTS_PER_REQUEST = 5        # AppSync Events limit per publish request
MAX_EVENT_BYTES = 200_000         # AppSync Events limit is 240 KB per event


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_sigv4_sender(domain: str, region: str) -> Callable[[str, list[dict]], None]:
    """Returns send(channel, events) that publishes over HTTPS with the runtime's credentials."""
    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = boto3.Session()
    url = f"https://{domain}/event"

    def send(channel: str, events: list[dict]) -> None:
        body = json.dumps({"channel": channel, "events": [json.dumps(e, ensure_ascii=False) for e in events]},
                          ensure_ascii=False).encode("utf-8")
        creds = session.get_credentials().get_frozen_credentials()
        req = AWSRequest(method="POST", url=url, data=body, headers={"content-type": "application/json"})
        SigV4Auth(creds, "appsync", region).add_auth(req)
        http = urllib.request.Request(url, data=body, headers=dict(req.headers.items()), method="POST")
        with urllib.request.urlopen(http, timeout=5) as resp:  # noqa: S310 (fixed https host)
            failed = json.loads(resp.read() or b"{}").get("failed") or []
            if failed:
                raise RuntimeError(f"AppSync rejected {len(failed)} event(s)")

    return send


class Publisher:
    """Queues progress events for one project and flushes them every `interval` seconds.

    `append_text` collects streamed report text; each flush turns what has accumulated into one
    `synthesis.delta` event with an increasing `seq`, so the UI can order and de-duplicate chunks.
    """

    def __init__(self, project_id: str, send: Optional[Callable[[str, list[dict]], None]], interval: float = 0.3):
        self.project_id = project_id
        self.channel = f"/{NAMESPACE}/{project_id}"
        self._send = send
        self._interval = interval
        self._lock = threading.Lock()
        self._queue: list[dict] = []
        self._text: list[str] = []
        self._seq = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.sent = 0
        self.dropped = 0

    def start(self) -> "Publisher":
        if self._send and not self._thread:
            self._thread = threading.Thread(target=self._loop, name="progress-publisher", daemon=True)
            self._thread.start()
        return self

    def emit(self, event_type: str, data: dict[str, Any]) -> None:
        event = {"type": event_type, "projectId": self.project_id, "ts": utc_now(), "data": data}
        with self._lock:
            self._queue.append(event)

    def append_text(self, text: str) -> None:
        if text:
            with self._lock:
                self._text.append(text)

    def flush(self) -> None:
        with self._lock:
            events, self._queue = self._queue, []
            if self._text:
                text, self._text = "".join(self._text), []
                for start in range(0, len(text), MAX_EVENT_BYTES // 4):
                    self._seq += 1
                    events.append({"type": "synthesis.delta", "projectId": self.project_id, "ts": utc_now(),
                                   "data": {"seq": self._seq, "text": text[start:start + MAX_EVENT_BYTES // 4]}})
        if not events or not self._send:
            return
        for i in range(0, len(events), MAX_EVENTS_PER_REQUEST):
            batch = events[i:i + MAX_EVENTS_PER_REQUEST]
            try:
                self._send(self.channel, batch)
                self.sent += len(batch)
            except Exception as err:  # noqa: BLE001 - progress is best effort
                self.dropped += len(batch)
                log.warning("progress publish failed (%d events dropped): %s", len(batch), err)

    def close(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self.flush()

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self.flush()
