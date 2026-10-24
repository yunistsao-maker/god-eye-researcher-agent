"""data-tools target: plan_propose, plan_save, finding_write, coverage_save, ui_template_get, ui_spec_write,
synthesis_write, qa_write.

Each write persists first, then publishes the matching AppSync event, so a subscriber that
sees an event can always read the same data back with project_get. Writes to a stopped project
are refused ({ok: false, stopped: true}), so nothing changes after the user stops it.

finding_write is where evidence becomes trustworthy: every claim a research agent submits carries
quotes from pages it read with fetch_page. Each quote must appear in that page's stored snapshot
(compared ignoring case, width, quote style and whitespace); quotes that do not are dropped, and a
finding whose claims mostly fail is sent back with the reasons. A claim's status then follows from
its verified evidence: contested if any independent source contradicts it, corroborated with two or
more independent supporting publishers (a duplicate page counts as its original), asserted otherwise.
"""
from __future__ import annotations

import math
import re
from typing import Any, Optional

from botocore.exceptions import ClientError

from common import appsync, sources, store
from common.toolkit import FINDING_ID, ToolError, caller, dispatch, require_owner, require_project_id, require_writable
from common.validate import (CLAIM_ID, DATA_SHAPES, QA_ID, STEER_ID, canonicalize_entities, check_spec_fits, validate_brief,
                             validate_claim_drafts, validate_coverage, validate_finding, validate_requirements, validate_spec)

MAX_PLAN_ITEMS = 40      # all rounds and versions of a project
MAX_PROPOSED = 12        # one proposed plan
MAX_ROUNDS = 10
MAX_VERSIONS = 50
MAX_QA = 50


def _int_in(v: Any, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _sub_questions(subs: Any, limit: int, extended: bool) -> list[dict]:
    if not isinstance(subs, list) or not 1 <= len(subs) <= limit:
        raise ToolError(f"subQuestions must be a list of 1-{limit} items")
    clean = []
    seen: set[str] = set()
    for i, s in enumerate(subs):
        if not isinstance(s, dict):
            raise ToolError(f"subQuestions[{i}] must be an object")
        fid, q, shape = s.get("findingId"), s.get("question"), s.get("dataShape")
        if not (isinstance(fid, str) and FINDING_ID.match(fid)) or fid in seen:
            raise ToolError(f"subQuestions[{i}].findingId must be unique and match {FINDING_ID.pattern}")
        seen.add(fid)
        if not (isinstance(q, str) and 3 <= len(q) <= 300):
            raise ToolError(f"subQuestions[{i}].question must be 3-300 chars")
        if shape not in DATA_SHAPES:
            raise ToolError(f"subQuestions[{i}].dataShape must be one of {sorted(DATA_SHAPES)}")
        item: dict[str, Any] = {"findingId": fid, "question": q, "dataShape": shape}
        if extended:
            if s.get("round") is not None:
                if not _int_in(s["round"], 1, MAX_ROUNDS):
                    raise ToolError(f"subQuestions[{i}].round must be 1-{MAX_ROUNDS}")
                item["round"] = s["round"]
            if s.get("version") is not None:
                if not _int_in(s["version"], 1, MAX_VERSIONS):
                    raise ToolError(f"subQuestions[{i}].version must be 1-{MAX_VERSIONS}")
                item["version"] = s["version"]
            if s.get("updates") is not None:
                if not (isinstance(s["updates"], str) and FINDING_ID.match(s["updates"])):
                    raise ToolError(f"subQuestions[{i}].updates must be a findingId")
                item["updates"] = s["updates"]
        clean.append(item)
    return clean


def plan_propose(event: dict) -> dict:
    """A plan for the user to review before the research starts (the project is a draft). The
    planner proposes it (by: agent); the user's edits are saved the same way (by: user)."""
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_owner(pid, sub)
    if meta.get("status") != "draft":
        raise ToolError(f"Project {pid} is {meta.get('status')}; a plan can be proposed only for a draft")
    clean = _sub_questions(event.get("subQuestions"), MAX_PROPOSED, extended=False)
    reqs = event.get("requirements") or []
    errors = validate_requirements(reqs)
    if errors:
        raise ToolError("; ".join(errors[:3]))
    by = event.get("by", "agent")
    if by not in ("agent", "user"):
        raise ToolError("by must be agent or user")
    record: dict[str, Any] = {"subQuestions": clean, "requirements": reqs, "by": by, "updatedAt": store.now_iso()}
    brief = event.get("brief")
    if brief is not None:
        errors = validate_brief(brief)
        if errors:
            raise ToolError("; ".join(errors[:3]))
        store.table().update_item(Key={"PK": store.project_pk(pid), "SK": "META"}, UpdateExpression="SET brief = :b, updatedAt = :u",
                                  ExpressionAttributeValues={":b": store.to_ddb(brief), ":u": store.now_iso()})
    else:
        brief = store.to_plain(meta.get("brief") or {})
    store.table().put_item(Item={"PK": store.project_pk(pid), "SK": "PROPOSED", **store.to_ddb(record)})
    appsync.publish(pid, [("plan.proposed", {"subQuestions": clean, "requirements": reqs, "brief": brief, "by": by})])
    return {"ok": True, "count": len(clean)}


def plan_save(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    require_writable(pid, sub)
    clean = _sub_questions(event.get("subQuestions"), MAX_PLAN_ITEMS, extended=True)
    steer_ids = event.get("steerIds") or []
    if not (isinstance(steer_ids, list) and len(steer_ids) <= 10 and all(isinstance(x, str) and STEER_ID.match(x) for x in steer_ids)):
        raise ToolError("steerIds must be a list of at most 10 steer ids")
    item: dict[str, Any] = {"PK": store.project_pk(pid), "SK": "PLAN", "subQuestions": clean, "updatedAt": store.now_iso()}
    data: dict[str, Any] = {"subQuestions": clean}
    reqs = event.get("requirements")
    if reqs is not None:
        errors = validate_requirements(reqs)
        if errors:
            raise ToolError("; ".join(errors[:3]))
        item["requirements"] = data["requirements"] = reqs
    else:  # a follow-up round re-sends the plan without them; keep the ones saved with round 1
        old = store.table().get_item(Key={"PK": store.project_pk(pid), "SK": "PLAN"}).get("Item") or {}
        if old.get("requirements"):
            item["requirements"] = data["requirements"] = store.to_plain(old["requirements"])
    store.table().put_item(Item=item)
    if steer_ids:
        rnd = max(int(q.get("round") or 1) for q in clean)
        for steer in store.query_project(pid, "STEER#"):
            if steer.get("steerId") in steer_ids:
                store.table().update_item(Key={"PK": store.project_pk(pid), "SK": steer["SK"]}, UpdateExpression="SET appliedRound = :r",
                                          ExpressionAttributeValues={":r": rnd})
        data["steerIds"] = steer_ids
    appsync.publish(pid, [("plan.ready", data)])
    return {"ok": True, "count": len(clean)}


def _project_docs(pid: str) -> dict[str, dict]:
    return {d["docId"]: d for d in store.query_project(pid, "DOC#") if d.get("docId")}


def _verify_claims(pid: str, fid: str, drafts: list[dict]) -> tuple[list[dict], list[str], list[dict]]:
    """Check every quote against its page snapshot. Returns (claims, problems, cited docs)."""
    docs = _project_docs(pid)
    texts: dict[str, Optional[str]] = {}
    claims: list[dict] = []
    problems: list[str] = []
    cited: dict[str, dict] = {}
    for i, draft in enumerate(drafts):
        evidence = []
        for j, ev in enumerate(draft["evidence"]):
            doc = docs.get(ev["docId"])
            if not doc or doc.get("status") != "ok":
                problems.append(f"claims[{i}].evidence[{j}]: {ev['docId']} is not a page you read in this project; read it with read_page first")
                continue
            if ev["docId"] not in texts:
                texts[ev["docId"]] = store.read_text(store.doc_key(pid, ev["docId"]))
            text = texts[ev["docId"]]
            span = sources.find_quote(ev["quote"], text) if text else None
            if not span:
                problems.append(f"claims[{i}].evidence[{j}]: the quote was not found in {ev['docId']}; copy it exactly from the page text")
                continue
            original = docs.get(doc.get("duplicateOf") or "", doc)
            evidence.append({
                "docId": doc["docId"], "quote": text[span[0]:span[1]][:600], "stance": ev.get("stance", "supports"),
                "charStart": span[0], "charEnd": span[1], "url": doc["url"], "title": (doc.get("title") or doc["url"])[:300],
                "publisher": original.get("publisher") or doc.get("publisher") or sources.publisher(doc["url"]),
                "duplicateOf": doc.get("duplicateOf"), "sourceType": doc.get("sourceType", "unknown"), "score": doc.get("score", 0.5),
            })
            cited[doc["docId"]] = doc  # the page actually quoted is the one a reader opens
        if not evidence:
            continue
        backers = {e["publisher"] for e in evidence if e["stance"] == "supports"}
        against = {e["publisher"] for e in evidence if e["stance"] == "contradicts"}
        status = "contested" if against else ("corroborated" if len(backers) >= 2 else "asserted")
        claim = {"claimId": f"c-{fid[2:]}-{len(claims) + 1}", "text": draft["text"].strip()[:500], "status": status,
                 "independentSources": len(backers), "supporting": len(backers), "contradicting": len(against),
                 "evidence": evidence}
        if draft.get("updates"):
            claim["updates"] = draft["updates"]
        claims.append(claim)
    return claims, problems, list(cited.values())


def finding_of_claim(claim_id: str) -> str:
    """c-3-2 -> f-3, c-abc-3-1 -> f-abc-3 (claim ids are c-{finding suffix}-{n})."""
    return "f-" + claim_id[2:].rsplit("-", 1)[0]


def _supersede(pid: str, fid: str, claims: list[dict], warnings: list[str]) -> list[dict]:
    """An incremental run's claim that `updates` an earlier claim replaces it: the earlier claim is
    marked superseded in its own finding. Unknown or invalid targets are dropped with a warning."""
    by_finding: dict[str, list[dict]] = {}
    for c in claims:
        target = c.get("updates")
        if not target:
            continue
        old_fid = finding_of_claim(target)
        if not CLAIM_ID.match(target) or old_fid == fid or not FINDING_ID.match(old_fid):
            c.pop("updates", None)
            warnings.append(f"{c['claimId']}: updates must name a claim of an earlier finding")
            continue
        by_finding.setdefault(old_fid, []).append(c)
    changed: list[dict] = []
    tbl = store.table()
    for old_fid, newer in by_finding.items():
        item = tbl.get_item(Key={"PK": store.project_pk(pid), "SK": f"FINDING#{old_fid}"}).get("Item")
        old = store.to_plain(item["finding"]) if item else None
        known = {c["claimId"]: c for c in (old or {}).get("claims") or []}
        touched = False
        for c in newer:
            target = known.get(c["updates"])
            if target is None or target.get("status") == "superseded":
                warnings.append(f"{c['claimId']}: {c['updates']} is not a current claim of {old_fid}")
                c.pop("updates", None)
                continue
            target["status"] = "superseded"
            target["supersededBy"] = c["claimId"]
            changed.append({"claimId": target["claimId"], "findingId": old_fid, "supersededBy": c["claimId"]})
            touched = True
        if touched and old is not None:
            tbl.update_item(Key={"PK": store.project_pk(pid), "SK": f"FINDING#{old_fid}"}, UpdateExpression="SET finding = :f",
                            ExpressionAttributeValues={":f": store.to_ddb(old)})
            store.put_json(f"{store.project_prefix(pid)}findings/{old_fid}.json", old)
    return changed


def finding_write(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    require_writable(pid, sub)
    raw = event.get("finding")
    if not isinstance(raw, dict):
        raise ToolError("finding must be an object")
    finding = canonicalize_entities({**raw, "projectId": pid})
    finding.setdefault("relations", [])
    warnings: list[str] = []
    drafts = finding.pop("claims", None)
    if drafts is not None:
        errors = validate_claim_drafts(drafts)
        if errors:
            return {"ok": False, "errors": errors[:8]}
        fid_raw = finding.get("findingId")
        if not (isinstance(fid_raw, str) and FINDING_ID.match(fid_raw)):
            return {"ok": False, "errors": [f"findingId must match {FINDING_ID.pattern}"]}
        claims, problems, cited = _verify_claims(pid, fid_raw, drafts)
        if drafts and len(claims) < math.ceil(len(drafts) / 2):
            return {"ok": False, "errors": problems[:8] + [
                f"Only {len(claims)} of {len(drafts)} claims had a quote found in the pages you read. Quote each passage "
                "exactly as it appears in the read_page text, and cite the docId that read_page returned."]}
        warnings = problems
        finding["claims"] = claims
        seen = set()
        merged = []
        for src in [{"title": (d.get("title") or d["url"])[:300], "url": d["url"]} for d in cited] + list(finding.get("sources") or []):
            key = sources.canonical_url(src.get("url", "")) if isinstance(src, dict) and isinstance(src.get("url"), str) else None
            if key and key not in seen:
                seen.add(key)
                merged.append(src)
        finding["sources"] = merged[:10]
    errors = validate_finding(finding)
    if errors:
        return {"ok": False, "errors": errors}

    fid = finding["findingId"]
    pk = store.project_pk(pid)
    tbl = store.table()
    superseded: list[dict] = []
    if any(c.get("updates") for c in finding.get("claims") or []):
        if tbl.get_item(Key={"PK": pk, "SK": f"FINDING#{fid}"}).get("Item") is None:  # a rewrite never supersedes twice
            superseded = _supersede(pid, fid, finding["claims"], warnings)
        else:
            for c in finding["claims"]:
                c.pop("updates", None)
    store.put_json(f"{store.project_prefix(pid)}findings/{fid}.json", finding)
    is_new = "Attributes" not in tbl.put_item(
        Item={"PK": pk, "SK": f"FINDING#{fid}", "finding": store.to_ddb(finding), "dataShape": finding["dataShape"], "createdAt": store.now_iso()},
        ReturnValues="ALL_OLD",
    )

    edges: list[dict[str, Any]] = []
    for ent in finding["entities"]:
        edges.append({"from": fid, "to": ent["id"], "type": "mentions"})
        res = tbl.update_item(
            Key={"PK": pk, "SK": f"ENTITY#{ent['id']}"},
            UpdateExpression="SET #n = if_not_exists(#n, :n), #t = if_not_exists(#t, :t) ADD findings :f",
            ExpressionAttributeNames={"#n": "name", "#t": "type"},
            ExpressionAttributeValues={":n": ent["name"], ":t": ent["type"], ":f": {fid}},
            ReturnValues="UPDATED_OLD",
        )
        for other in sorted(res.get("Attributes", {}).get("findings", set())):
            if other != fid:
                edges.append({"from": fid, "to": other, "type": "shares_entity", "via": ent["id"]})
    for rel in finding["relations"]:
        edges.append({"from": rel["from"], "to": rel["to"], "type": rel["type"]})

    with tbl.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
        for e in edges:
            sk = f"EDGE#{e['from']}#{e['type']}#{e['to']}" + (f"#{e['via']}" if e.get("via") else "")
            batch.put_item(Item={"PK": pk, "SK": sk, **e})
    if is_new:
        tbl.update_item(Key={"PK": pk, "SK": "META"}, UpdateExpression="ADD findingCount :one SET updatedAt = :u",
                        ExpressionAttributeValues={":one": 1, ":u": store.now_iso()})

    events: list[tuple[str, dict]] = [
        ("finding.ready", {"finding": finding}),
        ("relation.added", {"entities": finding["entities"], "edges": edges}),
    ]
    if superseded:
        events.append(("claims.updated", {"superseded": superseded}))
    appsync.publish(pid, events)
    out: dict[str, Any] = {"ok": True, "findingId": fid, "edges": len(edges), "entities": [e["id"] for e in finding["entities"]]}
    if "claims" in finding:
        out["claims"] = finding["claims"]   # the verified form, so the caller can build on exactly what was stored
        out["sources"] = finding["sources"]
        out["warnings"] = warnings[:8]
    return out


def coverage_save(event: dict) -> dict:
    """Save how well the findings so far cover each requirement of the plan, and announce it."""
    sub = caller(event)
    pid = require_project_id(event)
    require_writable(pid, sub)
    items = event.get("coverage")
    errors = validate_coverage(items)
    if errors:
        raise ToolError("; ".join(errors[:3]))
    rnd = event.get("round", 1)
    if not (isinstance(rnd, int) and not isinstance(rnd, bool) and 1 <= rnd <= MAX_ROUNDS):
        raise ToolError(f"round must be 1-{MAX_ROUNDS}")
    record = {"round": rnd, "requirements": items, "updatedAt": store.now_iso()}
    store.table().put_item(Item={"PK": store.project_pk(pid), "SK": "COVERAGE", **store.to_ddb(record)})
    appsync.publish(pid, [("coverage.updated", record)])
    covered = sum(1 for c in items if c["status"] == "covered")
    return {"ok": True, "covered": covered, "total": len(items)}


def ui_template_get(event: dict) -> dict:
    caller(event)
    shape = event.get("dataShape")
    if shape not in DATA_SHAPES:
        raise ToolError(f"dataShape must be one of {sorted(DATA_SHAPES)}")
    item = store.table().get_item(Key={"PK": f"TEMPLATE#{shape}", "SK": "V#1"}).get("Item")
    if not item:
        return {"ok": True, "hit": False, "spec": None}
    store.table().update_item(Key={"PK": f"TEMPLATE#{shape}", "SK": "V#1"}, UpdateExpression="ADD uses :one",
                              ExpressionAttributeValues={":one": 1})
    return {"ok": True, "hit": True, "spec": store.to_plain(item["spec"])}


def ui_spec_write(event: dict) -> dict:
    sub = caller(event)
    pid = require_project_id(event)
    require_writable(pid, sub)
    fid = event.get("findingId")
    if not (isinstance(fid, str) and FINDING_ID.match(fid)):
        raise ToolError(f"findingId must match {FINDING_ID.pattern}")
    from_cache = bool(event.get("fromCache"))
    spec = event.get("spec")
    item = store.table().get_item(Key={"PK": store.project_pk(pid), "SK": f"FINDING#{fid}"}).get("Item")
    if not item:
        raise ToolError(f"Finding {fid} not found; write it with finding_write first")
    finding = store.to_plain(item["finding"])

    errors = validate_spec(spec)
    if not errors:
        errors = check_spec_fits(spec, finding)
    if errors:
        reason = "spec 驗證失敗：" + "；".join(errors[:3])
        appsync.publish(pid, [("ui.failed", {"findingId": fid, "reason": reason})])
        return {"ok": False, "reason": reason}

    tbl = store.table()
    tbl.put_item(Item={"PK": store.project_pk(pid), "SK": f"UI#{fid}", "spec": store.to_ddb(spec), "cache": from_cache, "createdAt": store.now_iso()})
    store.put_json(f"{store.project_prefix(pid)}ui/{fid}.json", spec)
    template_saved = False
    if not from_cache:
        try:
            tbl.put_item(
                Item={"PK": f"TEMPLATE#{spec['dataShape']}", "SK": "V#1", "spec": store.to_ddb(spec), "createdAt": store.now_iso(), "uses": 1},
                ConditionExpression="attribute_not_exists(PK)",
            )
            store.put_json(f"ui-templates/{spec['dataShape']}/v1.json", spec)
            template_saved = True
        except ClientError as err:
            if err.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    appsync.publish(pid, [("ui.ready", {"findingId": fid, "spec": spec, "cache": from_cache})])
    return {"ok": True, "templateSaved": template_saved}


CITATION = re.compile(r"^C[1-9][0-9]{0,2}$")
VERIFICATION_COUNTS = ("citedSentences", "supported", "partial", "unsupported", "revised", "removed", "uncitedSentences",
                       "unknownCitations", "claimsCited")


def _str_list(event: dict, key: str) -> list[str]:
    value = event.get(key) or []
    if not isinstance(value, list) or len(value) > 10 or not all(isinstance(v, str) and len(v) <= 600 for v in value):
        raise ToolError(f"{key} must be a list of at most 10 strings of at most 600 chars")
    return value


def synthesis_write(event: dict) -> dict:
    """Save the final report, then announce it. The report text was already streamed to the UI by
    the runtime as synthesis.delta events; this is the durable copy that project_get returns."""
    sub = caller(event)
    pid = require_project_id(event)
    meta = require_writable(pid, sub)
    report = event.get("report")
    if not (isinstance(report, str) and 1 <= len(report.strip()) <= 30_000):
        raise ToolError("report must be 1-30000 chars of Markdown")
    synthesis = {
        "report": report.strip(),
        "contradictions": _str_list(event, "contradictions"),
        "gaps": _str_list(event, "gaps"),
        "followUps": _str_list(event, "followUps"),
        "createdAt": store.now_iso(),
    }
    citations = event.get("citations")
    if citations is not None:
        synthesis["citations"] = _citations(citations)
    verification = event.get("verification")
    if verification is not None:
        if not isinstance(verification, dict):
            raise ToolError("verification must be an object")
        clean: dict[str, Any] = {}
        for key in VERIFICATION_COUNTS:
            if key in verification:
                v = verification[key]
                if not (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 10_000):
                    raise ToolError(f"verification.{key} must be a non-negative integer")
                clean[key] = v
        for key in ("precisionBefore", "precisionAfter"):
            if verification.get(key) is not None:
                v = verification[key]
                if not (isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1):
                    raise ToolError(f"verification.{key} must be between 0 and 1")
                clean[key] = round(float(v), 3)
        dead = verification.get("deadUrls", [])
        if not (isinstance(dead, list) and len(dead) <= 50 and all(isinstance(u, str) and len(u) <= 2000 for u in dead)):
            raise ToolError("verification.deadUrls must be a list of URLs")
        clean["deadUrls"] = dead
        synthesis["verification"] = clean
    version = int(meta.get("version") or 1)
    synthesis["version"] = version
    changes = event.get("changes")
    if changes is not None:
        if not (isinstance(changes, dict) and set(changes) <= {"newClaims", "updatedClaims"}
                and all(_int_in(v, 0, 10_000) for v in changes.values())):
            raise ToolError("changes must be {newClaims, updatedClaims} counts")
        synthesis["changes"] = changes
    tbl = store.table()
    previous = tbl.get_item(Key={"PK": store.project_pk(pid), "SK": "SYNTHESIS"}).get("Item")
    if previous and int(previous.get("version") or 1) != version:  # an incremental run keeps the earlier report
        old = store.to_plain(previous)
        old_version = int(old.get("version") or 1)
        tbl.put_item(Item={"PK": store.project_pk(pid), "SK": f"SYNTHESIS#V{old_version:03d}",
                           **store.to_ddb({k: old.get(k) for k in ("version", "createdAt", "report") if old.get(k) is not None}),
                           "version": old_version})
        store.s3_client().put_object(Bucket=store.bucket(), Key=f"{store.project_prefix(pid)}synthesis-v{old_version}.md",
                                     Body=str(old.get("report", "")).encode("utf-8"), ContentType="text/markdown; charset=utf-8")
    store.s3_client().put_object(Bucket=store.bucket(), Key=f"{store.project_prefix(pid)}synthesis.md",
                                 Body=synthesis["report"].encode("utf-8"), ContentType="text/markdown; charset=utf-8")
    store.put_json(f"{store.project_prefix(pid)}synthesis.json", synthesis)
    tbl.put_item(Item={"PK": store.project_pk(pid), "SK": "SYNTHESIS", **store.to_ddb(synthesis)})
    appsync.publish(pid, [("synthesis.ready", {"synthesis": synthesis})])
    return {"ok": True}


def _citations(raw: Any) -> dict[str, dict]:
    if not (isinstance(raw, dict) and len(raw) <= 300 and all(
            isinstance(k, str) and CITATION.match(k) and isinstance(v, dict) and isinstance(v.get("claimId"), str)
            and isinstance(v.get("findingId"), str) and FINDING_ID.match(v["findingId"]) for k, v in raw.items())):
        raise ToolError("citations must map C1..C300 to {claimId, findingId}")
    return {k: {"claimId": v["claimId"], "findingId": v["findingId"]} for k, v in raw.items()}


def qa_write(event: dict) -> dict:
    """Save an answer to a follow-up question about the report, then announce it."""
    sub = caller(event)
    pid = require_project_id(event)
    require_writable(pid, sub)
    qa_id, question, answer = event.get("qaId"), event.get("question"), event.get("answer")
    if not (isinstance(qa_id, str) and QA_ID.match(qa_id)):
        raise ToolError(f"qaId must match {QA_ID.pattern}")
    if not (isinstance(question, str) and 2 <= len(question.strip()) <= 1000):
        raise ToolError("question must be 2-1000 chars")
    if not (isinstance(answer, str) and 1 <= len(answer.strip()) <= 20_000):
        raise ToolError("answer must be 1-20000 chars of Markdown")
    selection = event.get("selection")
    if selection is not None and not (isinstance(selection, str) and len(selection) <= 2000):
        raise ToolError("selection must be at most 2000 chars")
    needs = event.get("needsResearch", False)
    research_q = event.get("researchQuestion")
    if not isinstance(needs, bool) or (research_q is not None and not (isinstance(research_q, str) and len(research_q) <= 300)):
        raise ToolError("needsResearch must be a boolean and researchQuestion at most 300 chars")
    existing = store.query_project(pid, "QA#")
    if len(existing) >= MAX_QA and not any(q.get("qaId") == qa_id for q in existing):
        raise ToolError(f"At most {MAX_QA} questions per project")
    qa: dict[str, Any] = {"qaId": qa_id, "question": question.strip(), "answer": answer.strip(),
                          "citations": _citations(event.get("citations") or {}), "needsResearch": needs, "createdAt": store.now_iso()}
    if selection:
        qa["selection"] = selection
    if needs and research_q:
        qa["researchQuestion"] = research_q.strip()
    for old in existing:  # answering the same qaId again replaces it
        if old.get("qaId") == qa_id:
            store.table().delete_item(Key={"PK": store.project_pk(pid), "SK": old["SK"]})
    store.table().put_item(Item={"PK": store.project_pk(pid), "SK": f"QA#{qa['createdAt']}#{qa_id}", **store.to_ddb(qa)})
    appsync.publish(pid, [("qa.ready", {"qa": qa})])
    return {"ok": True}


HANDLERS = {"plan_propose": plan_propose, "plan_save": plan_save, "finding_write": finding_write, "coverage_save": coverage_save,
            "ui_template_get": ui_template_get, "ui_spec_write": ui_spec_write, "synthesis_write": synthesis_write,
            "qa_write": qa_write}


def handler(event: dict, context: Any) -> dict:
    return dispatch(HANDLERS, event, context)
