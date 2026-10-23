"""Steps of the project cleanup state machine. Every step is idempotent so Step Functions can
retry a failed step without side effects. Input/output: {"projectId", "owner", ...}.
"""
from __future__ import annotations

import io
import os
import zipfile
from typing import Any

import boto3
from botocore.exceptions import ClientError

from common import appsync, store

ARCHIVE_TTL_DAYS = int(os.environ.get("ARCHIVE_TTL_DAYS", "30"))


def _runtime_arn() -> str:
    """The research runtime is created after the CDK stack, so its ARN lives in SSM."""
    if os.environ.get("RESEARCH_RUNTIME_ARN"):
        return os.environ["RESEARCH_RUNTIME_ARN"]
    name = os.environ.get("RUNTIME_ARN_PARAM")
    if not name:
        return ""
    value = boto3.client("ssm").get_parameter(Name=name)["Parameter"]["Value"]
    return value if value.startswith("arn:") else ""


def stop_session(event: dict) -> dict:
    """Best effort only. project_cleanup refuses running projects, and stopping a run ends its session
    from inside the runtime with the user's token. This SigV4 call works only if the runtime is switched
    to IAM inbound auth; a JWT-authorized runtime answers AccessDenied ("Authorization method mismatch")."""
    meta = store.get_meta(event["projectId"]) or {}
    session_id = meta.get("runtimeSessionId")
    runtime_arn = _runtime_arn() if session_id else ""
    if session_id and runtime_arn:
        try:
            boto3.client("bedrock-agentcore").stop_runtime_session(runtimeSessionId=session_id, agentRuntimeArn=runtime_arn)
        except ClientError as err:  # already stopped or expired: nothing to do
            print(f"stop_runtime_session: {err.response['Error']['Code']}")
    return event


def export_archive(event: dict) -> dict:
    pid = event["projectId"]
    s3 = store.s3_client()
    prefix = store.project_prefix(pid)
    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=store.bucket(), Prefix=prefix):
            for obj in page.get("Contents", []):
                rel = obj["Key"][len(prefix):]
                # Page text snapshots stay out of the archive; their metadata (docs/*.json) keeps every citation resolvable.
                if rel.startswith(("findings/", "graph/", "ui/")) or rel in ("manifest.json", "synthesis.json", "synthesis.md") or (
                        rel.startswith("docs/") and rel.endswith(".json")):
                    zf.writestr(rel, s3.get_object(Bucket=store.bucket(), Key=obj["Key"])["Body"].read())
                    count += 1
    key = f"archive/{pid}.zip"
    s3.put_object(Bucket=store.bucket(), Key=key, Body=buf.getvalue(), ContentType="application/zip")
    return {**event, "archiveKey": key, "archivedObjects": count}


def tag_objects(event: dict) -> dict:
    """Tag the project's objects; the bucket lifecycle rule on status=archived expires them."""
    s3 = store.s3_client()
    tagged = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=store.bucket(), Prefix=store.project_prefix(event["projectId"])):
        for obj in page.get("Contents", []):
            s3.put_object_tagging(Bucket=store.bucket(), Key=obj["Key"], Tagging={"TagSet": [{"Key": "status", "Value": "archived"}]})
            tagged += 1
    return {**event, "taggedObjects": tagged}


def set_ttl(event: dict) -> dict:
    pid = event["projectId"]
    expires = store.epoch() + ARCHIVE_TTL_DAYS * 86400
    tbl = store.table()
    meta = store.get_meta(pid) or {}
    keys = [{"PK": i["PK"], "SK": i["SK"]} for i in store.query_project(pid)]
    if meta.get("owner") and meta.get("ownerSk"):
        keys.append({"PK": f"OWNER#{meta['owner']}", "SK": meta["ownerSk"]})
    for key in keys:
        tbl.update_item(Key=key, UpdateExpression="SET expiresAt = :e", ExpressionAttributeValues={":e": expires})
    return {**event, "expiringItems": len(keys)}


def delete_vectors(event: dict) -> dict:
    """Phase 2 writes embeddings to S3 Vectors keyed by projectId; the MVP writes none."""
    return {**event, "deletedVectors": 0}


def publish_archived(event: dict) -> dict:
    pid = event["projectId"]
    store.table().update_item(
        Key={"PK": store.project_pk(pid), "SK": "META"},
        UpdateExpression="SET #s = :s, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "archived", ":u": store.now_iso()},
    )
    appsync.publish(pid, [("project.archived", {})])
    return {**event, "status": "archived"}


STEPS = {
    "stop_session": stop_session,
    "export_archive": export_archive,
    "tag_objects": tag_objects,
    "set_ttl": set_ttl,
    "delete_vectors": delete_vectors,
    "publish_archived": publish_archived,
}


def handler(event: dict, context: Any) -> dict:
    step = event.pop("step")
    return STEPS[step](event)
