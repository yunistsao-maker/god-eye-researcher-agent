"""Optional second search index and page extractor (Tavily or Exa).

The primary search is the managed AgentCore Web Search connector. A second provider widens recall
for long-tail and semantic queries and rescues pages the plain fetcher cannot read (blocked, PDF,
JavaScript-heavy). It is off unless SEARCH_SECRET_ARN names a Secrets Manager secret holding
{"provider": "tavily" | "exa", "apiKey": "..."}.

Request and response shapes follow each provider's public REST API; only the fields used here are
read, so additions on their side do not break us.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

import boto3

from .toolkit import ToolError

TIMEOUT_SEC = 20
_cache: dict[str, Any] = {}


def config() -> Optional[dict]:
    """{"provider", "apiKey"} or None when no second provider is configured."""
    arn = os.environ.get("SEARCH_SECRET_ARN", "")
    if not arn:
        return None
    if arn not in _cache:
        raw = boto3.client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"]
        value = json.loads(raw)
        provider = str(value.get("provider", "")).lower()
        if provider not in ("tavily", "exa") or not value.get("apiKey"):
            raise ToolError("SEARCH_SECRET_ARN must hold {provider: tavily|exa, apiKey}")
        _cache[arn] = {"provider": provider, "apiKey": value["apiKey"]}
    return _cache[arn]


def _post(url: str, body: dict, headers: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:  # noqa: S310 - fixed https endpoints
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raise ToolError(f"search provider returned HTTP {err.code}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise ToolError(f"search provider unreachable: {getattr(err, 'reason', err)}") from err


def search(query: str, *, max_results: int = 8, include_domains: Optional[list[str]] = None,
           exclude_domains: Optional[list[str]] = None, start_date: Optional[str] = None) -> dict:
    cfg = config()
    if not cfg:
        raise ToolError("Secondary search is not configured")
    if cfg["provider"] == "tavily":
        body: dict[str, Any] = {"query": query[:400], "max_results": max_results, "search_depth": "basic"}
        if include_domains:
            body["include_domains"] = include_domains
        if exclude_domains:
            body["exclude_domains"] = exclude_domains
        if start_date:
            body["start_date"] = start_date
        data = _post("https://api.tavily.com/search", body, {"Authorization": f"Bearer {cfg['apiKey']}"})
        results = [{"title": r.get("title") or "", "url": r.get("url") or "", "snippet": (r.get("content") or "")[:600],
                    "publishedDate": r.get("published_date")} for r in data.get("results", [])]
    else:
        body = {"query": query[:400], "numResults": max_results, "type": "auto",
                "contents": {"highlights": {"numSentences": 3}}}
        if include_domains:
            body["includeDomains"] = include_domains
        if exclude_domains:
            body["excludeDomains"] = exclude_domains
        if start_date:
            body["startPublishedDate"] = f"{start_date}T00:00:00.000Z"
        data = _post("https://api.exa.ai/search", body, {"x-api-key": cfg["apiKey"]})
        results = [{"title": r.get("title") or "", "url": r.get("url") or "",
                    "snippet": " ".join(r.get("highlights") or [])[:600] or (r.get("text") or "")[:600],
                    "publishedDate": (r.get("publishedDate") or "")[:10] or None} for r in data.get("results", [])]
    return {"provider": cfg["provider"], "results": [r for r in results if r["url"].startswith(("http://", "https://"))]}


def extract(url: str) -> Optional[dict]:
    """Readable text of one page from the provider, or None if it could not read it either."""
    cfg = config()
    if not cfg:
        return None
    if cfg["provider"] == "tavily":
        data = _post("https://api.tavily.com/extract", {"urls": [url], "extract_depth": "basic"},
                     {"Authorization": f"Bearer {cfg['apiKey']}"})
        for r in data.get("results", []):
            if r.get("raw_content"):
                return {"title": r.get("title") or "", "text": r["raw_content"], "publishedDate": None, "via": "tavily"}
        return None
    data = _post("https://api.exa.ai/contents", {"urls": [url], "text": True}, {"x-api-key": cfg["apiKey"]})
    for r in data.get("results", []):
        if r.get("text"):
            return {"title": r.get("title") or "", "text": r["text"],
                    "publishedDate": (r.get("publishedDate") or "")[:10] or None, "via": "exa"}
    return None
