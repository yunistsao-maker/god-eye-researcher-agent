"""Evaluation harness: question set, deterministic metrics, judge parsing, scoring and comparison."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "eval"))

import client  # noqa: E402
import evaluate  # noqa: E402
import judge  # noqa: E402
from metrics import project_metrics  # noqa: E402

FIXTURE = json.loads((ROOT / "contracts" / "fixtures" / "evidence-run.json").read_text(encoding="utf-8"))["projectGet"]


def test_question_set_is_well_formed():
    qs = evaluate.load_questions()
    assert len(qs) == 20 and len({q["id"] for q in qs}) == 20
    assert sum(q["lang"] == "zh-TW" for q in qs) == 10
    types = {"coverage", "accuracy", "sourcing", "structure", "insight", "limits"}
    for q in qs:
        assert re.match(r"^[a-z]+-(zh|en)-\d{2}$", q["id"]) and q["depth"] in ("quick", "standard", "deep")
        assert 8 <= len(q["rubric"]) <= 12 and [r["id"] for r in q["rubric"]] == [f"r{i}" for i in range(1, len(q["rubric"]) + 1)]
        assert {r["type"] for r in q["rubric"]} <= types and {"sourcing", "insight", "limits"} <= {r["type"] for r in q["rubric"]}
        assert evaluate.brief_for(q, None)["depth"] == q["depth"]


def test_metrics_from_an_evidence_run():
    m = project_metrics(FIXTURE)
    assert m["claims"] == 3 and m["claimsCorroborated"] == 1 and m["claimsContested"] == 1
    assert m["sources"] == 4 and m["duplicates"] == 1 and m["publishers"] == 4
    assert m["coverageShare"] == 0.333 and m["requirementsMissing"] == 1
    assert m["citationPrecisionBefore"] == 0.6 and m["citationPrecisionAfter"] == 1.0 and m["deadUrls"] == 1
    assert m["citedSentenceShare"] == 0.8 and m["reportWords"] > 20


def test_judge_parses_verdicts_and_fails_missing_ones():
    q = evaluate.load_questions()[0]
    calls = []

    def fake(system, prompt):
        calls.append(prompt)
        items = [{"id": r["id"], "pass": i % 2 == 0, "reason": "ok"} for i, r in enumerate(q["rubric"][:-1])]
        return "Here you go:\n" + json.dumps({"items": items})

    out = judge.judge(q, FIXTURE, fake)
    assert len(calls) == 1 and "<evidence_appendix>" in calls[0] and "設備商案例與調查對回收期的說法不同" in calls[0]
    assert out["items"][-1] == {**out["items"][-1], "pass": False, "reason": "no verdict returned"}
    passed = sum(i["pass"] for i in out["items"])
    assert out["rubricScore"] == round(passed / len(q["rubric"]), 3) and set(out["byType"]) <= {r["type"] for r in q["rubric"]}
    appendix = judge.evidence_appendix(FIXTURE)
    assert appendix and all(row["sources"] for row in appendix)
    assert judge.parse("not json", q["rubric"])[0]["pass"] is False


def test_score_and_compare_runs(tmp_path):
    q = evaluate.load_questions()[0]
    for label, report_ok in (("base", False), ("cand", True)):
        d = tmp_path / label
        d.mkdir()
        got = json.loads(json.dumps(FIXTURE))
        if not report_ok:
            got["synthesis"]["verification"]["precisionAfter"] = 0.5
        (d / f"{q['id']}.json").write_text(json.dumps({"question": q, "status": "completed", "elapsedSec": 300, "projectGet": got}))
        scores = evaluate.score_runs(d, lambda s, p, ok=report_ok: json.dumps({"items": [{"id": r["id"], "pass": ok} for r in q["rubric"]]}))
        summary = evaluate.write_reports(d, scores)
        assert summary["completed"] == 1 and (d / "summary.md").exists() and (d / "scores.csv").exists()
    load = lambda n: json.loads((tmp_path / n / "scores.json").read_text())  # noqa: E731
    table = "\n".join(evaluate.compare(load("base"), load("cand")))
    assert "| rubricScore | 0.000 | 1.000 | better |" in table
    assert "| citationPrecisionAfter | 0.500 | 1.000 | better |" in table
    assert "| coverageShare | 0.333 | 0.333 |  |" in table


def test_mcp_body_parsing_handles_json_and_sse():
    body = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\n\n'
    assert client.parse_rpc_body(body, "text/event-stream", 3)["result"] == {"ok": 1}
    assert client.parse_rpc_body('{"jsonrpc":"2.0","id":4,"error":{"code":-1,"message":"x"}}', "application/json", 4)["error"]
    assert client.parse_rpc_body("garbage", "application/json", 1) is None
    assert re.match(r"^p-\d{8}-[0-9a-f]{8}$", client.new_project_id())
