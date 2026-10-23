"""Publish research events to AppSync Events over HTTP with IAM (SigV4) auth.

Channel: /research/{projectId}. Each event is one JSON object, sent as a JSON string
(AppSync Events requires stringified JSON values, at most 5 per request).
"""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone
from typing import Any, Iterable

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

NAMESPACE = "research"
_session = boto3.Session()


def channel_for(project_id: str) -> str:
    return f"/{NAMESPACE}/{project_id}"


def make_event(event_type: str, project_id: str, data: dict[str, Any]) -> dict[str, Any]:
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {"type": event_type, "projectId": project_id, "ts": ts, "data": data}


def publish(project_id: str, events: Iterable[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Publish (type, data) pairs to the project's channel. Returns the event objects sent."""
    built = [make_event(t, project_id, d) for t, d in events]
    domain = os.environ.get("EVENTS_HTTP_DOMAIN", "")
    if not domain:
        # Local tests and dry runs: nothing to send to.
        return built
    region = os.environ.get("AWS_REGION") or _session.region_name
    url = f"https://{domain}/event"
    for i in range(0, len(built), 5):
        body = json.dumps(
            {"channel": channel_for(project_id), "events": [json.dumps(e, ensure_ascii=False) for e in built[i : i + 5]]},
            ensure_ascii=False,
        ).encode("utf-8")
        creds = _session.get_credentials().get_frozen_credentials()
        aws_req = AWSRequest(method="POST", url=url, data=body, headers={"content-type": "application/json"})
        SigV4Auth(creds, "appsync", region).add_auth(aws_req)
        req = urllib.request.Request(url, data=body, headers=dict(aws_req.headers.items()), method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (fixed https host)
            payload = json.loads(resp.read() or b"{}")
            failed = payload.get("failed") or []
            if failed:
                raise RuntimeError(f"AppSync rejected {len(failed)} event(s): {failed}")
    return built
