"""LLM judge for the binary rubric in questions.json.

One call per report: the judge sees the question, the rubric items, the report, and an appendix of
the claims the report cites (status, publishers, source types), and returns pass/fail per item with
a one-line reason. Binary items agree with expert raters better than graded scales, and judging only
what the report does (not what the true answer is) keeps the rubric stable as the world changes.
The judge is told to ignore length and Markdown styling, two known judge biases.
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from typing import Any, Callable, Optional

JUDGE_MODEL_ID = os.environ.get("JUDGE_MODEL_ID", "us.anthropic.claude-sonnet-5-5")

SYSTEM = """You grade one research report against a rubric of binary criteria.
For each criterion decide pass or fail, judging only what the report itself does. Do not use your
own knowledge of the topic to reward or punish facts; a criterion about sources is judged from the
evidence appendix, which lists each cited claim [C#] with its status and the publishers and source
types behind it. Ignore length, Markdown styling and tone unless a criterion asks about them; a longer
report does not pass a criterion it does not meet. Be strict: pass only when the report clearly meets
the criterion.
Answer with JSON only: {"items": [{"id": "r1", "pass": true, "reason": "one short sentence"}, ...]}
with exactly one entry per rubric id."""


def evidence_appendix(project_get: dict) -> list[dict]:
    synthesis = project_get.get("synthesis") or {}
    cites = synthesis.get("citations") or {}
    claims = {c["claimId"]: c for f in project_get.get("findings") or [] for c in f.get("claims") or []}
    rows = []
    for label, ref in sorted(cites.items(), key=lambda kv: int(kv[0][1:])):
        c = claims.get(ref.get("claimId"))
        if not c:
            continue
        rows.append({"label": label, "claim": c["text"], "status": c["status"],
                     "sources": [{"publisher": e.get("publisher"), "type": e.get("sourceType"), "stance": e.get("stance")}
                                 for e in c.get("evidence", [])]})
    return rows


def build_prompt(question: dict, project_get: dict) -> str:
    report = (project_get.get("synthesis") or {}).get("report") or "(no report was produced)"
    payload = {
        "question": question["question"], "audience": question.get("audience", ""), "timeRange": question.get("timeRange", ""),
        "rubric": [{"id": r["id"], "type": r["type"], "criterion": r["criterion"]} for r in question["rubric"]],
    }
    return (f"{json.dumps(payload, ensure_ascii=False)}\n\n<report>\n{report[:60_000]}\n</report>\n\n"
            f"<evidence_appendix>\n{json.dumps(evidence_appendix(project_get), ensure_ascii=False)[:40_000]}\n</evidence_appendix>")


def parse(text: str, rubric: list[dict]) -> list[dict]:
    """Pull the JSON object out of the reply; a missing or malformed entry counts as a fail."""
    match = re.search(r"\{.*\}", text, re.S)
    items: dict[str, dict] = {}
    if match:
        try:
            for it in json.loads(match.group(0)).get("items", []):
                if isinstance(it, dict) and isinstance(it.get("id"), str):
                    items[it["id"]] = it
        except (ValueError, AttributeError):
            pass
    out = []
    for r in rubric:
        it = items.get(r["id"])
        out.append({"id": r["id"], "type": r["type"], "pass": bool(it and it.get("pass") is True),
                    "reason": (str(it.get("reason", "")) if it else "no verdict returned")[:300]})
    return out


def bedrock_caller(model_id: str = JUDGE_MODEL_ID, region: Optional[str] = None) -> Callable[[str, str], str]:
    import boto3
    client = boto3.client("bedrock-runtime", region_name=region or os.environ.get("AWS_REGION", "us-west-2"))

    def call(system: str, prompt: str) -> str:
        res = client.converse(modelId=model_id, system=[{"text": system}],
                              messages=[{"role": "user", "content": [{"text": prompt}]}],
                              inferenceConfig={"maxTokens": 8000})
        return "".join(b.get("text", "") for b in res["output"]["message"]["content"] if isinstance(b, dict))

    return call


def judge(question: dict, project_get: dict, call: Callable[[str, str], str]) -> dict[str, Any]:
    prompt = build_prompt(question, project_get)
    items = parse(call(SYSTEM, prompt), question["rubric"])
    if sum(1 for i in items if i["reason"] == "no verdict returned") > len(items) // 2:
        items = parse(call(SYSTEM, prompt + "\n\nReturn the JSON object only."), question["rubric"])  # one retry
    by_type: dict[str, list[bool]] = defaultdict(list)
    for i in items:
        by_type[i["type"]].append(i["pass"])
    return {
        "rubricScore": round(sum(i["pass"] for i in items) / len(items), 3) if items else None,
        "byType": {t: round(sum(v) / len(v), 3) for t, v in sorted(by_type.items())},
        "items": items,
    }
