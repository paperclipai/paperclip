#!/usr/bin/env python3
"""Scan CPS experiments for missing JUDGMENT.json sidecars (report-only).

This is a local/offline maintenance tool, a companion to
``export-cps-judgment-dataset.py``:

- reads CPS self-practice artifacts and the experiment index from disk
- reports which experiments still lack a ``JUDGMENT.json`` sidecar
- prioritizes the missing ones by locally available evidence, so a governed
  ``generate_judgment`` run request can be scheduled against the richest,
  most decision-ready cases first
- never calls a model, broker, paid data, or any network API
- never writes, modifies, or invents a ``JUDGMENT.json``, rule, verdict, or
  result

The scanner only *reports*. Producing an actual ``JUDGMENT.json`` is a
separate governed action (a ``generate_judgment`` run request) that requires
evidence review; nothing here performs or fakes that step.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_SELF_PRACTICE_DIR = Path("/root/cps/var/self_practice")
REPORT_SCHEMA = "cps.missing_judgments_report.v1"
JUDGMENT_FILENAME = "JUDGMENT.json"

# Paths under the self-practice root that are not experiments in their own
# right. Matched against a directory's own name (not the full path).
EXCLUDED_DIR_NAMES = {
    "paperclip-run-requests",
    "paperclip-judgment-labels",
    "__pycache__",
    "__PLACEHOLDER__",
}
EXCLUDED_DIR_PREFIXES = ("experiment-tracker-",)

# Priority buckets. Score is a transparent, purely additive heuristic over
# locally discovered evidence -- it ranks *review order*, it does not judge:
#   +3  a primary / metrics JSON is present on disk
#   +2  a *SUMMARY*.md is present on disk
#   +2  the index recorded a non-null decision for the experiment
#   +1  a *trades*.csv is present on disk
# Buckets: ready_now (>= 5), needs_evidence_review (2-4), insufficient (<= 1).
SCORE_PRIMARY_JSON = 3
SCORE_SUMMARY_MD = 2
SCORE_INDEX_DECISION = 2
SCORE_TRADES_CSV = 1

BUCKET_READY = "ready_now"
BUCKET_REVIEW = "needs_evidence_review"
BUCKET_INSUFFICIENT = "insufficient_artifacts"
BUCKET_ORDER = {BUCKET_READY: 0, BUCKET_REVIEW: 1, BUCKET_INSUFFICIENT: 2}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def scalar(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def latest_index(root: Path) -> Path | None:
    candidates = sorted(root.glob("experiment-tracker-*/EXPERIMENTS_INDEX.json"), reverse=True)
    return candidates[0] if candidates else None


def is_excluded_dir(name: str) -> bool:
    if name.startswith("."):
        return True
    if name in EXCLUDED_DIR_NAMES:
        return True
    return any(name.startswith(prefix) for prefix in EXCLUDED_DIR_PREFIXES)


@dataclass(frozen=True)
class IndexEntry:
    experiment_id: str
    path: Path
    primary_json: str | None
    decision: str | None
    kind: str | None
    status: str | None
    updated_utc: str | None


def index_entries(root: Path, index_file: Path | None) -> dict[str, IndexEntry]:
    if index_file is None or not index_file.exists():
        return {}
    raw = read_json(index_file)
    if not isinstance(raw, dict):
        return {}
    out: dict[str, IndexEntry] = {}
    for item in raw.get("entries", []):
        if not isinstance(item, dict):
            continue
        experiment_id = scalar(item.get("id"))
        if not experiment_id or is_excluded_dir(experiment_id):
            continue
        raw_path = (
            scalar(item.get("absolute_path"))
            or scalar(item.get("absolutePath"))
            or scalar(item.get("path"))
            or experiment_id
        )
        path = Path(raw_path)
        if not path.is_absolute():
            path = root / path
        out[experiment_id] = IndexEntry(
            experiment_id=experiment_id,
            path=path,
            primary_json=scalar(item.get("primary_json")) or scalar(item.get("primaryJson")),
            decision=scalar(item.get("decision")),
            kind=scalar(item.get("kind")),
            status=scalar(item.get("status")),
            updated_utc=scalar(item.get("updated_utc")) or scalar(item.get("updatedUtc")),
        )
    return out


def discover_dirs(root: Path) -> dict[str, Path]:
    """Direct child directories of the root that hold at least one top-level file."""
    out: dict[str, Path] = {}
    if not root.is_dir():
        return out
    for child in sorted(root.iterdir()):
        if not child.is_dir() or is_excluded_dir(child.name):
            continue
        try:
            has_file = any(entry.is_file() for entry in child.iterdir())
        except OSError:
            has_file = False
        if has_file:
            out[child.name] = child
    return out


def top_level_files(path: Path) -> list[str]:
    if not path.is_dir():
        return []
    try:
        return sorted(entry.name for entry in path.iterdir() if entry.is_file())
    except OSError:
        return []


def looks_like_metrics_json(name: str) -> bool:
    lowered = name.lower()
    if not lowered.endswith(".json"):
        return False
    return any(token in lowered for token in ("metric", "result", "report"))


def find_primary_json(files: list[str], index_primary: str | None) -> str | None:
    if index_primary:
        base = Path(index_primary).name
        if base in files:
            return base
    candidates = [name for name in files if looks_like_metrics_json(name)]
    return candidates[0] if candidates else None


def find_summary_md(files: list[str]) -> str | None:
    candidates = [name for name in files if name.lower().endswith(".md") and "summary" in name.lower()]
    return candidates[0] if candidates else None


def find_trades_csv(files: list[str]) -> str | None:
    candidates = [name for name in files if name.lower().endswith(".csv") and "trades" in name.lower()]
    return candidates[0] if candidates else None


def bucket_for_score(score: int) -> str:
    if score >= 5:
        return BUCKET_READY
    if score >= 2:
        return BUCKET_REVIEW
    return BUCKET_INSUFFICIENT


@dataclass
class MissingRecord:
    experiment_id: str
    indexed: bool
    kind: str | None
    status: str | None
    decision: str | None
    updated_utc: str | None
    path: str
    file_count: int
    primary_json: str | None
    summary_md: str | None
    trades_csv: str | None
    score: int = 0
    bucket: str = BUCKET_INSUFFICIENT
    score_breakdown: dict[str, int] = field(default_factory=dict)

    @property
    def evidence_refs(self) -> dict[str, str | None]:
        return {
            "summary_md": self.summary_md,
            "primary_json": self.primary_json,
            "trades_csv": self.trades_csv,
        }

    def as_dict(self) -> dict[str, Any]:
        return {
            "experiment_id": self.experiment_id,
            "indexed": self.indexed,
            "kind": self.kind,
            "status": self.status,
            "decision": self.decision,
            "updated_utc": self.updated_utc,
            "path": self.path,
            "file_count": self.file_count,
            "score": self.score,
            "score_breakdown": self.score_breakdown,
            "bucket": self.bucket,
            "evidence_refs": self.evidence_refs,
        }


def build_missing_record(experiment_id: str, path: Path, entry: IndexEntry | None, indexed: bool) -> MissingRecord:
    files = top_level_files(path)
    primary_json = find_primary_json(files, entry.primary_json if entry else None)
    summary_md = find_summary_md(files)
    trades_csv = find_trades_csv(files)
    decision = entry.decision if entry else None

    breakdown: dict[str, int] = {}
    if primary_json:
        breakdown["primary_json"] = SCORE_PRIMARY_JSON
    if summary_md:
        breakdown["summary_md"] = SCORE_SUMMARY_MD
    if decision:
        breakdown["index_decision"] = SCORE_INDEX_DECISION
    if trades_csv:
        breakdown["trades_csv"] = SCORE_TRADES_CSV
    score = sum(breakdown.values())

    return MissingRecord(
        experiment_id=experiment_id,
        indexed=indexed,
        kind=entry.kind if entry else None,
        status=entry.status if entry else None,
        decision=decision,
        updated_utc=entry.updated_utc if entry else None,
        path=str(path),
        file_count=len(files),
        primary_json=primary_json,
        summary_md=summary_md,
        trades_csv=trades_csv,
        score=score,
        bucket=bucket_for_score(score),
        score_breakdown=breakdown,
    )


@dataclass
class ScanResult:
    total_experiments: int
    with_judgment: int
    missing: list[MissingRecord]
    unindexed_total: int

    @property
    def bucket_counts(self) -> dict[str, int]:
        counts = {BUCKET_READY: 0, BUCKET_REVIEW: 0, BUCKET_INSUFFICIENT: 0}
        for record in self.missing:
            counts[record.bucket] += 1
        return counts

    @property
    def missing_unindexed(self) -> int:
        return sum(1 for record in self.missing if not record.indexed)


def scan(root: Path, index_file: Path | None) -> ScanResult:
    entries = index_entries(root, index_file)
    dirs = discover_dirs(root)

    all_ids = set(entries) | set(dirs)
    unindexed_total = 0
    with_judgment = 0
    missing: list[MissingRecord] = []

    for experiment_id in all_ids:
        entry = entries.get(experiment_id)
        indexed = experiment_id in entries
        if not indexed:
            unindexed_total += 1
        path = entry.path if entry else dirs.get(experiment_id, root / experiment_id)
        # Fresh truth: check disk, not the (possibly stale) index files list.
        if (path / JUDGMENT_FILENAME).exists():
            with_judgment += 1
            continue
        missing.append(build_missing_record(experiment_id, path, entry, indexed))

    # Stable multi-key sort: bucket asc, score desc, updated_utc desc.
    missing.sort(key=lambda r: (r.updated_utc or ""), reverse=True)
    missing.sort(key=lambda r: (BUCKET_ORDER[r.bucket], -r.score))

    return ScanResult(
        total_experiments=len(all_ids),
        with_judgment=with_judgment,
        missing=missing,
        unindexed_total=unindexed_total,
    )


def _md_cell(value: Any) -> str:
    if value is None:
        return "null"
    return str(value)


def _evidence_cell(record: MissingRecord) -> str:
    return json.dumps(record.evidence_refs, sort_keys=True, separators=(", ", ": "))


def render_markdown(result: ScanResult, root: Path, index_file: Path | None) -> str:
    bucket_counts = result.bucket_counts
    lines: list[str] = []
    lines.append("# Missing CPS Judgments Report")
    lines.append("")
    lines.append(f"- generated_utc: `{utc_now()}`")
    lines.append(f"- self_practice_dir: `{root}`")
    lines.append(f"- index_file: `{index_file if index_file else 'none'}`")
    lines.append(f"- total_experiments: {result.total_experiments}")
    lines.append(f"- with_judgment: {result.with_judgment}")
    lines.append(f"- missing_judgment: {len(result.missing)}")
    lines.append(f"- ready_now: {bucket_counts[BUCKET_READY]}")
    lines.append(f"- needs_evidence_review: {bucket_counts[BUCKET_REVIEW]}")
    lines.append(f"- insufficient_artifacts: {bucket_counts[BUCKET_INSUFFICIENT]}")
    lines.append(f"- unindexed_experiments (total): {result.unindexed_total}")
    lines.append(f"- unindexed_experiments (among missing): {result.missing_unindexed}")
    lines.append("")
    lines.append(
        "> This report never invents rules or results. JUDGMENT.json generation "
        "is a separate governed action (`generate_judgment` run request) and "
        "requires evidence review."
    )
    lines.append("")
    lines.append(
        "Priority score (review-order heuristic only, not a verdict): "
        f"primary/metrics JSON +{SCORE_PRIMARY_JSON}, summary md +{SCORE_SUMMARY_MD}, "
        f"index decision non-null +{SCORE_INDEX_DECISION}, trades csv +{SCORE_TRADES_CSV}. "
        "Buckets: ready_now (>= 5), needs_evidence_review (2-4), "
        "insufficient_artifacts (<= 1)."
    )
    lines.append("")

    bucket_titles = [
        (BUCKET_READY, "ready_now"),
        (BUCKET_REVIEW, "needs_evidence_review"),
        (BUCKET_INSUFFICIENT, "insufficient_artifacts"),
    ]
    header = (
        "| rank | experiment_id | score | decision | primary_json | summary_md "
        "| trades_csv | file_count | updated_utc | evidence_refs |"
    )
    divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"

    for bucket, title in bucket_titles:
        records = [r for r in result.missing if r.bucket == bucket]
        lines.append(f"## {title} ({len(records)})")
        lines.append("")
        if not records:
            lines.append("_none_")
            lines.append("")
            continue
        lines.append(header)
        lines.append(divider)
        for rank, record in enumerate(records, start=1):
            lines.append(
                "| "
                + " | ".join(
                    [
                        str(rank),
                        _md_cell(record.experiment_id),
                        str(record.score),
                        _md_cell(record.decision),
                        _md_cell(record.primary_json),
                        _md_cell(record.summary_md),
                        _md_cell(record.trades_csv),
                        str(record.file_count),
                        _md_cell(record.updated_utc),
                        _evidence_cell(record),
                    ]
                )
                + " |"
            )
        lines.append("")

    return "\n".join(lines) + "\n"


def build_report_json(result: ScanResult, root: Path, index_file: Path | None) -> dict[str, Any]:
    bucket_counts = result.bucket_counts
    return {
        "schema": REPORT_SCHEMA,
        "generated_utc": utc_now(),
        "self_practice_dir": str(root),
        "index_file": str(index_file) if index_file else None,
        "counts": {
            "total_experiments": result.total_experiments,
            "with_judgment": result.with_judgment,
            "missing_judgment": len(result.missing),
            "ready_now": bucket_counts[BUCKET_READY],
            "needs_evidence_review": bucket_counts[BUCKET_REVIEW],
            "insufficient_artifacts": bucket_counts[BUCKET_INSUFFICIENT],
            "unindexed_total": result.unindexed_total,
            "unindexed_among_missing": result.missing_unindexed,
        },
        "scoring": {
            "primary_json": SCORE_PRIMARY_JSON,
            "summary_md": SCORE_SUMMARY_MD,
            "index_decision": SCORE_INDEX_DECISION,
            "trades_csv": SCORE_TRADES_CSV,
            "buckets": {
                BUCKET_READY: ">= 5",
                BUCKET_REVIEW: "2-4",
                BUCKET_INSUFFICIENT: "<= 1",
            },
        },
        "missing": [record.as_dict() for record in result.missing],
        "safety": {
            "network": False,
            "paid_actions": False,
            "model_calls": False,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-practice-dir", type=Path, default=DEFAULT_SELF_PRACTICE_DIR)
    parser.add_argument("--index-file", type=Path, default=None)
    parser.add_argument("--out-md", type=Path, default=None)
    parser.add_argument("--out-json", type=Path, default=None)
    args = parser.parse_args()

    root = args.self_practice_dir
    index_file = args.index_file or latest_index(root)
    out_md = args.out_md or (root / "MISSING_JUDGMENTS.md")
    out_json = args.out_json or (root / "MISSING_JUDGMENTS.json")

    result = scan(root, index_file)

    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render_markdown(result, root, index_file), encoding="utf-8")

    report = build_report_json(result, root, index_file)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    bucket_counts = result.bucket_counts
    print(json.dumps({
        "status": "ok",
        "self_practice_dir": str(root),
        "index_file": str(index_file) if index_file else None,
        "out_md": str(out_md),
        "out_json": str(out_json),
        "counts": {
            "total_experiments": result.total_experiments,
            "with_judgment": result.with_judgment,
            "missing_judgment": len(result.missing),
            "ready_now": bucket_counts[BUCKET_READY],
            "needs_evidence_review": bucket_counts[BUCKET_REVIEW],
            "insufficient_artifacts": bucket_counts[BUCKET_INSUFFICIENT],
            "unindexed_total": result.unindexed_total,
            "unindexed_among_missing": result.missing_unindexed,
        },
        "network": False,
        "paid_actions": False,
        "model_calls": False,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
