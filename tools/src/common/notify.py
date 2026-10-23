"""Email at the end of a run (Amazon SES), for projects whose owner turned it on (project_notify).

Configured by the deployment: NOTIFY_FROM (a verified SES identity), USER_POOL_ID (to look up the
owner's email from their Cognito `sub`) and the web app's URL, either WEB_URL or the SSM parameter
named by WEB_URL_PARAM (written by the web stack, which is deployed after this Lambda). Without
NOTIFY_FROM the feature is off. Sending is best effort: a failure is logged and never fails the tool.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

import boto3

log = logging.getLogger(__name__)
SUB = re.compile(r"^[A-Za-z0-9-]{1,128}$")
_web_url: Optional[str] = None


def available() -> bool:
    return bool(os.environ.get("NOTIFY_FROM") and os.environ.get("USER_POOL_ID"))


def email_of(sub: str) -> Optional[str]:
    if not SUB.match(sub or ""):
        return None
    res = boto3.client("cognito-idp").list_users(UserPoolId=os.environ["USER_POOL_ID"], Filter=f'sub = "{sub}"', Limit=1)
    for user in res.get("Users", []):
        attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
        if attrs.get("email"):
            return attrs["email"]
    return None


def web_url() -> str:
    global _web_url
    if _web_url is None:
        url = os.environ.get("WEB_URL", "")
        param = os.environ.get("WEB_URL_PARAM", "")
        if not url and param:
            try:
                url = boto3.client("ssm").get_parameter(Name=param)["Parameter"]["Value"]
            except Exception:  # noqa: BLE001 - the web stack may not be deployed yet
                log.warning("web URL parameter %s is not readable", param)
                url = ""
        _web_url = url.rstrip("/")
    return _web_url


def message(meta: dict, status: str, detail: str = "") -> tuple[str, str]:
    topic = str(meta.get("topic") or meta.get("projectId"))
    pid = meta["projectId"]
    base = web_url()
    link = f"{base}/#/p/{pid}/report" if base else f"（專案 {pid}）"
    stats = meta.get("stats") or {}
    if status == "completed":
        subject = f"研究完成：{topic}"[:180]
        body = (f"你的研究「{topic}」已完成。\n\n"
                f"查證過的主張 {stats.get('claims', 0)} 個，來源 {stats.get('sources', 0)} 個。\n\n開啟報告：{link}\n")
    else:
        subject = f"研究未完成：{topic}"[:180]
        body = (f"你的研究「{topic}」沒有完成：{detail or '研究過程發生錯誤'}\n\n"
                f"已完成的子題仍保留在專案裡：{link}\n")
    return subject, body + "\n— God Eye Researcher（你在專案中開啟了完成通知；可在研究畫面關閉）\n"


def project_ended(meta: dict, status: str, detail: str = "") -> bool:
    """Send the end-of-run email when the owner asked for it. Returns whether one was sent."""
    if not meta.get("notify") or not available():
        return False
    try:
        to = email_of(str(meta.get("owner", "")))
        if not to:
            log.warning("no email for the owner of %s", meta.get("projectId"))
            return False
        subject, body = message(meta, status, detail)
        boto3.client("sesv2").send_email(
            FromEmailAddress=os.environ["NOTIFY_FROM"],
            Destination={"ToAddresses": [to]},
            Content={"Simple": {"Subject": {"Data": subject, "Charset": "UTF-8"}, "Body": {"Text": {"Data": body, "Charset": "UTF-8"}}}},
        )
        return True
    except Exception:  # noqa: BLE001 - never fail the run because an email could not go out
        log.exception("could not send the end-of-run email for %s", meta.get("projectId"))
        return False
