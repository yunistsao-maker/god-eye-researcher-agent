"""Deterministic quality metrics for one finished research project (the project_get payload).

No model calls: these numbers are cheap, reproducible and comparable across versions, so every
change to the agent can be checked against a baseline before anyone reads a report.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Any

PRIMARY_TYPES = {"government", "standards", "academic", "official"}
MARKER = re.compile(r"\[C\d{1,3}\]")
CJK = re.compile(r"[㐀-鿿豈-﫿]")


def _words(text: str) -> int:
    """Words for spaced text plus one per CJK character, so zh-TW and English reports compare."""
    plain = MARKER.sub("", text)
    return len(CJK.findall(plain)) + len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'.-]*", CJK.sub(" ", plain)))


def _ratio(num: float, den: float) -> float | None:
    return round(num / den, 3) if den else None


def project_metrics(project_get: dict) -> dict[str, Any]:
    findings = project_get.get("findings") or []
    claims = [c for f in findings for c in (f.get("claims") or [])]
    status = Counter(c.get("status") for c in claims)
    docs = project_get.get("docs") or []
    types = Counter(d.get("sourceType") or "unknown" for d in docs)
    publishers = {d.get("publisher") for d in docs if d.get("publisher")}
    synthesis = project_get.get("synthesis") or {}
    report = synthesis.get("report") or ""
    ver = synthesis.get("verification") or {}
    coverage = (project_get.get("coverage") or {}).get("requirements") or []
    cov = Counter(c.get("status") for c in coverage)
    cited_docs = {e.get("docId") for c in claims for e in c.get("evidence", [])}
    cited_sentences = ver.get("citedSentences", 0) - ver.get("removed", 0)
    stats = (project_get.get("project") or {}).get("stats") or {}

    return {
        "status": (project_get.get("project") or {}).get("status"),
        "findings": len(findings),
        "claims": len(claims),
        "claimsCorroborated": status.get("corroborated", 0),
        "claimsAsserted": status.get("asserted", 0),
        "claimsContested": status.get("contested", 0),
        "corroboratedShare": _ratio(status.get("corroborated", 0), len(claims)),
        "meanIndependentSources": _ratio(sum(c.get("independentSources", 0) for c in claims), len(claims)),
        "sources": len(docs),
        "publishers": len(publishers),
        "duplicates": sum(1 for d in docs if d.get("duplicateOf")),
        "primaryShare": _ratio(sum(types[t] for t in PRIMARY_TYPES), len(docs)),
        "communityShare": _ratio(types.get("community", 0), len(docs)),
        "datedShare": _ratio(sum(1 for d in docs if d.get("publishedDate")), len(docs)),
        "citedDocs": len(cited_docs - {None}),
        "requirements": len(coverage),
        "requirementsCovered": cov.get("covered", 0),
        "requirementsWeak": cov.get("weak", 0),
        "requirementsMissing": cov.get("missing", 0),
        "coverageShare": _ratio(cov.get("covered", 0), len(coverage)),
        "reportWords": _words(report),
        "citedSentenceShare": _ratio(cited_sentences, cited_sentences + ver.get("uncitedSentences", 0)),
        "citationPrecisionBefore": ver.get("precisionBefore"),
        "citationPrecisionAfter": ver.get("precisionAfter"),
        "sentencesRemoved": ver.get("removed"),
        "sentencesRevised": ver.get("revised"),
        "unknownCitations": ver.get("unknownCitations"),
        "deadUrls": len(ver.get("deadUrls") or []),
        "elapsedSec": stats.get("elapsedSec"),
    }


HIGHER_IS_BETTER = {
    "claims", "corroboratedShare", "meanIndependentSources", "publishers", "primaryShare", "datedShare", "coverageShare",
    "citedSentenceShare", "citationPrecisionBefore", "citationPrecisionAfter", "rubricScore",
}
LOWER_IS_BETTER = {"communityShare", "requirementsMissing", "unknownCitations", "deadUrls", "elapsedSec", "sentencesRemoved"}


def mean(values: list[float | None]) -> float | None:
    vals = [v for v in values if isinstance(v, (int, float))]
    return round(sum(vals) / len(vals), 3) if vals else None
