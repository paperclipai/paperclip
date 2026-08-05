"""
run_eval.py — reference

Nightly local-AI regression scoring runner.

Drives each gold-set class through the on-box Ollama model (gemma4:26b-a4b)
SERIALLY (one row at a time, one model, respects OLLAMA_MAX_LOADED_MODELS=1).
Emits per-agent JSON results with three scores per class:
  (a) task_correct    — schema-valid / task-correct rate
  (b) tool_call_correct — tool-call correctness rate (null when N/A)
  (c) clean           — contamination-clean rate (via clean_parser)

Results written to: infra/runtime-eval/results/<UTC-stamp>.json

Usage:
  cd <workspace_root>/infra/runtime-eval
  python3 run_eval.py [--classes enrichment_sku,code_review] [--model NAME] [--dry-run]

Environment variables:
  OLLAMA_URL          Ollama endpoint (required)
  EVAL_MODEL          override model (default gemma4:26b-a4b-it-q4_K_M)
  EVAL_TIMEOUT_S      per-row timeout seconds (default 300)
"""
from __future__ import annotations

import json
import logging
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HERE = Path(__file__).parent
GOLD_DIR = str(HERE / "gold")
RESULTS_DIR = HERE / "results"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
OLLAMA_URL = os.environ.get("OLLAMA_URL", "")
DEFAULT_MODEL = os.environ.get("EVAL_MODEL", "gemma4:26b-a4b-it-q4_K_M")
EVAL_TIMEOUT = float(os.environ.get("EVAL_TIMEOUT_S", "300"))

ALL_CLASSES = [
    "enrichment_sku",
    "doc_extraction",
    "pricing",
    "code_review",
    "qa_unit_tests",
    "paralegal",
]

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Import clean_parser (sibling module)
# ---------------------------------------------------------------------------
sys.path.insert(0, str(HERE))
from clean_parser import score as _clean_score  # noqa: E402


# ---------------------------------------------------------------------------
# Gold-set loader
# ---------------------------------------------------------------------------

def load_gold_set(class_name: str) -> list[dict]:
    path = Path(GOLD_DIR) / f"{class_name}.jsonl"
    if not path.exists():
        raise FileNotFoundError(f"Gold set not found: {path}")
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


# ---------------------------------------------------------------------------
# Scoring functions (pure — no I/O, tested in test_run_eval.py)
# ---------------------------------------------------------------------------

def score_json_values(output_text: str, expected: dict) -> float:
    """Parse output as JSON; return 1.0 if all expected key=value pairs match."""
    try:
        parsed = json.loads(output_text.strip())
    except (json.JSONDecodeError, ValueError, AttributeError):
        return 0.0
    if not isinstance(parsed, dict):
        return 0.0
    for key, val in expected.items():
        if parsed.get(key) != val:
            return 0.0
    return 1.0


def score_json_list_min(output_text: str, expected: dict) -> float:
    """Parse output as JSON; return 1.0 if output[key] is a list with >= min items."""
    try:
        parsed = json.loads(output_text.strip())
    except (json.JSONDecodeError, ValueError, AttributeError):
        return 0.0
    if not isinstance(parsed, dict):
        return 0.0
    key = expected.get("key", "")
    min_count = expected.get("min", 1)
    value = parsed.get(key)
    if not isinstance(value, list):
        return 0.0
    return 1.0 if len(value) >= min_count else 0.0


def score_tool_call(tool_calls: list | None, expected: dict) -> float:
    """Return 1.0 if first tool_call matches expected function name + required args."""
    if not tool_calls:
        return 0.0
    tc = tool_calls[0]
    fn = tc.get("function", {})
    if fn.get("name") != expected.get("function"):
        return 0.0
    args = fn.get("arguments", {}) or {}
    for arg in expected.get("required_args", []):
        if arg not in args:
            return 0.0
    return 1.0


def score_row(row: dict, output_text: str, tool_calls: list | None) -> dict:
    """Score a single row against its gold expected, returning a scores dict."""
    check_type = row.get("check_type", "json_values")
    expected = row.get("expected", {})

    # (a) task_correct
    if check_type == "json_values":
        task_correct = score_json_values(output_text, expected)
    elif check_type == "json_list_min":
        task_correct = score_json_list_min(output_text, expected)
    elif check_type == "tool_call":
        task_correct = score_tool_call(tool_calls, expected)
    else:
        task_correct = 0.0

    # (b) tool_call_correct — only for explicit tool_call tasks
    tool_call_correct: float | None = None
    if check_type == "tool_call":
        tool_call_correct = score_tool_call(tool_calls, expected)
    elif row.get("tool_def"):
        tool_call_correct = score_tool_call(tool_calls, expected)

    # (c) clean — contamination check on the raw content
    clean = _clean_score(output_text)

    return {
        "id": row.get("id"),
        "task_correct": task_correct,
        "tool_call_correct": tool_call_correct,
        "clean": clean,
    }


# ---------------------------------------------------------------------------
# Ollama call (serialized — one request at a time)
# ---------------------------------------------------------------------------

def _ollama_call(
    model: str,
    system: str,
    user: str,
    tools: list | None = None,
    timeout: float = EVAL_TIMEOUT,
) -> dict:
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": user})

    body: dict = {
        "model": model,
        "messages": msgs,
        "stream": False,
        "think": False,
        "keep_alive": "10m",
        "options": {"temperature": 0, "num_predict": 2048},
    }
    if model.startswith("gemma4") or "gemma" in model.lower():
        body["format"] = "json"

    if tools:
        body["tools"] = tools

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    data["_wall_s"] = round(time.time() - t0, 2)
    return data


# ---------------------------------------------------------------------------
# Wilson CI helper
# ---------------------------------------------------------------------------

def _wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    denom = 1 + z ** 2 / n
    centre = (p + z ** 2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2)) / denom
    return round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)


# ---------------------------------------------------------------------------
# Main eval loop
# ---------------------------------------------------------------------------

def eval_class(class_name: str, model: str = DEFAULT_MODEL, dry_run: bool = False) -> dict:
    rows = load_gold_set(class_name)
    log.info("[%s] %d rows, model=%s", class_name, len(rows), model)

    per_row: list[dict] = []
    for i, row in enumerate(rows):
        log.info("[%s] row %d/%d id=%s", class_name, i + 1, len(rows), row["id"])
        if dry_run:
            result = {
                "id": row["id"],
                "task_correct": 1.0,
                "tool_call_correct": None,
                "clean": 1.0,
                "wall_s": 0.0,
                "error": None,
            }
            per_row.append(result)
            continue

        try:
            resp = _ollama_call(
                model=model,
                system=row.get("system", ""),
                user=row.get("input", ""),
                tools=row.get("tool_def"),
            )
            msg = resp.get("message", {})
            content = msg.get("content", "") or ""
            tool_calls = msg.get("tool_calls") or []
            scores = score_row(row, content, tool_calls)
            scores["wall_s"] = resp.get("_wall_s", 0.0)
            scores["error"] = None
        except Exception as exc:
            log.warning("[%s] row %s error: %s", class_name, row["id"], exc)
            scores = {
                "id": row["id"],
                "task_correct": 0.0,
                "tool_call_correct": None,
                "clean": 0.0,
                "wall_s": 0.0,
                "error": str(exc),
            }
        per_row.append(scores)

    n = len(per_row)
    n_correct = sum(1 for r in per_row if r["task_correct"] == 1.0)
    n_clean = sum(1 for r in per_row if r["clean"] == 1.0)
    tc_rows = [r for r in per_row if r.get("tool_call_correct") is not None]

    ci_lo, ci_hi = _wilson_ci(n_correct, n)
    clean_lo, clean_hi = _wilson_ci(n_clean, n)

    summary = {
        "class": class_name,
        "model": model,
        "n": n,
        "task_correct_rate": round(n_correct / n, 4) if n else 0.0,
        "task_correct_ci_95": [ci_lo, ci_hi],
        "tool_call_correct_rate": (
            round(sum(r["tool_call_correct"] for r in tc_rows) / len(tc_rows), 4)
            if tc_rows else None
        ),
        "clean_rate": round(n_clean / n, 4) if n else 0.0,
        "clean_ci_95": [clean_lo, clean_hi],
        "errors": sum(1 for r in per_row if r.get("error")),
        "per_row": per_row,
    }
    log.info(
        "[%s] done: task_correct=%.1f%% clean=%.1f%% errors=%d",
        class_name,
        summary["task_correct_rate"] * 100,
        summary["clean_rate"] * 100,
        summary["errors"],
    )
    return summary


def run_eval(
    classes: list[str] | None = None,
    model: str = DEFAULT_MODEL,
    dry_run: bool = False,
) -> dict:
    if classes is None:
        classes = ALL_CLASSES

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = RESULTS_DIR / f"{ts}.json"

    results: dict = {
        "run_ts": ts,
        "model": model,
        "dry_run": dry_run,
        "classes": {},
    }

    for cls in classes:
        summary = eval_class(cls, model=model, dry_run=dry_run)
        results["classes"][cls] = summary

    out_path.write_text(json.dumps(results, indent=2))
    log.info("Results written to %s", out_path)
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str]) -> dict:
    args: dict = {"classes": None, "model": DEFAULT_MODEL, "dry_run": False}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--classes" and i + 1 < len(argv):
            args["classes"] = [c.strip() for c in argv[i + 1].split(",")]
            i += 2
        elif arg == "--model" and i + 1 < len(argv):
            args["model"] = argv[i + 1]
            i += 2
        elif arg == "--dry-run":
            args["dry_run"] = True
            i += 1
        else:
            i += 1
    return args


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    args = _parse_args(sys.argv[1:])
    results = run_eval(**args)

    print("\n=== EVAL SUMMARY ===")
    for cls, summary in results["classes"].items():
        tc = summary["task_correct_rate"]
        cl = summary["clean_rate"]
        ci = summary["task_correct_ci_95"]
        tool = summary.get("tool_call_correct_rate")
        tool_str = f"  tool_call={tool:.1%}" if tool is not None else ""
        print(
            f"  {cls}: task_correct={tc:.1%} CI95[{ci[0]:.2f},{ci[1]:.2f}]"
            f"  clean={cl:.1%}{tool_str}  errors={summary['errors']}/{summary['n']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
