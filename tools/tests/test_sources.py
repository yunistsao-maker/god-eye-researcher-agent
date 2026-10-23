"""Pure source helpers: canonical URLs, publishers, fingerprints, quotes, dates, scores."""
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "src"))
sys.path.insert(0, str(ROOT / "agent"))

from common import sources  # noqa: E402
from research_agent import urls as agent_urls  # noqa: E402

URLS = [
    "https://www.example.com/a/b/?utm_source=x&b=2&a=1#top",
    "http://m.example.com/a/b",
    "https://news.example.com.tw/story/123/amp",
    "https://example.com:443/path//to/?fbclid=abc",
    "https://Example.COM/",
    "https://amp.theverge.com/2026/1/1/x?ref=hn",
    "https://arxiv.org/abs/2506.11763v2?context=cs",
]


def test_canonical_url_folds_variants():
    assert sources.canonical_url(URLS[0]) == "https://example.com/a/b?a=1&b=2"
    assert sources.canonical_url(URLS[1]) == "https://example.com/a/b"
    assert sources.canonical_url(URLS[2]) == "https://news.example.com.tw/story/123"
    assert sources.canonical_url(URLS[3]) == "https://example.com/path/to"
    assert sources.canonical_url(URLS[4]) == "https://example.com/"
    assert sources.canonical_url(URLS[5]) == "https://theverge.com/2026/1/1/x"


def test_agent_copy_matches_tools():
    for url in URLS:
        assert agent_urls.canonical_url(url) == sources.canonical_url(url)
        assert agent_urls.publisher(url) == sources.publisher(url)


def test_publisher_groups_subdomains_and_multipart_suffixes():
    assert sources.publisher("https://news.example.com/x") == "example.com"
    assert sources.publisher("https://www.cna.com.tw/news/1") == "cna.com.tw"
    assert sources.publisher("https://stat.gov.tw/a") == "stat.gov.tw"
    assert sources.publisher("example.co.uk") == "example.co.uk"
    assert sources.doc_id(sources.canonical_url(URLS[0])) == sources.doc_id(sources.canonical_url("https://example.com/a/b?b=2&a=1"))


def test_minhash_flags_near_duplicates_only():
    base = " ".join(f"word{i}" for i in range(400))
    near = base.replace("word200", "changed")
    other = " ".join(f"other{i}" for i in range(400))
    assert sources.similarity(sources.minhash(base), sources.minhash(near)) >= sources.NEAR_DUPLICATE
    assert sources.similarity(sources.minhash(base), sources.minhash(other)) < 0.2
    zh = "台灣電子製造業導入人工智慧視覺檢測的案例越來越多，" * 40
    assert sources.similarity(sources.minhash(zh), sources.minhash(zh + "新增一句。")) >= sources.NEAR_DUPLICATE


def test_find_quote_tolerates_width_case_quotes_and_ellipsis():
    text = "Intro.\nThe company said “AI re-inspection cut false calls by half” in 2025.\n台積電表示：「導入ＡＩ複判後，誤判率下降。」"
    span = sources.find_quote('the company said "ai re-inspection cut false calls by half"', text)
    assert span and text[span[0]:span[1]].startswith("The company said")
    span = sources.find_quote("導入AI複判後，誤判率下降", text)
    assert span and text[span[0]:span[1]] == "導入ＡＩ複判後，誤判率下降"
    assert sources.find_quote("The company said … in 2025", text)
    assert sources.find_quote("cut false calls by a third", text) is None
    assert sources.find_quote("short", text) is None


def test_published_date_from_meta_json_ld_and_time():
    assert sources.published_date('<meta property="article:published_time" content="2026-03-05T10:00:00Z">') == "2026-03-05"
    ld = '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2025-11-30"}</script>'
    assert sources.published_date(ld) == "2025-11-30"
    assert sources.published_date('<time datetime="2024/02/01">Feb 1</time>') == "2024-02-01"
    assert sources.parse_date("2026年10月23日") == "2026-10-23"
    assert sources.published_date("<p>no date</p>") is None


def test_source_type_and_score():
    assert sources.source_type("https://www.stat.gov.tw/x") == "government"
    assert sources.source_type("https://arxiv.org/abs/1") == "academic"
    assert sources.source_type("https://www.reuters.com/x") == "news"
    assert sources.source_type("https://medium.com/@a/b") == "community"
    assert sources.source_type("https://docs.aws.amazon.com/x") == "official"
    today = date(2026, 10, 23)
    gov, _ = sources.score_source("https://www.stat.gov.tw/x", "2026-01-01", today=today)
    blog, reasons = sources.score_source("https://medium.com/@a/b", None, today=today)
    old, _ = sources.score_source("https://www.reuters.com/x", "2020-01-01", today=today)
    assert gov > old > blog and "no publication date" in reasons
    assert sources.score_source("https://x.example.com", "2026-01-01", blocked=True)[0] == 0.05
    assert sources.is_blocked("https://a.spam.example/x", {"spam.example"})
