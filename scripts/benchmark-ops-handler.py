#!/usr/bin/env python3
"""Deterministic TSBC report/aggregation/package executor (zero LLM tokens).

Only completed benchmark evidence may reach this handler. Model-cell execution
stays with its explicitly approved model runners; this handler never invokes a
model CLI or starts a benchmark sweep.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


OP = re.compile(r"\bbenchmark-op\s*:\s*(report|aggregate|package)\b", re.I)
RUN = re.compile(r"(?im)^benchmark-run-id\s*:\s*([A-Za-z0-9._-]+)\s*$")


def log(message: str) -> None:
    print(f"[benchmark-ops] {message}", file=sys.stderr)


def api(method: str, path: str, body: dict | None = None):
    base, key = os.environ.get("PAPERCLIP_API_URL"), os.environ.get("PAPERCLIP_API_KEY")
    if not base or not key:
        raise SystemExit("missing Paperclip run credentials")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if run_id := os.environ.get("PAPERCLIP_RUN_ID"):
        headers["X-Paperclip-Run-Id"] = run_id
    request = Request(base.rstrip("/") + path, method=method, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except (HTTPError, URLError) as error:
        raise SystemExit(f"Paperclip API {method} {path} failed: {error}") from error


def comment(issue_id: str, body: str, status: str | None = None) -> None:
    if status:
        api("PATCH", f"/api/issues/{issue_id}", {"status": status, "comment": body})
    else:
        api("POST", f"/api/issues/{issue_id}/comments", {"body": body})


def main() -> int:
    issue_id = os.environ.get("PAPERCLIP_TASK_ID")
    if not issue_id:
        log("no task id; safe no-op")
        return 0
    issue = api("GET", f"/api/issues/{issue_id}") or {}
    issue = issue.get("issue", issue) if isinstance(issue, dict) else {}
    text = f"{issue.get('title') or ''}\n{issue.get('description') or ''}"
    operation = OP.search(text)
    run = RUN.search(text)
    if not operation or not run:
        # A card without a directive can never be completed by this handler. It
        # must leave in_progress, or the platform re-offers it as
        # issue_continuation_needed and every run posts another comment
        # (measured: 1,680 runs/hr and 5,989 comments on one card, 2026-08-22).
        comment(issue_id, "## BenchmarkOps — blocked: no directive\n\n"
                "Requires `benchmark-op: report|aggregate|package` and a safe "
                "`benchmark-run-id: <run-id>` directive. No model was invoked. "
                "Add the directive to the card and return it to todo.", "blocked")
        return 0
    run_id = run.group(1)
    root = Path(__file__).resolve().parent.parent
    benchmark = root / "benchmark"
    commands = [["python3", "bench.py", "report", run_id]]
    if operation.group(1).lower() in {"aggregate", "package"}:
        commands.append(["python3", "costreport.py", str(benchmark / "results" / run_id)])
    output: list[str] = []
    for command in commands:
        log("running " + " ".join(command))
        result = subprocess.run(command, cwd=benchmark, capture_output=True, text=True, timeout=300)
        output.append(f"$ {' '.join(command)}\n{result.stdout}\n{result.stderr}")
        if result.returncode:
            comment(issue_id, "## BenchmarkOps — blocked\n\n"
                    "The deterministic report command failed; no benchmark model was invoked.\n\n"
                    f"```\n{output[-1][-3000:]}\n```", "blocked")
            return result.returncode
    report_path = benchmark / "results" / run_id / "paperclip-deterministic-report.txt"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n\n".join(output))
    comment(issue_id, "## BenchmarkOps — complete (0 LLM tokens)\n\n"
            f"- operation: `{operation.group(1).lower()}`\n"
            f"- benchmark run: `{run_id}`\n"
            f"- report: `{report_path}`\n"
            "- model cells were not run; this only re-rendered existing evidence.", "done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
