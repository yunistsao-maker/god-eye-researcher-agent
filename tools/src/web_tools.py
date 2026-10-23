"""web-tools target: fetch_page, search_web, url_check.

The primary search is the managed AgentCore Web Search connector (target `web-search`, tool
`WebSearch`). This Lambda reads pages, offers an optional second search index, and checks links.

fetch_page with a projectId registers the page as a source document of that project:
  - the URL is canonicalized and the page gets a stable docId (d-<sha1 of the canonical URL>);
  - the readable text is stored once in S3 (projects/{pid}/docs/{docId}.txt) and a DOC# record keeps
    its publisher, publication date, source type, quality score and fingerprints;
  - a page whose text duplicates an earlier one (same hash, or MinHash similarity >= 0.8) is marked
    duplicateOf that page, so a syndicated copy never counts as independent corroboration.
Later reads of the same URL come from the stored snapshot, so every quote is checked against exactly
the text the agent saw. Long pages are read in slices with `offset`.

Reading is tiered: plain HTTP first; if the page is blocked, not HTML/text (e.g. PDF), or yields
almost no text (a JavaScript app), the optional provider extractor is tried. robots.txt is honoured
for both tiers. fetch_page and url_check refuse private, loopback and link-local addresses so a
prompt-injected URL cannot reach internal endpoints.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from typing import Any, Optional

from common import appsync, providers, sources, store
from common.toolkit import ToolError, caller, dispatch, require_project_id, require_writable

MAX_BYTES = 3_000_000
MIN_TEXT_CHARS = 300
UA = "GodEyeResearcher/0.2 (+research agent)"
RESPECT_ROBOTS = os.environ.get("RESPECT_ROBOTS", "true").lower() != "false"
BLOCKED_DOMAINS = sources.parse_domain_list(os.environ.get("BLOCKED_DOMAINS", ""))
_robots: dict[str, Optional[urllib.robotparser.RobotFileParser]] = {}


class Unreadable(ToolError):
    """The plain fetch could not get usable text; the provider extractor may still succeed."""


def _is_public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def _check_url(url: Any) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(url if isinstance(url, str) else "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ToolError("url must be an http(s) URL")
    if not _is_public_host(parsed.hostname):
        raise ToolError("Only public internet addresses can be fetched")
    return parsed


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "svg", "form", "aside", "button", "template"}
    BLOCK = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "tr", "section", "article", "table", "blockquote", "pre"}
    MAIN = {"article", "main"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.main_parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._main = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        else:
            if tag in self.MAIN:
                self._main += 1
            if tag in self.BLOCK:
                self.parts.append("\n")
                if self._main:
                    self.main_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.MAIN and self._main:
            self._main -= 1

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)
            if self._main:
                self.main_parts.append(data)

    @staticmethod
    def _clean(parts: list[str]) -> str:
        lines = [" ".join(line.split()) for line in "".join(parts).splitlines()]
        return "\n".join(line for line in lines if line)

    def text(self) -> str:
        main = self._clean(self.main_parts)
        return main if len(main) >= MIN_TEXT_CHARS else self._clean(self.parts)


class _NoRedirectToPrivate(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        host = urllib.parse.urlparse(newurl).hostname or ""
        if not _is_public_host(host):
            raise ToolError("Redirect to a non-public address was blocked")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _robots_allowed(parsed: urllib.parse.SplitResult) -> bool:
    if not RESPECT_ROBOTS:
        return True
    base = f"{parsed.scheme}://{parsed.netloc}"
    if base not in _robots:
        rp: Optional[urllib.robotparser.RobotFileParser] = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.build_opener(_NoRedirectToPrivate()).open(req, timeout=5) as resp:
                rp.parse(resp.read(200_000).decode("utf-8", errors="replace").splitlines())  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - no readable robots.txt means no restriction
            rp = None
        _robots[base] = rp
    rp = _robots[base]
    return rp is None or rp.can_fetch(UA, urllib.parse.urlunsplit(parsed))


def _fetch_direct(url: str) -> dict:
    """Plain HTTP GET and HTML text extraction. Raises Unreadable when another tier should try."""
    opener = urllib.request.build_opener(_NoRedirectToPrivate())
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,text/plain;q=0.9,*/*;q=0.5"})
    try:
        with opener.open(req, timeout=12) as resp:
            ctype = resp.headers.get("Content-Type", "")
            final_url = resp.geturl()
            if not any(t in ctype for t in ("text/html", "text/plain", "application/xhtml")):
                raise Unreadable(f"Unsupported content type: {ctype or 'unknown'}")
            raw = resp.read(MAX_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as err:
        if err.code in (401, 403, 406, 429, 451) or err.code >= 500:
            raise Unreadable(f"Page returned HTTP {err.code}") from err
        raise ToolError(f"Page returned HTTP {err.code}") from err
    except urllib.error.URLError as err:
        raise Unreadable(f"Could not fetch page: {err.reason}") from err
    except TimeoutError as err:
        raise Unreadable("Page timed out") from err
    body = raw.decode(charset, errors="replace")
    if "text/plain" in ctype:
        return {"title": "", "text": body, "publishedDate": None, "finalUrl": final_url, "via": "direct"}
    parser = _TextExtractor()
    parser.feed(body)
    text = parser.text()
    if len(text) < MIN_TEXT_CHARS:
        raise Unreadable("The page has almost no readable text (it may need JavaScript)")
    return {"title": parser.title.strip()[:300], "text": text, "publishedDate": sources.published_date(body),
            "finalUrl": final_url, "via": "direct"}


def _read(url: str) -> dict:
    try:
        return _fetch_direct(url)
    except Unreadable as first:
        try:
            got = providers.extract(url)
        except ToolError:
            got = None
        if not got or len(got.get("text") or "") < 100:
            raise ToolError(str(first)) from first
        return {**got, "finalUrl": url}


def _slice(text: str, offset: int, max_chars: int) -> dict:
    offset = max(0, min(offset, len(text)))
    end = min(len(text), offset + max_chars)
    return {"text": text[offset:end], "offset": offset, "nextOffset": end if end < len(text) else None, "totalChars": len(text)}


def _public_doc(doc: dict) -> dict:
    keys = ("docId", "url", "canonicalUrl", "title", "publisher", "publishedDate", "sourceType", "score", "duplicateOf", "via", "fetchedAt")
    return {k: store.to_plain(doc.get(k)) for k in keys}


def _register(pid: str, url: str, canonical: str, doc: str, got: dict) -> dict:
    text = got["text"]
    fingerprint = sources.minhash(text)
    digest = sources.content_hash(text)
    duplicate_of = None
    for other in store.query_project(pid, "DOC#"):
        if other.get("docId") == doc or other.get("status") != "ok":
            continue
        if other.get("contentHash") == digest or sources.similarity(fingerprint, other.get("minhash") or []) >= sources.NEAR_DUPLICATE:
            duplicate_of = other.get("duplicateOf") or other["docId"]
            break
    blocked = sources.is_blocked(url, BLOCKED_DOMAINS)
    score, reasons = sources.score_source(url, got.get("publishedDate"), blocked=blocked)
    record = {
        "docId": doc, "url": url, "canonicalUrl": canonical, "title": (got.get("title") or "")[:300] or canonical,
        "publisher": sources.publisher(url), "publishedDate": got.get("publishedDate"), "sourceType": sources.source_type(url),
        "score": score, "scoreReasons": reasons, "contentHash": digest, "minhash": fingerprint, "duplicateOf": duplicate_of,
        "chars": len(text), "via": got.get("via", "direct"), "fetchedAt": store.now_iso(), "status": "ok",
        "s3Key": store.doc_key(pid, doc, "txt"),
    }
    store.s3_client().put_object(Bucket=store.bucket(), Key=record["s3Key"], Body=text.encode("utf-8"),
                                 ContentType="text/plain; charset=utf-8")
    store.put_json(store.doc_key(pid, doc, "json"), {k: v for k, v in record.items() if k != "minhash"})
    store.table().put_item(Item={"PK": store.project_pk(pid), "SK": f"DOC#{doc}", **store.to_ddb(record)})
    appsync.publish(pid, [("source.added", {"doc": _public_doc(record)})])
    return record


def fetch_page(event: dict) -> dict:
    sub = caller(event)
    url = event.get("url")
    parsed = _check_url(url)
    max_chars = min(max(int(event.get("maxChars") or 8000), 500), 20000)
    offset = max(0, int(event.get("offset") or 0))
    pid = event.get("projectId")

    if not pid:  # stateless read, as before
        if not _robots_allowed(parsed):
            raise ToolError("robots.txt does not allow reading this page")
        got = _read(url)
        return {"ok": True, "url": url, "title": got.get("title", ""), "publishedDate": got.get("publishedDate"),
                **_slice(got["text"], offset, max_chars)}

    pid = require_project_id(event)
    require_writable(pid, sub)
    canonical = sources.canonical_url(url)
    doc = sources.doc_id(canonical)
    existing = store.table().get_item(Key={"PK": store.project_pk(pid), "SK": f"DOC#{doc}"}).get("Item")
    if existing and existing.get("status") == "ok":
        text = store.read_text(store.doc_key(pid, doc))
        if text is not None:
            return {"ok": True, "cached": True, **_public_doc(store.to_plain(existing)), **_slice(text, offset, max_chars)}
    if existing and existing.get("status") == "error":
        raise ToolError(str(existing.get("error") or "This page could not be read earlier"))
    if sources.is_blocked(url, BLOCKED_DOMAINS):
        raise ToolError("This domain is blocked for this deployment")
    if not _robots_allowed(parsed):
        raise ToolError("robots.txt does not allow reading this page")
    try:
        got = _read(url)
    except ToolError as err:
        store.table().put_item(Item={"PK": store.project_pk(pid), "SK": f"DOC#{doc}", "docId": doc, "url": url,
                                     "canonicalUrl": canonical, "status": "error", "error": str(err)[:300],
                                     "fetchedAt": store.now_iso()})
        raise
    record = _register(pid, url, canonical, doc, got)
    return {"ok": True, "cached": False, **_public_doc(record), **_slice(got["text"], offset, max_chars)}


def search_web(event: dict) -> dict:
    caller(event)
    query = event.get("query")
    if not (isinstance(query, str) and 2 <= len(query.strip()) <= 400):
        raise ToolError("query must be 2-400 chars")
    max_results = min(max(int(event.get("maxResults") or 8), 1), 10)

    def domains(key: str) -> Optional[list[str]]:
        value = event.get(key)
        if value is None:
            return None
        if not isinstance(value, list) or len(value) > 50 or not all(isinstance(d, str) and d for d in value):
            raise ToolError(f"{key} must be a list of at most 50 domains")
        return value

    start = event.get("startDate")
    if start is not None and not (isinstance(start, str) and sources.parse_date(start)):
        raise ToolError("startDate must be YYYY-MM-DD")
    result = providers.search(query.strip(), max_results=max_results, include_domains=domains("includeDomains"),
                              exclude_domains=domains("excludeDomains"), start_date=start)
    for r in result["results"]:
        r["publisher"] = sources.publisher(r["url"])
        r["sourceType"] = sources.source_type(r["url"])
    return {"ok": True, **result}


def _check_one(url: str) -> dict:
    try:
        _check_url(url)
    except ToolError as err:
        return {"url": url, "ok": False, "status": None, "error": str(err)}
    opener = urllib.request.build_opener(_NoRedirectToPrivate())
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Range": "bytes=0-2047"})
        try:
            with opener.open(req, timeout=8) as resp:
                return {"url": url, "ok": True, "status": resp.status, "finalUrl": resp.geturl()}
        except urllib.error.HTTPError as err:
            if method == "HEAD" and err.code in (403, 405, 501):
                continue  # some servers refuse HEAD; try a small GET
            return {"url": url, "ok": err.code < 400 or err.code == 429, "status": err.code}
        except Exception as err:  # noqa: BLE001
            if method == "HEAD":
                continue
            return {"url": url, "ok": False, "status": None, "error": str(getattr(err, "reason", err))[:200]}
    return {"url": url, "ok": False, "status": None}


def url_check(event: dict) -> dict:
    caller(event)
    urls = event.get("urls")
    if not isinstance(urls, list) or not 1 <= len(urls) <= 20 or not all(isinstance(u, str) for u in urls):
        raise ToolError("urls must be a list of 1-20 URLs")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_check_one, urls))
    return {"ok": True, "results": results, "dead": [r["url"] for r in results if not r["ok"]]}


HANDLERS = {"fetch_page": fetch_page, "search_web": search_web, "url_check": url_check}


def handler(event: dict, context: Any) -> dict:
    return dispatch(HANDLERS, event, context)
