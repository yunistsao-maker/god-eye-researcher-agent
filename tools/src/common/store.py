"""DynamoDB single-table + S3 helpers.

Table layout (PK / SK):
  PROJECT#{id}   META                     project record (owner, topic, status, counts)
  PROJECT#{id}   PLAN                     sub-questions
  PROJECT#{id}   FINDING#{findingId}      full finding JSON
  PROJECT#{id}   ENTITY#{entityId}        name, type, findings (string set)
  PROJECT#{id}   EDGE#{from}#{type}#{to}  one relationship edge
  PROJECT#{id}   UI#{findingId}           sub-UI spec applied to that finding
  PROJECT#{id}   DOC#{docId}              source document: canonical URL, publisher, date, score, fingerprints
                                          (its text is in S3 at projects/{id}/docs/{docId}.txt)
  PROJECT#{id}   COVERAGE                 requirement checklist status after each review
  OWNER#{sub}    PROJECT#{createdAt}#{id} pointer for the user's project list
  TEMPLATE#{shape} V#1                    shared sub-UI template (never cleaned up)
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

_ddb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")


def table():
    return _ddb.Table(os.environ["TABLE_NAME"])


def bucket() -> str:
    return os.environ["BUCKET_NAME"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def epoch() -> int:
    return int(time.time())


def to_plain(value: Any) -> Any:
    """Convert DynamoDB Decimals and sets into JSON-friendly values."""
    if isinstance(value, list):
        return [to_plain(v) for v in value]
    if isinstance(value, set):
        return sorted(to_plain(v) for v in value)
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def to_ddb(value: Any) -> Any:
    """Convert floats to Decimal for DynamoDB."""
    return json.loads(json.dumps(value), parse_float=Decimal)


def project_pk(project_id: str) -> str:
    return f"PROJECT#{project_id}"


def get_meta(project_id: str) -> dict | None:
    item = table().get_item(Key={"PK": project_pk(project_id), "SK": "META"}).get("Item")
    return to_plain(item) if item else None


def query_project(project_id: str, prefix: str | None = None) -> list[dict]:
    cond = Key("PK").eq(project_pk(project_id))
    if prefix:
        cond = cond & Key("SK").begins_with(prefix)
    items: list[dict] = []
    kwargs: dict[str, Any] = {"KeyConditionExpression": cond}
    while True:
        page = table().query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return [to_plain(i) for i in items]
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def put_json(key: str, body: Any) -> str:
    _s3.put_object(
        Bucket=bucket(),
        Key=key,
        Body=json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )
    return key


def project_prefix(project_id: str) -> str:
    return f"projects/{project_id}/"


def s3_client():
    return _s3


def doc_key(project_id: str, doc_id: str, ext: str = "txt") -> str:
    return f"{project_prefix(project_id)}docs/{doc_id}.{ext}"


def read_text(key: str) -> str | None:
    try:
        obj = _s3.get_object(Bucket=bucket(), Key=key)
    except Exception:  # noqa: BLE001 - a missing object is reported by the caller
        return None
    return obj["Body"].read().decode("utf-8")
