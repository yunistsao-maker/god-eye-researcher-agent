"""URL canonicalization and publisher grouping for the research agent's search tools.

A verbatim copy of the same functions in tools/src/common/sources.py (the agent is packaged without
the Lambda sources); tools/tests/test_sources.py fails if the two ever differ.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING_PARAMS = {
    "gclid", "dclid", "fbclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src",
    "spm", "share", "from", "cmpid", "ocid", "smid", "s_cid", "_ga", "_gl", "amp",
}
TRACKING_PREFIXES = ("utm_", "pk_", "mtm_", "hsa_", "vero_")

# Second-level labels that act as public suffixes (enough for grouping publishers, not a full PSL).
MULTI_PART_SUFFIXES = {
    "com.tw", "org.tw", "gov.tw", "edu.tw", "net.tw", "idv.tw", "mil.tw",
    "co.uk", "org.uk", "gov.uk", "ac.uk", "ltd.uk", "plc.uk",
    "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp", "ad.jp",
    "com.cn", "gov.cn", "edu.cn", "org.cn", "net.cn",
    "com.hk", "gov.hk", "edu.hk", "org.hk",
    "co.kr", "go.kr", "or.kr", "ac.kr", "re.kr",
    "com.sg", "gov.sg", "edu.sg", "org.sg",
    "com.au", "gov.au", "edu.au", "org.au", "net.au",
    "co.in", "gov.in", "ac.in", "org.in", "co.nz", "govt.nz", "com.br", "gov.br", "com.my", "gov.my",
    "co.th", "go.th", "ac.th", "com.vn", "gov.vn", "co.id", "go.id", "com.ph", "gov.ph",
}


def canonical_url(url: str) -> str:
    """One spelling per page: lower-case host without www/m/amp, no fragment, default port or
    tracking parameters, sorted query, no trailing slash, AMP paths folded back."""
    parts = urlsplit(url.strip())
    scheme = (parts.scheme or "https").lower()
    if scheme == "http":
        scheme = "https"
    host = (parts.hostname or "").lower().rstrip(".")
    for prefix in ("www.", "m.", "amp.", "mobile."):
        if host.startswith(prefix) and host.count(".") >= 2:
            host = host[len(prefix):]
            break
    port = parts.port
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    path = re.sub(r"(/amp)+/?$", "", path) or "/"
    path = re.sub(r"/amp/", "/", path)
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in TRACKING_PARAMS and not k.lower().startswith(TRACKING_PREFIXES)]
    query.sort()
    return urlunsplit((scheme, netloc, path, urlencode(query, doseq=True), ""))


def publisher(url_or_host: str) -> str:
    """Registrable domain used to decide whether two sources are independent (news.example.com and
    example.com are one publisher; example.com.tw keeps its three labels)."""
    host = url_or_host
    if "/" in url_or_host or ":" in url_or_host:
        host = urlsplit(url_or_host if "//" in url_or_host else "https://" + url_or_host).hostname or ""
    labels = [p for p in host.lower().strip(".").split(".") if p]
    if len(labels) <= 2:
        return ".".join(labels)
    if ".".join(labels[-2:]) in MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])
