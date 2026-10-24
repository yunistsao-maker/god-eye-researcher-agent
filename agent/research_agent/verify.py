"""Claim catalog for the writer, and sentence-level checking of the report it writes.

The writer sees every verified claim as C1, C2, ... with its status and independent-source count,
and must end each factual sentence with the markers of the claims it relies on. Checking then works
on sentences:
  1. split the Markdown report into sentences, keeping headings, list markers and bold labels
     ("**結論：**"); a table row is one unit (its cells read as "header：cell");
  2. drop markers that name no claim (counted as unknownCitations);
  3. hand each cited sentence, with only the claims it cites, to an independent verifier;
  4. sentences judged unsupported or partial go to a reviser that rewrites them from their claims or
     deletes them; rewritten ones are checked once more and deleted if they still fail. Table rows
     cannot be rewritten: an unsupported row is deleted, a partly supported one is kept.
Everything here is pure so it is unit-tested without a model.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Iterable, Optional

MARKER = re.compile(r"\[C(\d{1,3})\]")
LABEL = re.compile(r"^C[1-9][0-9]{0,2}$")
_SENTENCE_END = re.compile(r"(?<=[。！？!?])|(?<=[.;；])(?=\s)")
_CJK = re.compile(r"[぀-ヿ㐀-鿿豈-﫿＀-￯]")
OPEN_SECTION_WORDS = ("尚待", "待研究", "待追蹤", "限制", "未解", "未知", "open question", "limitation", "next step", "gaps",
                      "further research", "follow-up", "to watch")
TITLE_SECTION = "(title)"   # the title and the scope paragraph under it, which need no markers


@dataclass
class CatalogEntry:
    label: str
    claim_id: str
    finding_id: str
    text: str
    status: str
    independent: int
    quotes: list[dict]
    updates: str = ""          # incremental runs: the earlier claim this one replaced


def build_catalog(findings: Iterable[dict]) -> list[CatalogEntry]:
    entries: list[CatalogEntry] = []
    for f in findings:
        for c in f.get("claims") or []:
            if c.get("status") == "superseded":
                continue
            quotes = [{"quote": e.get("quote", "")[:300], "publisher": e.get("publisher", ""), "stance": e.get("stance", "supports"),
                       "url": e.get("url", "")} for e in c.get("evidence", [])][:3]
            entries.append(CatalogEntry(label=f"C{len(entries) + 1}", claim_id=c["claimId"], finding_id=f["findingId"],
                                        text=c["text"], status=c["status"], independent=int(c.get("independentSources", 0)),
                                        quotes=quotes, updates=c.get("updates") or ""))
    return entries


def citations(catalog: list[CatalogEntry]) -> dict[str, dict]:
    return {e.label: {"claimId": e.claim_id, "findingId": e.finding_id} for e in catalog}


def catalog_brief(catalog: list[CatalogEntry], max_chars: int = 60_000, marks: Optional[dict[str, dict]] = None) -> str:
    """The claim catalog the writer sees. `marks` adds flags per label (an incremental run marks the
    claims it found as new, and those that replaced an earlier claim as updated)."""
    rows = [{"label": e.label, "finding": "F" + e.finding_id.split("-", 1)[1], "status": e.status,
             "independentSources": e.independent, "claim": e.text,
             "publishers": sorted({q["publisher"] for q in e.quotes if q["publisher"]}), **((marks or {}).get(e.label) or {})}
            for e in catalog]
    return json.dumps(rows, ensure_ascii=False)[:max_chars]


# ---------------------------------------------------------------------------------------------------
# Report structure

@dataclass
class Block:
    kind: str                     # heading | text | blank | table (header and separator rows) | row
    prefix: str = ""              # list marker and bold label, kept verbatim
    sentences: list[str] = field(default_factory=list)
    section: str = ""             # the heading this block sits under
    raw: str = ""                 # headings and blanks are kept as-is


@dataclass
class Sentence:
    id: int
    block: int
    index: int
    text: str
    labels: list[str]
    section: str
    row: bool = False             # a table row: deleted when unsupported, never rewritten


# A list marker and/or a bold label such as "**結論：**" or "**現況**：" belong to the line, not to its first sentence.
_LIST_PREFIX = re.compile(r"^(\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*[^*\n]{1,16}?(?:[：:]\*\*|\*\*[：:])\s*)?)")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$")


def table_cells(line: str) -> list[str]:
    body = line.strip()
    body = body[1:] if body.startswith("|") else body
    body = body[:-1] if body.endswith("|") and not body.endswith("\\|") else body
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", body)]


def _balance_bold(text: str) -> str:
    """A deleted sentence can take one half of a bold span with it; the rest stays bold."""
    if text.count("**") % 2 == 0:
        return text
    body = text.strip()
    if body.endswith("**"):
        return "**" + body
    return body + "**"


def split_sentences(text: str) -> list[str]:
    parts = [p for p in _SENTENCE_END.split(text) if p and p.strip()]
    out: list[str] = []
    for p in parts:
        lead = re.match(r"^\s*((?:\[C\d{1,3}\])+|\*\*|[」』）)])", p)
        while lead and out:  # markers or closing marks after the full stop belong to the previous sentence
            out[-1] = out[-1].rstrip() + lead.group(1)
            p = p[lead.end():]
            lead = re.match(r"^\s*((?:\[C\d{1,3}\])+|\*\*|[」』）)])", p)
        if p.strip():
            out.append(p.strip())
    return out


def parse_report(markdown: str) -> list[Block]:
    blocks: list[Block] = []
    section = ""
    lines = markdown.splitlines()
    header: list[str] = []
    for i, line in enumerate(lines):
        if not line.strip():
            blocks.append(Block("blank", raw=""))
            continue
        if line.lstrip().startswith("#"):
            section = TITLE_SECTION if re.match(r"^\s*#(?!#)", line) else line.lstrip("# ").strip()
            blocks.append(Block("heading", raw=line, section=section))
            continue
        if _TABLE_ROW.match(line):
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if _TABLE_SEP.match(line):
                blocks.append(Block("table", raw=line, section=section))
            elif _TABLE_SEP.match(nxt):
                header = table_cells(line)
                blocks.append(Block("table", raw=line, section=section))
            else:
                cells = table_cells(line)
                text = "；".join(f"{h}：{c}" if h else c for h, c in zip(header + [""] * len(cells), cells) if c)
                blocks.append(Block("row", raw=line, sentences=[text] if text else [], section=section))
            continue
        m = _LIST_PREFIX.match(line)
        prefix = m.group(1) if m else ""
        blocks.append(Block("text", prefix=prefix, sentences=split_sentences(line[len(prefix):]), section=section))
    return blocks


def _join(sentences: list[str]) -> str:
    out = ""
    for s in sentences:
        if out and not (_CJK.search(out[-1]) or _CJK.search(s[:1])):
            out += " "
        out += s
    return out


def render(blocks: list[Block]) -> str:
    lines: list[str] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b.kind in ("table", "row"):
            j = i
            while j < len(blocks) and blocks[j].kind in ("table", "row"):
                j += 1
            group = blocks[i:j]
            rows = [r for r in group if r.kind == "row"]
            if not rows or any(r.sentences for r in rows):   # a table whose rows were all deleted goes too
                lines.extend(r.raw for r in group if r.kind == "table" or r.sentences)
            i = j
            continue
        if b.kind != "text":
            lines.append(b.raw)
        elif b.sentences:
            lines.append(_balance_bold(b.prefix + _join(b.sentences)))
        i += 1
    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def sentences(blocks: list[Block]) -> list[Sentence]:
    out: list[Sentence] = []
    for bi, b in enumerate(blocks):
        if b.kind not in ("text", "row"):
            continue
        for si, s in enumerate(b.sentences):
            out.append(Sentence(id=len(out) + 1, block=bi, index=si, text=s, labels=[f"C{n}" for n in MARKER.findall(s)],
                                section=b.section, row=b.kind == "row"))
    return out


def strip_unknown_markers(blocks: list[Block], known: set[str]) -> int:
    removed = 0
    for b in blocks:
        if b.kind not in ("text", "row"):
            continue
        if b.kind == "row":   # rows render from their raw line
            b.raw = MARKER.sub(lambda m: m.group(0) if f"C{m.group(1)}" in known else "", b.raw)
        for i, s in enumerate(b.sentences):
            def keep(m: re.Match) -> str:
                nonlocal removed
                if f"C{m.group(1)}" in known:
                    return m.group(0)
                removed += 1
                return ""
            before = removed
            fixed = MARKER.sub(keep, s)
            if removed > before:   # no space left before the punctuation the marker preceded
                fixed = re.sub(r"\s+([。！？，；：.!?,;:])", r"\1", fixed).strip()
            b.sentences[i] = fixed
    return removed


def is_open_section(section: str) -> bool:
    if section == TITLE_SECTION:
        return True
    low = section.lower()
    return any(w in low for w in OPEN_SECTION_WORDS)


def needs_citation(s: Sentence) -> bool:
    plain = MARKER.sub("", s.text).strip()
    return len(plain) >= 15 and not is_open_section(s.section)


def verification_items(sents: list[Sentence], catalog: dict[str, CatalogEntry], only: Optional[set[int]] = None) -> list[dict]:
    items = []
    for s in sents:
        if not s.labels or (only is not None and s.id not in only):
            continue
        claims = [{"label": lab, "claim": catalog[lab].text, "status": catalog[lab].status,
                   "quotes": [q["quote"] for q in catalog[lab].quotes[:2]]} for lab in dict.fromkeys(s.labels) if lab in catalog]
        items.append({"id": s.id, "sentence": MARKER.sub("", s.text).strip(), "claims": claims})
    return items


def apply_edits(blocks: list[Block], sents: list[Sentence], edits: dict[int, Optional[str]], known: set[str]) -> tuple[int, int]:
    """Apply rewrites (text) and deletions (None). A rewrite may only keep markers of claims that
    exist. Returns (revised, removed)."""
    by_id = {s.id: s for s in sents}
    revised = removed = 0
    deletions: list[tuple[int, int]] = []
    for sid, text in edits.items():
        s = by_id.get(sid)
        if s is None:
            continue
        if text is None or not MARKER.sub("", text).strip():
            deletions.append((s.block, s.index))
            removed += 1
            continue
        if s.row:   # a table row is kept or deleted, never rewritten
            continue
        cleaned = MARKER.sub(lambda m: m.group(0) if f"C{m.group(1)}" in known else "", text.strip())
        blocks[s.block].sentences[s.index] = cleaned
        revised += 1
    for bi, si in sorted(deletions, reverse=True):
        del blocks[bi].sentences[si]
    return revised, removed
