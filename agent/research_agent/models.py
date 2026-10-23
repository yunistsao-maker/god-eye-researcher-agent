"""Structured outputs the LLM fills in. The orchestrator turns them into contract objects."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

DataShape = Literal["comparison", "timeline", "metrics", "list", "other"]


class SubQuestionDraft(BaseModel):
    question: str = Field(description="One focused research question, in the topic's language")
    dataShape: DataShape = Field(description="comparison = items compared on the same attributes; timeline = dated events; "
                                             "metrics = numbers to compare; list = prose findings; other = anything else")


class PlanDraft(BaseModel):
    subQuestions: list[SubQuestionDraft] = Field(min_length=1, max_length=8)
    requirements: list[str] = Field(default_factory=list, max_length=10, description=(
        "What a complete answer must cover, as short checklist items in the topic's language: the parts the user asked for "
        "plus the implicit needs a demanding expert would expect (scope and dates, numbers with units, risks, what is unknown)"))


class EntityDraft(BaseModel):
    name: str = Field(description="Canonical short name, e.g. a company, technology or place")
    type: Literal["org", "person", "tech", "domain", "place", "concept", "other"]


class RelationDraft(BaseModel):
    fromEntity: str = Field(description="Entity name exactly as listed in entities")
    toEntity: str = Field(description="Entity name exactly as listed in entities")
    type: Literal["supports", "contradicts", "causes"]


class SourceDraft(BaseModel):
    title: str
    url: str = Field(description="The http(s) URL you actually read")


class ComparisonData(BaseModel):
    columns: list[str] = Field(min_length=2, max_length=6)
    rows: list[list[str]] = Field(min_length=1, max_length=12, description="Each row has one cell per column")


class TimelineItem(BaseModel):
    when: str = Field(description="Date or period, e.g. 2024 H2")
    what: str


class MetricItem(BaseModel):
    label: str
    value: float
    unit: str = Field(default="", description="e.g. %, USD, hours")


class EvidenceDraft(BaseModel):
    docId: str = Field(description="The docId that read_page printed for the page you are quoting, e.g. d-1a2b3c4d5e6f")
    quote: str = Field(description="A passage copied exactly from that page's text, 15-300 characters. Never paraphrase or translate it")
    stance: Literal["supports", "contradicts"] = Field(default="supports", description="Whether the passage supports or contradicts the claim")


class ClaimDraft(BaseModel):
    text: str = Field(description="One atomic, self-contained factual statement in the question's language, with its scope and date")
    evidence: list[EvidenceDraft] = Field(min_length=1, max_length=4)


class FindingDraft(BaseModel):
    summary: str = Field(description="2-3 sentences answering the question")
    keyPoints: list[str] = Field(max_length=6)
    claims: list[ClaimDraft] = Field(default_factory=list, max_length=10, description=(
        "3-8 atomic claims that carry the answer, each backed by verbatim quotes from pages you read; give two pages from "
        "different publishers when you can, and add a contradicting quote when a source disagrees"))
    entities: list[EntityDraft] = Field(max_length=10)
    relations: list[RelationDraft] = Field(default_factory=list, max_length=8)
    sources: list[SourceDraft] = Field(default_factory=list, max_length=8, description="Optional; sources are derived from claim evidence")
    confidence: float = Field(ge=0, le=1, description="How well the sources support the summary")
    comparison: Optional[ComparisonData] = Field(default=None, description="Fill only for dataShape comparison")
    timeline: Optional[list[TimelineItem]] = Field(default=None, description="Fill only for dataShape timeline")
    metrics: Optional[list[MetricItem]] = Field(default=None, description="Fill only for dataShape metrics, with values from sources")


class CoverageDraft(BaseModel):
    requirementId: str = Field(description="q1, q2, ... as listed in the requirements")
    status: Literal["covered", "weak", "missing"] = Field(description="covered = answered by corroborated claims; weak = only "
                                                                      "single-source or contested claims; missing = no claim")
    claimIds: list[str] = Field(default_factory=list, max_length=8, description="Ids of the claims that answer it")
    note: str = Field(default="", max_length=300)


class ReviewDraft(BaseModel):
    coverage: list[CoverageDraft] = Field(default_factory=list, max_length=12)
    contradictions: list[str] = Field(default_factory=list, max_length=6,
                                      description="Places where findings or their sources disagree, naming the findings (e.g. F2 vs F4)")
    gaps: list[str] = Field(default_factory=list, max_length=6,
                            description="Parts of the topic the findings leave unanswered or answer only weakly")
    followUps: list[SubQuestionDraft] = Field(default_factory=list, max_length=3,
                                              description="At most 3 new sub-questions worth researching to close the most important gaps; empty if none")


class UiSpecDraft(BaseModel):
    component: Literal["Compare", "Timeline", "MetricBars", "KeyPoints"]
    title: str = Field(default="", max_length=80)
    emphasizeColumn: Optional[int] = Field(default=None, ge=0, le=10, description="Compare only: column index to highlight")


class SentenceVerdict(BaseModel):
    id: int = Field(description="The sentence id being judged")
    verdict: Literal["supported", "partial", "unsupported"] = Field(description=(
        "supported = the cited claims fully back the sentence; partial = some of it goes beyond them (an added number, "
        "a stronger word, a missing qualifier); unsupported = the cited claims do not back it"))
    reason: str = Field(default="", max_length=200)


class VerifyDraft(BaseModel):
    verdicts: list[SentenceVerdict] = Field(default_factory=list)


class SentenceEdit(BaseModel):
    id: int
    action: Literal["rewrite", "delete"]
    text: str = Field(default="", description="For rewrite: the corrected sentence, keeping only citation markers it was given")


class ReviseDraft(BaseModel):
    edits: list[SentenceEdit] = Field(default_factory=list)
