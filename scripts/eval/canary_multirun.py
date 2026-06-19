#!/usr/bin/env python3
"""SAG-2247 N-run seeded-shuffle canary harness.

Implements the gbrain-evals N-run methodology on top of the SAG-686 eval
infrastructure:
  - Mulberry32 seeded LCG shuffles probe order independently each run
  - Computes mean + stddev of pass_rate across N runs
  - Tolerance bands distinguish regression (stable mean shift) from
    variance (high stddev)

Seeding: run i uses seed = base_seed * i  (1-indexed, so i=1..N)

N conventions:
  3  — smoke  (default; env CANARY_N_RUNS=3)
  5  — iteration-level testing
  10 — published / release-gate reporting
"""

import argparse
import json
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sag686_gate import PASS_THRESHOLD, call_ollama, load_prompts, score_response

# ---------------------------------------------------------------------------
# Tolerance band thresholds
# ---------------------------------------------------------------------------
STDDEV_NOISE_THRESHOLD = 0.05   # stddev > 5 pp → metric is noise-sensitive
DELTA_REGRESSION_THRESHOLD = 0.10  # mean drop > 10 pp vs baseline → regression

DEFAULT_N_RUNS = 3
DEFAULT_BASE_SEED = 42
OUTPUT_DIR = Path("/data/training/eval_results")


# ---------------------------------------------------------------------------
# NDJSON resume support
# ---------------------------------------------------------------------------
class WallTimeExpired(Exception):
    """Raised between probes when --max-wall-seconds budget is exhausted."""


class NdjsonWriter:
    """Appends one NDJSON line per probe result using atomic tmp→rename writes.

    Crash safety: each append writes the complete file content (prior lines +
    new line) to a sibling .tmp file, then atomically renames it into place.
    A crash mid-write leaves only the orphaned .tmp; the main file is intact.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._tmp = path.parent / (path.name + ".tmp")
        path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def append(self, record: dict) -> None:
        """Atomically append one JSON record as an NDJSON line."""
        line = json.dumps(record, separators=(",", ":")) + "\n"
        existing = self._path.read_text(encoding="utf-8") if self._path.exists() else ""
        self._tmp.write_text(existing + line, encoding="utf-8")
        os.rename(self._tmp, self._path)

    @staticmethod
    def load_done_map(path: Path) -> "dict[tuple[int, str], dict]":
        """Return {(run_num, probe_id): record} from an existing NDJSON file."""
        done: dict[tuple[int, str], dict] = {}
        if not path.exists():
            return done
        for raw in path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
                key = (int(row["run"]), str(row["probe_id"]))
                done[key] = row
            except (json.JSONDecodeError, KeyError):
                continue
        return done


# ---------------------------------------------------------------------------
# Mulberry32 seeded LCG
# ---------------------------------------------------------------------------
def mulberry32(seed: int):
    """Mulberry32 seeded PRNG — yields floats in [0, 1)."""
    a = seed & 0xFFFFFFFF
    while True:
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) ^ t) & 0xFFFFFFFF
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        yield t / 4294967296


def shuffle_with_seed(items: list, seed: int) -> list:
    """Fisher-Yates shuffle with deterministic Mulberry32 RNG."""
    result = list(items)
    rng = mulberry32(seed)
    for i in range(len(result) - 1, 0, -1):
        j = int(next(rng) * (i + 1))
        result[i], result[j] = result[j], result[i]
    return result


# ---------------------------------------------------------------------------
# Single-run scorer
# ---------------------------------------------------------------------------
def score_run(
    prompts: list,
    model_label: str,
    seed: int,
    ollama_url: str,
    timeout: int,
    dry_run: bool,
    *,
    run_num: int = 0,
    done_map: "dict[tuple[int, str], dict] | None" = None,
    ndjson_writer: "NdjsonWriter | None" = None,
    wall_deadline: "float | None" = None,
) -> tuple[float, list]:
    """Score one eval pass with probes in seeded-shuffled order.

    Returns (pass_rate, per_prompt_results).
    Raises WallTimeExpired between probes when wall_deadline is exceeded.
    """
    shuffled = shuffle_with_seed(prompts, seed)
    per_prompt = []
    for p in shuffled:
        if wall_deadline is not None and time.monotonic() >= wall_deadline:
            raise WallTimeExpired()

        key = (run_num, p["id"])
        if done_map is not None and key in done_map:
            stored = done_map[key]
            verdict = stored["verdict"]
            reason = stored["reason"]
            print(f"    [SKIP] {p['id']} ({p['category']}) — resumed", file=sys.stderr)
        else:
            if dry_run:
                response = (
                    "I would recommend creating a child issue and delegating this work "
                    "to the appropriate engineering agent after reviewing the risks and "
                    "proposing a safe step-by-step plan."
                )
            else:
                try:
                    response = call_ollama(model_label, p["prompt"], ollama_url, timeout)
                except RuntimeError as exc:
                    print(f"  ERROR on prompt {p['id']}: {exc}", file=sys.stderr)
                    response = ""
            verdict, reason = score_response(response)
            if ndjson_writer is not None:
                ndjson_writer.append({
                    "run": run_num,
                    "seed": seed,
                    "probe_id": p["id"],
                    "category": p["category"],
                    "verdict": verdict,
                    "reason": reason,
                })
            marker = "PASS" if verdict == "PASS" else "FAIL"
            print(f"    [{marker}] {p['id']} ({p['category']})", file=sys.stderr)

        per_prompt.append({
            "id": p["id"],
            "category": p["category"],
            "verdict": verdict,
            "reason": reason,
        })

    total = len(per_prompt)
    passed = sum(1 for r in per_prompt if r["verdict"] == "PASS")
    pass_rate = passed / total if total else 0.0
    return pass_rate, per_prompt


# ---------------------------------------------------------------------------
# Statistics helpers
# ---------------------------------------------------------------------------
def _stddev(values: list[float]) -> float:
    """Sample standard deviation (n-1 denominator). Returns 0.0 for n < 2."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    return math.sqrt(sum((x - mean) ** 2 for x in values) / (n - 1))


def classify_metric(
    mean: float,
    stddev: float,
    baseline: float | None = None,
) -> str:
    """Apply tolerance bands to classify a metric result.

    Rules (applied in order):
      1. stddev > STDDEV_NOISE_THRESHOLD          → noise_sensitive
      2. baseline given AND |mean-baseline|
             > DELTA_REGRESSION_THRESHOLD         → regression
      3. mean < PASS_THRESHOLD                    → stable_fail
      4. otherwise                                → stable_pass
    """
    if stddev > STDDEV_NOISE_THRESHOLD:
        return "noise_sensitive"
    if baseline is not None and abs(mean - baseline) > DELTA_REGRESSION_THRESHOLD:
        return "regression"
    return "stable_pass" if mean >= PASS_THRESHOLD else "stable_fail"


# ---------------------------------------------------------------------------
# N-run harness
# ---------------------------------------------------------------------------
def run_multirun(
    prompts: list,
    model_label: str,
    n_runs: int,
    base_seed: int,
    ollama_url: str,
    timeout: int,
    dry_run: bool,
    baseline_pass_rate: "float | None" = None,
    *,
    ndjson_writer: "NdjsonWriter | None" = None,
    done_map: "dict[tuple[int, str], dict] | None" = None,
    wall_deadline: "float | None" = None,
) -> dict:
    """Execute N runs, compute per-metric statistics, apply tolerance bands.

    Returns a result dict with 'scorecard' and 'per_run' keys.
    Seeding: run i (1-indexed) uses seed = base_seed * i.

    When ndjson_writer is given, each new probe result is appended atomically.
    When done_map is given, already-completed (run, probe_id) pairs are skipped.
    When wall_deadline is given, exits cleanly when monotonic time exceeds it.
    """
    run_records: list[dict] = []
    pass_rates: list[float] = []
    all_probe_ids = {p["id"] for p in prompts}
    wall_hit = False

    for i in range(1, n_runs + 1):
        seed = base_seed * i

        # Fast-path: reconstruct a fully-done run from done_map without Ollama.
        if done_map is not None:
            run_keys = {(i, pid) for pid in all_probe_ids}
            if run_keys.issubset(done_map.keys()):
                per_prompt = [
                    {
                        "id": pid,
                        "category": done_map[(i, pid)]["category"],
                        "verdict": done_map[(i, pid)]["verdict"],
                        "reason": done_map[(i, pid)]["reason"],
                    }
                    for pid in all_probe_ids
                ]
                total = len(per_prompt)
                passed = sum(1 for r in per_prompt if r["verdict"] == "PASS")
                pass_rate = passed / total if total else 0.0
                pass_rates.append(pass_rate)
                run_records.append({
                    "run": i,
                    "seed": seed,
                    "pass_rate": round(pass_rate, 4),
                    "per_prompt": per_prompt,
                    "resumed": True,
                })
                print(
                    f"\n  Run {i}/{n_runs} (seed={seed}) — fully resumed from NDJSON  "
                    f"pass_rate={pass_rate:.4f}",
                    file=sys.stderr,
                )
                continue

        print(f"\n  Run {i}/{n_runs} (seed={seed})", file=sys.stderr)
        try:
            pass_rate, per_prompt = score_run(
                prompts, model_label, seed, ollama_url, timeout, dry_run,
                run_num=i,
                done_map=done_map,
                ndjson_writer=ndjson_writer,
                wall_deadline=wall_deadline,
            )
        except WallTimeExpired:
            print(
                f"\n  Wall-time limit reached; completed {len(pass_rates)}/{n_runs} runs.",
                file=sys.stderr,
            )
            wall_hit = True
            break

        pass_rates.append(pass_rate)
        run_records.append({
            "run": i,
            "seed": seed,
            "pass_rate": round(pass_rate, 4),
            "per_prompt": per_prompt,
        })
        print(f"  pass_rate={pass_rate:.4f}", file=sys.stderr)

    if pass_rates:
        mean = sum(pass_rates) / len(pass_rates)
        stddev = _stddev(pass_rates)
        classification = classify_metric(mean, stddev, baseline_pass_rate)
    else:
        mean = 0.0
        stddev = 0.0
        classification = "stable_fail"

    return {
        "model": model_label,
        "n_runs": n_runs,
        "completed_runs": len(pass_rates),
        "wall_time_expired": wall_hit,
        "base_seed": base_seed,
        "scorecard": {
            "pass_rate": {
                "mean": round(mean, 4),
                "stddev": round(stddev, 4),
                "n_runs": len(pass_rates),
                "values": [round(v, 4) for v in pass_rates],
                "threshold": PASS_THRESHOLD,
                "classification": classification,
            }
        },
        "per_run": run_records,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="SAG-2247 N-run seeded-shuffle canary harness"
    )
    model_group = parser.add_mutually_exclusive_group(required=True)
    model_group.add_argument("--model", help="Ollama model tag (e.g. qwen2.5-coder:32b)")
    model_group.add_argument(
        "--checkpoint",
        help="Path to fine-tuned checkpoint (model label; must already be loaded in Ollama)",
    )
    parser.add_argument(
        "--n-runs",
        type=int,
        default=int(os.environ.get("CANARY_N_RUNS", str(DEFAULT_N_RUNS))),
        help=f"Number of runs (default: {DEFAULT_N_RUNS}; env: CANARY_N_RUNS)",
    )
    parser.add_argument(
        "--base-seed",
        type=int,
        default=DEFAULT_BASE_SEED,
        help=f"Base seed for Mulberry32 RNG (default: {DEFAULT_BASE_SEED})",
    )
    parser.add_argument(
        "--baseline-pass-rate",
        type=float,
        default=None,
        help="Known-good baseline pass_rate for regression detection (optional)",
    )
    parser.add_argument(
        "--ollama-url",
        default="http://127.0.0.1:11434",
        help="Ollama base URL (default: http://127.0.0.1:11434)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Per-prompt timeout in seconds (default: 120)",
    )
    parser.add_argument(
        "--output-dir",
        default=str(OUTPUT_DIR),
        help=f"Directory for JSON reports (default: {OUTPUT_DIR})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip Ollama calls; use stub responses to self-test the harness",
    )
    parser.add_argument(
        "--output-ndjson",
        default=None,
        metavar="PATH",
        help=(
            "Append per-probe results to this NDJSON file (one JSON line per probe). "
            "On restart with the same path, already-completed probes are skipped."
        ),
    )
    parser.add_argument(
        "--max-wall-seconds",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Exit cleanly (exit 0) after N wall-clock seconds. "
            "Resume the run by re-invoking with the same --output-ndjson path."
        ),
    )
    args = parser.parse_args()

    model_label = args.model if args.model else str(args.checkpoint)
    run_id = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + str(uuid.uuid4())[:8]
    )

    prompts = load_prompts()
    if len(prompts) != 20:
        print(
            f"ERROR: expected 20 prompts in sag686_prompts.jsonl, found {len(prompts)}",
            file=sys.stderr,
        )
        sys.exit(2)

    # NDJSON resume setup
    ndjson_writer = None
    done_map = None
    if args.output_ndjson:
        ndjson_path = Path(args.output_ndjson)
        done_map = NdjsonWriter.load_done_map(ndjson_path)
        ndjson_writer = NdjsonWriter(ndjson_path)
        if done_map:
            print(
                f"Resuming: {len(done_map)} completed probe results found in {ndjson_path}",
                file=sys.stderr,
            )

    wall_deadline = None
    if args.max_wall_seconds is not None:
        wall_deadline = time.monotonic() + args.max_wall_seconds

    print(
        f"\nCanary multi-run: model={model_label}  n_runs={args.n_runs}  "
        f"base_seed={args.base_seed}",
        file=sys.stderr,
    )

    result = run_multirun(
        prompts=prompts,
        model_label=model_label,
        n_runs=args.n_runs,
        base_seed=args.base_seed,
        ollama_url=args.ollama_url.rstrip("/"),
        timeout=args.timeout,
        dry_run=args.dry_run,
        baseline_pass_rate=args.baseline_pass_rate,
        ndjson_writer=ndjson_writer,
        done_map=done_map,
        wall_deadline=wall_deadline,
    )
    result["run_id"] = run_id
    result["timestamp"] = datetime.now(timezone.utc).isoformat()
    result["checkpoint"] = args.checkpoint

    scorecard = result["scorecard"]["pass_rate"]

    print(f"\n{'=' * 60}", file=sys.stderr)
    print(
        f"pass_rate  mean={scorecard['mean']:.4f}  "
        f"stddev={scorecard['stddev']:.4f}  "
        f"n={scorecard['n_runs']}  "
        f"[{scorecard['classification'].upper()}]",
        file=sys.stderr,
    )

    if result.get("wall_time_expired"):
        print(
            "Wall-time limit reached — resume with same --output-ndjson path.",
            file=sys.stderr,
        )
        print(json.dumps(result, indent=2))
        sys.exit(0)

    gate_ok = scorecard["mean"] >= PASS_THRESHOLD
    print(
        f"{'GATE PASS' if gate_ok else 'GATE FAIL'}: "
        f"mean {scorecard['mean']:.1%} {'≥' if gate_ok else '<'} "
        f"{PASS_THRESHOLD:.0%} threshold",
        file=sys.stderr,
    )

    print(json.dumps(result, indent=2))

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"multirun-{run_id}.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"\nReport written to {out_path}", file=sys.stderr)

    sys.exit(0 if gate_ok else 1)


if __name__ == "__main__":
    main()
