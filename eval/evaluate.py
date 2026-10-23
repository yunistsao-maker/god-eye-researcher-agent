#!/usr/bin/env python3
"""God Eye evaluation: run the question set against a deployment, score it, compare two runs.

  python eval/evaluate.py run --label baseline [--only mfg-zh-01,fin-en-02] [--depth quick] [--parallel 2]
  python eval/evaluate.py score --label baseline [--judge bedrock|none]
  python eval/evaluate.py compare baseline candidate

run needs GOD_EYE_AGENTS_URL (agents gateway base, e.g. https://<cloudfront>), GOD_EYE_TOOLS_URL (tools
gateway MCP URL, e.g. https://<cloudfront>/mcp) and GOD_EYE_TOKEN (a Cognito access token of a test user;
it lasts one hour, so run a few questions at a time). Results go to eval/runs/<label>/ (git-ignored:
they contain quotes from third-party pages).

score computes deterministic metrics (metrics.py) and, with --judge bedrock, asks an LLM judge to grade
each report against its binary rubric (judge.py; JUDGE_MODEL_ID picks the model, AWS credentials as
usual). It writes scores.json, scores.csv and summary.md next to the runs.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import judge as judge_mod  # noqa: E402
from metrics import HIGHER_IS_BETTER, LOWER_IS_BETTER, mean, project_metrics  # noqa: E402

RUNS = HERE / "runs"
SUMMARY_KEYS = ["rubricScore", "coverageShare", "corroboratedShare", "citationPrecisionBefore", "citationPrecisionAfter",
                "citedSentenceShare", "primaryShare", "publishers", "claims", "deadUrls", "unknownCitations", "elapsedSec"]


def load_questions(path: Path = HERE / "questions.json", only: Optional[set[str]] = None) -> list[dict]:
    questions = json.loads(path.read_text(encoding="utf-8"))["questions"]
    return [q for q in questions if not only or q["id"] in only]


def brief_for(q: dict, depth: Optional[str]) -> dict:
    brief: dict[str, Any] = {"depth": depth or q.get("depth", "standard")}
    if q.get("audience"):
        brief["audience"] = q["audience"]
    if q.get("timeRange"):
        brief["notes"] = f"Time range: {q['timeRange']}"
    return brief


# ---------------------------------------------------------------------------------------------------
def cmd_run(args: argparse.Namespace) -> None:
    from client import McpClient, new_project_id, start_research, wait_for

    agents, tools, token = (os.environ.get(k, "") for k in ("GOD_EYE_AGENTS_URL", "GOD_EYE_TOOLS_URL", "GOD_EYE_TOKEN"))
    if not (agents and tools and token):
        sys.exit("Set GOD_EYE_AGENTS_URL, GOD_EYE_TOOLS_URL and GOD_EYE_TOKEN first.")
    out = RUNS / args.label
    out.mkdir(parents=True, exist_ok=True)
    questions = load_questions(only=set(args.only.split(",")) if args.only else None)
    meta_path = out / "run.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"label": args.label, "createdAt": _now(), "questions": []}
    meta["questions"] = sorted(set(meta["questions"]) | {q["id"] for q in questions})
    meta_path.write_text(json.dumps(meta, indent=1))

    def one(q: dict) -> str:
        target = out / f"{q['id']}.json"
        if target.exists() and not args.force:
            return f"{q['id']}: already run (use --force)"
        mcp = McpClient(tools, token)
        pid = new_project_id()
        started = time.time()
        start_research(agents, token, pid, q["question"], brief_for(q, args.depth))
        got = wait_for(mcp, pid, timeout_sec=args.timeout)
        record = {"question": q, "projectId": pid, "startedAt": _now(), "elapsedSec": round(time.time() - started, 1),
                  "status": (got.get("project") or {}).get("status", "timeout"), "projectGet": got}
        target.write_text(json.dumps(record, ensure_ascii=False, indent=1))
        return f"{q['id']}: {record['status']} in {record['elapsedSec']}s ({pid})"

    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
        for line in pool.map(one, questions):
            print(line)


# ---------------------------------------------------------------------------------------------------
def score_runs(run_dir: Path, call: Optional[Callable[[str, str], str]]) -> dict[str, dict]:
    scores: dict[str, dict] = {}
    for path in sorted(run_dir.glob("*.json")):
        if path.name in ("run.json", "scores.json"):
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        q, got = record["question"], record.get("projectGet") or {}
        metrics = project_metrics(got)
        metrics["elapsedSec"] = record.get("elapsedSec", metrics.get("elapsedSec"))
        entry: dict[str, Any] = {"id": q["id"], "lang": q["lang"], "domain": q["domain"], "depth": q.get("depth"),
                                 "status": record.get("status"), "metrics": metrics}
        if call is not None and (got.get("synthesis") or {}).get("report"):
            entry["judge"] = judge_mod.judge(q, got, call)
            metrics["rubricScore"] = entry["judge"]["rubricScore"]
        scores[q["id"]] = entry
    return scores


def summarize(scores: dict[str, dict]) -> dict[str, Any]:
    rows = list(scores.values())
    overall = {k: mean([r["metrics"].get(k) for r in rows]) for k in SUMMARY_KEYS}
    groups: dict[str, dict] = {}
    for key in ("lang", "domain", "depth"):
        for value in sorted({r[key] for r in rows if r.get(key)}):
            sub = [r for r in rows if r.get(key) == value]
            groups[f"{key}={value}"] = {"n": len(sub), "rubricScore": mean([r["metrics"].get("rubricScore") for r in sub]),
                                         "coverageShare": mean([r["metrics"].get("coverageShare") for r in sub])}
    completed = sum(1 for r in rows if r.get("status") == "completed")
    return {"questions": len(rows), "completed": completed, "overall": overall, "groups": groups}


def write_reports(run_dir: Path, scores: dict[str, dict]) -> dict[str, Any]:
    summary = summarize(scores)
    (run_dir / "scores.json").write_text(json.dumps({"summary": summary, "scores": scores}, ensure_ascii=False, indent=1))
    with (run_dir / "scores.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["id", "lang", "domain", "depth", "status"] + SUMMARY_KEYS)
        for r in scores.values():
            writer.writerow([r["id"], r["lang"], r["domain"], r["depth"], r["status"]] + [r["metrics"].get(k) for k in SUMMARY_KEYS])
    lines = [f"# Evaluation: {run_dir.name}", "", f"{summary['completed']} of {summary['questions']} questions completed.", "",
             "| metric | mean |", "| --- | --- |"]
    lines += [f"| {k} | {_fmt(v)} |" for k, v in summary["overall"].items()]
    lines += ["", "| group | n | rubricScore | coverageShare |", "| --- | --- | --- | --- |"]
    lines += [f"| {g} | {d['n']} | {_fmt(d['rubricScore'])} | {_fmt(d['coverageShare'])} |" for g, d in summary["groups"].items()]
    failing = [(r["id"], i["id"], i["reason"]) for r in scores.values() for i in (r.get("judge") or {}).get("items", []) if not i["pass"]]
    if failing:
        lines += ["", "## Failed rubric items", "", "| question | item | reason |", "| --- | --- | --- |"]
        lines += [f"| {q} | {i} | {reason.replace('|', '/')} |" for q, i, reason in failing]
    (run_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return summary


def cmd_score(args: argparse.Namespace) -> None:
    run_dir = RUNS / args.label
    if not run_dir.exists():
        sys.exit(f"No run named {args.label} in {RUNS}")
    call = judge_mod.bedrock_caller(args.judge_model) if args.judge == "bedrock" else None
    summary = write_reports(run_dir, score_runs(run_dir, call))
    print(json.dumps(summary["overall"], indent=1))
    print(f"wrote {run_dir / 'summary.md'}")


# ---------------------------------------------------------------------------------------------------
def compare(base: dict, cand: dict) -> list[str]:
    lines = ["| metric | base | candidate | change |", "| --- | --- | --- | --- |"]
    for k in SUMMARY_KEYS:
        a, b = base["summary"]["overall"].get(k), cand["summary"]["overall"].get(k)
        verdict = ""
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a != b:
            better = (b > a and k in HIGHER_IS_BETTER) or (b < a and k in LOWER_IS_BETTER)
            verdict = ("better" if better else "worse") if k in HIGHER_IS_BETTER | LOWER_IS_BETTER else ""
        lines.append(f"| {k} | {_fmt(a)} | {_fmt(b)} | {verdict} |")
    shared = sorted(set(base["scores"]) & set(cand["scores"]))
    lines += ["", "| question | base rubric | candidate rubric |", "| --- | --- | --- |"]
    for q in shared:
        lines.append(f"| {q} | {_fmt(base['scores'][q]['metrics'].get('rubricScore'))} | "
                     f"{_fmt(cand['scores'][q]['metrics'].get('rubricScore'))} |")
    return lines


def cmd_compare(args: argparse.Namespace) -> None:
    load = lambda name: json.loads((RUNS / name / "scores.json").read_text(encoding="utf-8"))  # noqa: E731
    print("\n".join(compare(load(args.base), load(args.candidate))))


def _fmt(v: Any) -> str:
    return "" if v is None else (f"{v:.3f}" if isinstance(v, float) else str(v))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="run questions against a deployment")
    run.add_argument("--label", required=True)
    run.add_argument("--only", help="comma-separated question ids")
    run.add_argument("--depth", choices=["quick", "standard", "deep"], help="override each question's depth")
    run.add_argument("--parallel", type=int, default=2)
    run.add_argument("--timeout", type=float, default=3600)
    run.add_argument("--force", action="store_true")
    run.set_defaults(fn=cmd_run)
    score = sub.add_parser("score", help="score a run")
    score.add_argument("--label", required=True)
    score.add_argument("--judge", choices=["bedrock", "none"], default="bedrock")
    score.add_argument("--judge-model", default=judge_mod.JUDGE_MODEL_ID)
    score.set_defaults(fn=cmd_score)
    cmp_ = sub.add_parser("compare", help="compare two scored runs")
    cmp_.add_argument("base")
    cmp_.add_argument("candidate")
    cmp_.set_defaults(fn=cmd_compare)
    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
