"""Validation for findings and sub-UI specs.

Mirrors contracts/finding.schema.json and contracts/ui-spec.schema.json without needing the
jsonschema package in the Lambda runtime. tests/test_validate.py checks both stay in step.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

DATA_SHAPES = {"comparison", "timeline", "metrics", "list", "other"}
ENTITY_TYPES = {"org", "person", "tech", "domain", "place", "concept", "other"}
RELATION_TYPES = {"supports", "contradicts", "causes"}
PATH = re.compile(r"^\$(\.[A-Za-z_][A-Za-z0-9_]{0,40}){1,4}$")
FIELD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
NODE_ID = re.compile(r"^[ef]-[a-z0-9-]{1,60}$")
FINDING_ID = re.compile(r"^f-[a-z0-9-]{1,40}$")
PROJECT_ID = re.compile(r"^p-[a-z0-9-]{4,60}$")
CLAIM_ID = re.compile(r"^c-[a-z0-9-]{1,60}$")
DOC_ID = re.compile(r"^d-[a-f0-9]{12}$")
REQUIREMENT_ID = re.compile(r"^q[0-9]{1,2}$")
STANCES = {"supports", "contradicts"}
CLAIM_STATUSES = {"asserted", "corroborated", "contested", "superseded"}
COVERAGE_STATUSES = {"covered", "weak", "missing"}
MAX_CLAIMS = 12
MAX_EVIDENCE = 4

# component -> (required props, optional props, {prop: kind}) where kind is "path" | "field" | "int"
COMPONENTS: dict[str, dict[str, Any]] = {
    "Compare": {"required": {"columns", "rows"}, "kinds": {"columns": "path", "rows": "path", "emphasizeColumn": "int"}},
    "Timeline": {"required": {"items", "label", "text"}, "kinds": {"items": "path", "label": "field", "text": "field"}},
    "MetricBars": {"required": {"items", "label", "value"}, "kinds": {"items": "path", "label": "field", "value": "field", "unit": "field"}},
    "KeyPoints": {"required": {"items"}, "kinds": {"items": "path"}},
}


def canonical_entity_id(name: str) -> str:
    """Stable id from the entity name, so the same entity links across findings."""
    norm = " ".join(name.strip().lower().split())
    if norm.isascii():
        slug = re.sub(r"[^a-z0-9]+", "-", norm).strip("-")[:60]
        if len(slug) >= 2:
            return f"e-{slug}"
    return "e-" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]


def canonicalize_entities(finding: dict) -> dict:
    """Rewrite entity ids to canonical ids and remap relation endpoints accordingly."""
    remap: dict[str, str] = {}
    seen: set[str] = set()
    entities = []
    for ent in finding.get("entities") or []:
        if not isinstance(ent, dict) or not isinstance(ent.get("name"), str) or not ent["name"].strip():
            continue
        new_id = canonical_entity_id(ent["name"])
        if isinstance(ent.get("id"), str):
            remap[ent["id"]] = new_id
        if new_id in seen:
            continue
        seen.add(new_id)
        etype = ent.get("type") if ent.get("type") in ENTITY_TYPES else "other"
        entities.append({"id": new_id, "type": etype, "name": ent["name"].strip()[:80]})
    relations = []
    for rel in finding.get("relations") or []:
        if not isinstance(rel, dict):
            continue
        rel = dict(rel)
        rel["from"] = remap.get(rel.get("from"), rel.get("from"))
        rel["to"] = remap.get(rel.get("to"), rel.get("to"))
        relations.append(rel)
    out = dict(finding)
    out["entities"] = entities
    out["relations"] = relations
    return out


def _str(v: Any, lo: int, hi: int) -> bool:
    return isinstance(v, str) and lo <= len(v) <= hi


def validate_finding(f: Any) -> list[str]:
    errs: list[str] = []
    if not isinstance(f, dict):
        return ["finding must be an object"]
    allowed = {"findingId", "projectId", "question", "summary", "keyPoints", "entities", "relations", "sources", "dataShape", "data",
               "confidence", "claims"}
    extra = set(f) - allowed
    if extra:
        errs.append(f"unknown fields: {sorted(extra)}")
    for req in allowed - {"relations", "claims"}:
        if req not in f:
            errs.append(f"missing {req}")
    if "findingId" in f and not (isinstance(f["findingId"], str) and FINDING_ID.match(f["findingId"])):
        errs.append("findingId must match ^f-[a-z0-9-]{1,40}$")
    if "projectId" in f and not (isinstance(f["projectId"], str) and PROJECT_ID.match(f["projectId"])):
        errs.append("projectId must match ^p-[a-z0-9-]{4,60}$")
    if "question" in f and not _str(f["question"], 3, 300):
        errs.append("question must be 3-300 chars")
    if "summary" in f and not _str(f["summary"], 10, 1200):
        errs.append("summary must be 10-1200 chars")
    kp = f.get("keyPoints")
    if "keyPoints" in f and not (isinstance(kp, list) and len(kp) <= 8 and all(_str(k, 0, 400) for k in kp)):
        errs.append("keyPoints must be up to 8 strings of at most 400 chars")
    ents = f.get("entities")
    if "entities" in f:
        if not isinstance(ents, list) or len(ents) > 12:
            errs.append("entities must be a list of at most 12")
        else:
            for i, e in enumerate(ents):
                if not (isinstance(e, dict) and set(e) == {"id", "type", "name"} and isinstance(e["id"], str) and re.match(r"^e-[a-z0-9-]{1,60}$", e["id"])
                        and e["type"] in ENTITY_TYPES and _str(e["name"], 1, 80)):
                    errs.append(f"entities[{i}] invalid")
    rels = f.get("relations", [])
    if not isinstance(rels, list) or len(rels) > 12:
        errs.append("relations must be a list of at most 12")
    else:
        for i, r in enumerate(rels):
            if not (isinstance(r, dict) and set(r) == {"from", "to", "type"} and r["type"] in RELATION_TYPES
                    and isinstance(r["from"], str) and NODE_ID.match(r["from"]) and isinstance(r["to"], str) and NODE_ID.match(r["to"])):
                errs.append(f"relations[{i}] invalid")
    srcs = f.get("sources")
    if "sources" in f:
        if not isinstance(srcs, list) or len(srcs) > 10:
            errs.append("sources must be a list of at most 10")
        else:
            for i, s in enumerate(srcs):
                if not (isinstance(s, dict) and set(s) == {"title", "url"} and _str(s["title"], 0, 300)
                        and isinstance(s["url"], str) and re.match(r"^https?://", s["url"])):
                    errs.append(f"sources[{i}] invalid")
    if "dataShape" in f and f["dataShape"] not in DATA_SHAPES:
        errs.append(f"dataShape must be one of {sorted(DATA_SHAPES)}")
    if "data" in f and not isinstance(f["data"], dict):
        errs.append("data must be an object")
    c = f.get("confidence")
    if "confidence" in f and not (isinstance(c, (int, float)) and not isinstance(c, bool) and 0 <= c <= 1):
        errs.append("confidence must be a number between 0 and 1")
    if "claims" in f:
        errs.extend(validate_claims(f["claims"]))
    return errs


def _int(v: Any, lo: int = 0, hi: int = 10**9) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


EVIDENCE_KEYS = {"docId", "quote", "stance", "charStart", "charEnd", "url", "title", "publisher", "duplicateOf", "sourceType", "score"}


def validate_claims(claims: Any) -> list[str]:
    """Stored claims (after finding_write verified them against the page snapshots)."""
    if not isinstance(claims, list) or len(claims) > MAX_CLAIMS:
        return [f"claims must be a list of at most {MAX_CLAIMS}"]
    errs: list[str] = []
    for i, c in enumerate(claims):
        if not isinstance(c, dict):
            errs.append(f"claims[{i}] must be an object")
            continue
        if not (isinstance(c.get("claimId"), str) and CLAIM_ID.match(c["claimId"])):
            errs.append(f"claims[{i}].claimId invalid")
        if not _str(c.get("text"), 5, 500):
            errs.append(f"claims[{i}].text must be 5-500 chars")
        if c.get("status") not in CLAIM_STATUSES:
            errs.append(f"claims[{i}].status must be one of {sorted(CLAIM_STATUSES)}")
        for key in ("independentSources", "supporting", "contradicting"):
            if not _int(c.get(key), 0, 100):
                errs.append(f"claims[{i}].{key} must be a non-negative integer")
        ev = c.get("evidence")
        if not isinstance(ev, list) or not 1 <= len(ev) <= MAX_EVIDENCE:
            errs.append(f"claims[{i}].evidence must have 1-{MAX_EVIDENCE} items")
            continue
        for j, e in enumerate(ev):
            ok = (isinstance(e, dict) and set(e) <= EVIDENCE_KEYS and isinstance(e.get("docId"), str) and DOC_ID.match(e["docId"])
                  and _str(e.get("quote"), 1, 600) and e.get("stance") in STANCES and _int(e.get("charStart"))
                  and _int(e.get("charEnd")) and isinstance(e.get("url"), str) and re.match(r"^https?://", e["url"]))
            if not ok:
                errs.append(f"claims[{i}].evidence[{j}] invalid")
    return errs


def validate_claim_drafts(claims: Any) -> list[str]:
    """Claims as a research agent submits them: text plus quotes it copied from read_page output."""
    if not isinstance(claims, list) or len(claims) > MAX_CLAIMS:
        return [f"claims must be a list of at most {MAX_CLAIMS}"]
    errs: list[str] = []
    for i, c in enumerate(claims):
        if not isinstance(c, dict) or not _str(c.get("text"), 5, 500):
            errs.append(f"claims[{i}].text must be 5-500 chars")
            continue
        ev = c.get("evidence")
        if not isinstance(ev, list) or not 1 <= len(ev) <= MAX_EVIDENCE:
            errs.append(f"claims[{i}].evidence must have 1-{MAX_EVIDENCE} items")
            continue
        for j, e in enumerate(ev):
            if not (isinstance(e, dict) and isinstance(e.get("docId"), str) and DOC_ID.match(e["docId"])
                    and _str(e.get("quote"), 8, 600) and e.get("stance", "supports") in STANCES):
                errs.append(f"claims[{i}].evidence[{j}] needs docId (d-…), a quote of 8-600 chars and stance supports|contradicts")
    return errs


def validate_requirements(reqs: Any) -> list[str]:
    if not isinstance(reqs, list) or len(reqs) > 12:
        return ["requirements must be a list of at most 12"]
    errs = []
    for i, r in enumerate(reqs):
        if not (isinstance(r, dict) and set(r) == {"id", "text"} and isinstance(r["id"], str) and REQUIREMENT_ID.match(r["id"])
                and _str(r["text"], 3, 300)):
            errs.append(f"requirements[{i}] must be {{id: q1.., text: 3-300 chars}}")
    return errs


def validate_coverage(items: Any) -> list[str]:
    if not isinstance(items, list) or len(items) > 12:
        return ["coverage must be a list of at most 12"]
    errs = []
    for i, c in enumerate(items):
        ok = (isinstance(c, dict) and set(c) <= {"id", "status", "claimIds", "note"} and isinstance(c.get("id"), str)
              and REQUIREMENT_ID.match(c["id"]) and c.get("status") in COVERAGE_STATUSES)
        ids = c.get("claimIds", []) if isinstance(c, dict) else None
        if ok and not (isinstance(ids, list) and len(ids) <= 12 and all(isinstance(x, str) and CLAIM_ID.match(x) for x in ids)):
            ok = False
        if ok and "note" in c and not _str(c["note"], 0, 300):
            ok = False
        if not ok:
            errs.append(f"coverage[{i}] must be {{id, status: covered|weak|missing, claimIds?, note?}}")
    return errs


def validate_spec(spec: Any) -> list[str]:
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    errs: list[str] = []
    extra = set(spec) - {"specVersion", "dataShape", "title", "root"}
    if extra:
        errs.append(f"unknown fields: {sorted(extra)}")
    if spec.get("specVersion") != 1:
        errs.append("specVersion must be 1")
    if spec.get("dataShape") not in DATA_SHAPES:
        errs.append("dataShape invalid")
    if "title" in spec and not _str(spec["title"], 0, 80):
        errs.append("title must be at most 80 chars")
    root = spec.get("root")
    if not isinstance(root, dict) or set(root) != {"component", "props"}:
        return errs + ["root must have exactly component and props"]
    comp = root.get("component")
    if comp not in COMPONENTS:
        return errs + [f"元件 {comp} 不在白名單內"]
    rule = COMPONENTS[comp]
    props = root.get("props")
    if not isinstance(props, dict):
        return errs + ["props must be an object"]
    missing = rule["required"] - set(props)
    if missing:
        errs.append(f"{comp} missing props {sorted(missing)}")
    for k, v in props.items():
        kind = rule["kinds"].get(k)
        if kind is None:
            errs.append(f"{comp} does not accept prop {k}")
        elif kind == "path" and not (isinstance(v, str) and PATH.match(v)):
            errs.append(f"{comp}.{k} must be a path like $.data.items")
        elif kind == "field" and not (isinstance(v, str) and FIELD.match(v)):
            errs.append(f"{comp}.{k} must be a field name")
        elif kind == "int" and not (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 10):
            errs.append(f"{comp}.{k} must be an integer 0-10")
    return errs


def resolve(path: str, obj: Any) -> Any:
    cur = obj
    for part in path[2:].split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def check_spec_fits(spec: dict, finding: dict) -> list[str]:
    """The spec must render something for this finding: every path resolves to a non-empty list."""
    errs = []
    if spec.get("dataShape") != finding.get("dataShape"):
        errs.append(f"spec is for {spec.get('dataShape')}, finding is {finding.get('dataShape')}")
    for k, v in spec["root"]["props"].items():
        if isinstance(v, str) and v.startswith("$."):
            val = resolve(v, finding)
            if not isinstance(val, list) or not val:
                errs.append(f"{k} path {v} does not resolve to a non-empty list")
    return errs
