"""Pure helpers for source documents: URL canonicalization, publisher grouping, near-duplicate
fingerprints, quote location, publication dates and a source-quality score.

No AWS calls and no third-party packages, so the same rules run in the Lambda, the eval harness and
the tests. agent/research_agent/urls.py keeps a copy of canonical_url and publisher (the agent is
packaged separately); tools/tests/test_sources.py checks the two stay identical.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# ---------------------------------------------------------------------------------------------------
# URLs and publishers

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


def doc_id(canonical: str) -> str:
    return "d-" + hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------------------------------
# Text normalization, fingerprints and quotes

_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "「": '"', "」": '"',
                         "『": '"', "』": '"', "–": "-", "—": "-", "−": "-", " ": " "})
_ZERO_WIDTH = {"​", "‌", "‍", "﻿", "­"}
_CJK = re.compile(r"[぀-ヿ㐀-鿿豈-﫿]")


def _norm_char(ch: str) -> str:
    if ch in _ZERO_WIDTH:
        return ""
    out = unicodedata.normalize("NFKC", ch).translate(_QUOTES).lower()
    return " " if out.isspace() else out


def normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Normalized text plus, for each normalized character, the index of the original character it
    came from. Whitespace runs collapse to one space."""
    chars: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text):
        for out in _norm_char(ch):
            if out == " " and (not chars or chars[-1] == " "):
                continue
            chars.append(out)
            index.append(i)
    while chars and chars[-1] == " ":
        chars.pop()
        index.pop()
    return "".join(chars), index


def normalize(text: str) -> str:
    return normalize_with_map(text)[0]


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


_MERSENNE = (1 << 61) - 1
_PERMS = [((i * 0x9E3779B97F4A7C15 + 0x632BE59BD9B4E019) % _MERSENNE | 1,
           (i * 0xC2B2AE3D27D4EB4F + 0x165667B19E3779F9) % _MERSENNE) for i in range(1, 33)]
MINHASH_PERMS = len(_PERMS)
NEAR_DUPLICATE = 0.8


def shingles(text: str, size: int = 5, limit: int = 12_000) -> set[str]:
    """Word 5-grams for spaced text; character 5-grams when the text is mostly CJK (no spaces)."""
    norm = normalize(text[:limit])
    if len(_CJK.findall(norm[:2000])) > 200:
        compact = norm.replace(" ", "")
        return {compact[i:i + size] for i in range(max(1, len(compact) - size + 1))}
    words = norm.split()
    if len(words) < size:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i:i + size]) for i in range(len(words) - size + 1)}


def minhash(text: str) -> list[int]:
    hashes = [int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "big") for s in shingles(text)]
    if not hashes:
        return [0] * MINHASH_PERMS
    return [min((a * h + b) % _MERSENNE for h in hashes) for a, b in _PERMS]


def similarity(sig_a: list[int], sig_b: list[int]) -> float:
    if not sig_a or len(sig_a) != len(sig_b):
        return 0.0
    return sum(1 for x, y in zip(sig_a, sig_b) if x == y) / len(sig_a)


MIN_QUOTE_CHARS = 8
_ELLIPSIS = re.compile(r"\s*(?:\.\.\.|…|⋯)+\s*")


def find_quote(quote: str, text: str) -> Optional[tuple[int, int]]:
    """Locate a quote in the page text, ignoring case, width, quote style and whitespace. A quote
    shortened with an ellipsis matches when every part appears in order. Returns (start, end) in the
    original text, or None."""
    parts = [normalize(p) for p in _ELLIPSIS.split(quote.strip().strip('"「」“”')) if p.strip()]
    if not parts or sum(len(p) for p in parts) < MIN_QUOTE_CHARS:
        return None
    norm, index = normalize_with_map(text)
    pos, start = 0, None
    for part in parts:
        at = norm.find(part, pos)
        if at < 0:
            return None
        start = at if start is None else start
        pos = at + len(part)
    return index[start], index[pos - 1] + 1


# ---------------------------------------------------------------------------------------------------
# Publication dates

_DATE_META = {
    "article:published_time", "og:published_time", "article:published", "pubdate", "publishdate", "publish_date",
    "date", "dc.date", "dc.date.issued", "dcterms.date", "dcterms.created", "citation_publication_date",
    "citation_date", "sailthru.date", "parsely-pub-date", "datepublished",
}


class _DateFinder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.candidates: list[str] = []
        self._ld = False
        self._ld_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key in _DATE_META and a.get("content"):
                self.candidates.append(a["content"])
        elif tag == "time" and a.get("datetime"):
            self.candidates.append(a["datetime"])
        elif tag == "script" and a.get("type", "").lower() == "application/ld+json":
            self._ld = True
            self._ld_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._ld:
            self._ld = False
            self._from_json_ld("".join(self._ld_text))

    def handle_data(self, data: str) -> None:
        if self._ld:
            self._ld_text.append(data)

    def _from_json_ld(self, raw: str) -> None:
        try:
            value = json.loads(raw)
        except ValueError:
            return
        stack = [value]
        while stack:
            cur = stack.pop()
            if isinstance(cur, dict):
                for key in ("datePublished", "dateCreated", "uploadDate"):
                    if isinstance(cur.get(key), str):
                        self.candidates.insert(0, cur[key])
                stack.extend(cur.values())
            elif isinstance(cur, list):
                stack.extend(cur)


def parse_date(value: str) -> Optional[str]:
    """ISO date (YYYY-MM-DD) from common date spellings, or None."""
    value = value.strip()
    m = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", value)
    if not m:
        m = re.match(r"^(\d{4})年(\d{1,2})月(\d{1,2})日", value)
    if not m:
        return None
    try:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    if not 1990 <= d.year <= datetime.now(timezone.utc).year + 1:
        return None
    return d.isoformat()


def published_date(html: str) -> Optional[str]:
    finder = _DateFinder()
    try:
        finder.feed(html[:400_000])
    except Exception:  # noqa: BLE001 - a malformed page just has no date
        return None
    for candidate in finder.candidates:
        parsed = parse_date(candidate)
        if parsed:
            return parsed
    return None


# ---------------------------------------------------------------------------------------------------
# Source type and score

GOVERNMENT_SUFFIXES = (".gov", ".gov.tw", ".gov.uk", ".gov.au", ".gov.sg", ".gov.hk", ".gov.cn", ".go.jp", ".go.kr",
                       ".gov.in", ".gc.ca", ".europa.eu", ".mil", ".gov.br", ".govt.nz", ".int")
GOVERNMENT_DOMAINS = {"europa.eu", "un.org", "oecd.org", "worldbank.org", "imf.org", "wto.org", "who.int", "bis.org", "fsc.gov.tw"}
ACADEMIC_SUFFIXES = (".edu", ".edu.tw", ".ac.uk", ".ac.jp", ".ac.kr", ".edu.au", ".edu.sg", ".edu.hk", ".edu.cn", ".ac.in")
ACADEMIC_DOMAINS = {"arxiv.org", "doi.org", "nature.com", "science.org", "ieee.org", "acm.org", "springer.com", "sciencedirect.com",
                    "wiley.com", "ssrn.com", "nber.org", "pnas.org", "cell.com", "plos.org", "researchgate.net", "aclanthology.org",
                    "openreview.net", "semanticscholar.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "jstor.org"}
STANDARDS_DOMAINS = {"iso.org", "iec.ch", "ietf.org", "w3.org", "nist.gov", "etsi.org", "ieee.org", "semi.org"}
NEWS_DOMAINS = {"reuters.com", "bloomberg.com", "ft.com", "wsj.com", "nytimes.com", "economist.com", "nikkei.com", "asia.nikkei.com",
                "theverge.com", "techcrunch.com", "cnbc.com", "bbc.co.uk", "bbc.com", "apnews.com", "theguardian.com", "axios.com",
                "focustaiwan.tw", "cna.com.tw", "udn.com", "ltn.com.tw", "chinatimes.com", "cw.com.tw", "bnext.com.tw", "ithome.com.tw",
                "digitimes.com", "digitimes.com.tw", "technews.tw", "businesstoday.com.tw", "wealth.com.tw", "taipeitimes.com",
                "ctee.com.tw", "moneydj.com", "storm.mg", "twreporter.org", "zdnet.com", "venturebeat.com", "theregister.com",
                "infoq.com", "arstechnica.com", "wired.com", "forbes.com", "fortune.com", "businessinsider.com"}
RESEARCH_DOMAINS = {"gartner.com", "mckinsey.com", "bcg.com", "bain.com", "deloitte.com", "pwc.com", "ey.com", "kpmg.com",
                    "accenture.com", "idc.com", "forrester.com", "statista.com", "brookings.edu", "rand.org", "pewresearch.org",
                    "trendforce.com", "counterpointresearch.com", "itri.org.tw", "iii.org.tw", "mic.iii.org.tw", "tier.org.tw",
                    "weforum.org", "stateof.ai", "epoch.ai", "cbinsights.com"}
OFFICIAL_DOCS_HOSTS = ("docs.", "learn.", "developer.", "developers.", "support.", "help.", "investor.", "ir.", "newsroom.",
                       "press.", "aws.amazon.com", "cloud.google.com", "azure.microsoft.com")
COMMUNITY_DOMAINS = {"medium.com", "substack.com", "reddit.com", "quora.com", "ptt.cc", "dcard.tw", "blogspot.com",
                     "wordpress.com", "linkedin.com", "facebook.com", "x.com", "twitter.com", "youtube.com", "tiktok.com",
                     "vocus.cc", "matters.town", "pixnet.net", "stackoverflow.com", "zhihu.com", "github.io", "dev.to",
                     "hashnode.dev", "notion.site"}
REFERENCE_DOMAINS = {"wikipedia.org", "britannica.com", "investopedia.com"}

TYPE_PRIOR = {"government": 0.9, "standards": 0.88, "academic": 0.85, "official": 0.8, "research": 0.72,
              "news": 0.65, "reference": 0.55, "unknown": 0.5, "community": 0.35}


def source_type(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    pub = publisher(host)
    if pub in GOVERNMENT_DOMAINS or host.endswith(GOVERNMENT_SUFFIXES) or "." + pub in GOVERNMENT_SUFFIXES:
        return "government"
    if pub in STANDARDS_DOMAINS:
        return "standards"
    if pub in ACADEMIC_DOMAINS or host in ACADEMIC_DOMAINS or host.endswith(ACADEMIC_SUFFIXES):
        return "academic"
    if pub in RESEARCH_DOMAINS or host in RESEARCH_DOMAINS:
        return "research"
    if pub in NEWS_DOMAINS or host in NEWS_DOMAINS:
        return "news"
    if pub in REFERENCE_DOMAINS:
        return "reference"
    if pub in COMMUNITY_DOMAINS or any(host.endswith("." + d) for d in COMMUNITY_DOMAINS):
        return "community"
    if host.startswith(OFFICIAL_DOCS_HOSTS) or any(h in host for h in OFFICIAL_DOCS_HOSTS if "." in h and h.count(".") >= 2):
        return "official"
    return "unknown"


def score_source(url: str, published: Optional[str], *, blocked: bool = False, today: Optional[date] = None) -> tuple[float, list[str]]:
    """A 0-1 prior on how much a source should count, with the reasons. It ranks and filters sources;
    it never decides on its own whether a claim is true."""
    stype = source_type(url)
    if blocked:
        return 0.05, [f"type:{stype}", "blocked domain"]
    score = TYPE_PRIOR[stype]
    reasons = [f"type:{stype}"]
    if not published:
        score -= 0.05
        reasons.append("no publication date")
    else:
        age_days = ((today or datetime.now(timezone.utc).date()) - date.fromisoformat(published)).days
        if age_days > 3 * 365:
            score -= 0.1
            reasons.append("older than 3 years")
        elif age_days > 365:
            score -= 0.03
            reasons.append("older than 1 year")
    if urlsplit(url).scheme == "http":
        score -= 0.02
        reasons.append("no https")
    return round(max(0.05, min(1.0, score)), 2), reasons


def is_blocked(url: str, blocked_domains: set[str]) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in blocked_domains)


def parse_domain_list(raw: str) -> set[str]:
    return {d.strip().lower().lstrip(".") for d in (raw or "").split(",") if d.strip()}
