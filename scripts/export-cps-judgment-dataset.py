#!/usr/bin/env python3
"""Export CPS experiment judgments into training/eval JSONL datasets.

This is intentionally local/offline:
- reads CPS self-practice artifacts from disk
- reads optional Paperclip judgment feedback labels from JSONL
- writes append-only-ish regenerated dataset files
- never calls model, broker, paid data, or network APIs

The output is suitable for prompted-judge evaluation now and can later be
converted into Tinker/fine-tuning examples once enough accepted labels exist.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

DEFAULT_SELF_PRACTICE_DIR = Path("/root/cps/var/self_practice")
DEFAULT_EVAL_DIR = Path("/root/cps/var/evals")
JUDGMENT_SCHEMA = "cps.experiment_judgment.v1"
DATASET_SCHEMA = "cps.experiment_judgment_dataset.v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
            count += 1
    return count


def scalar(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def nested_status(value: Any) -> str | None:
    return scalar(value.get("status")) if isinstance(value, dict) else None


def latest_index(root: Path) -> Path | None:
    candidates = sorted(root.glob("experiment-tracker-*/EXPERIMENTS_INDEX.json"), reverse=True)
    return candidates[0] if candidates else None


@dataclass(frozen=True)
class ExperimentIndexEntry:
    experiment_id: str
    path: Path
    primary_json: str | None
    summary: dict[str, Any]
    decision: str | None
    kind: str | None
    updated_utc: str | None


def index_entries(root: Path, index_file: Path | None) -> dict[str, ExperimentIndexEntry]:
    if index_file is None or not index_file.exists():
        return {}
    raw = read_json(index_file)
    out: dict[str, ExperimentIndexEntry] = {}
    for item in raw.get("entries", []):
        if not isinstance(item, dict):
            continue
        experiment_id = scalar(item.get("id"))
        if not experiment_id:
            continue
        raw_path = scalar(item.get("absolute_path")) or scalar(item.get("absolutePath")) or scalar(item.get("path")) or experiment_id
        path = Path(raw_path)
        if not path.is_absolute():
            path = root / path
        raw_summary = item.get("summary")
        summary: dict[str, Any] = raw_summary if isinstance(raw_summary, dict) else {}
        out[experiment_id] = ExperimentIndexEntry(
            experiment_id=experiment_id,
            path=path,
            primary_json=scalar(item.get("primary_json")) or scalar(item.get("primaryJson")),
            summary=summary,
            decision=scalar(item.get("decision")),
            kind=scalar(item.get("kind")),
            updated_utc=scalar(item.get("updated_utc")) or scalar(item.get("updatedUtc")),
        )
    return out


def discover_judgments(root: Path, entries: dict[str, ExperimentIndexEntry]) -> list[tuple[str, Path, dict[str, Any]]]:
    found: dict[str, tuple[str, Path, dict[str, Any]]] = {}
    for experiment_id, entry in entries.items():
        judgment_path = entry.path / "JUDGMENT.json"
        if judgment_path.exists():
            judgment = read_json(judgment_path)
            if isinstance(judgment, dict):
                found[experiment_id] = (experiment_id, judgment_path, judgment)
    for judgment_path in sorted(root.glob("*/JUDGMENT.json")):
        judgment = read_json(judgment_path)
        if not isinstance(judgment, dict):
            continue
        experiment_id = scalar(judgment.get("experiment_id")) or scalar(judgment.get("experimentId")) or judgment_path.parent.name
        found.setdefault(experiment_id, (experiment_id, judgment_path, judgment))
    return sorted(found.values(), key=lambda row: row[0])


def read_feedback(root: Path) -> dict[str, list[dict[str, Any]]]:
    labels_file = root / "paperclip-judgment-labels" / "LABELS.jsonl"
    by_experiment: dict[str, list[dict[str, Any]]] = {}
    if not labels_file.exists():
        return by_experiment
    for line in labels_file.read_text().splitlines():
        if not line.strip():
            continue
        try:
            label = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(label, dict):
            continue
        experiment_id = scalar(label.get("experimentId")) or scalar(label.get("experiment_id"))
        if not experiment_id:
            continue
        by_experiment.setdefault(experiment_id, []).append(label)
    return by_experiment


def build_prompt(entry: ExperimentIndexEntry | None, judgment: dict[str, Any]) -> str:
    raw_source = judgment.get("source")
    source: dict[str, Any] = raw_source if isinstance(raw_source, dict) else {}
    fields = {
        "experiment_id": scalar(judgment.get("experiment_id")) or scalar(judgment.get("experimentId")) or (entry.experiment_id if entry else None),
        "source_title": scalar(source.get("title")),
        "source_url": scalar(source.get("url")),
        "task_family": scalar(judgment.get("task_family")) or scalar(judgment.get("taskFamily")),
        "claim_type": scalar(judgment.get("claim_type")) or scalar(judgment.get("claimType")),
        "index_decision": entry.decision if entry else None,
        "index_kind": entry.kind if entry else None,
        "index_summary": entry.summary if entry else {},
    }
    return (
        "You are judging a CPS financial research experiment. Return the final "
        "machine-readable judgment verdicts only after checking rules disclosure, "
        "data fit, execution realism, local evidence, and safety gates.\n\n"
        f"Context JSON:\n{json.dumps(fields, indent=2, sort_keys=True)}"
    )


def accepted_label(judgment: dict[str, Any], labels: list[dict[str, Any]]) -> dict[str, Any]:
    latest = labels[-1] if labels else None
    corrected = scalar(latest.get("correctedVerdict")) if latest else None
    label = scalar(latest.get("label")) if latest else None
    return {
        "operator_label": label,
        "corrected_verdict": corrected,
        "accepted_result_verdict": corrected or scalar(judgment.get("result_verdict")) or scalar(judgment.get("resultVerdict")),
        "accepted_promotion_verdict": scalar(judgment.get("promotion_verdict")) or scalar(judgment.get("promotionVerdict")),
    }


def dataset_rows(root: Path, index_file: Path | None) -> list[dict[str, Any]]:
    entries = index_entries(root, index_file)
    feedback = read_feedback(root)
    rows: list[dict[str, Any]] = []
    generated_at = utc_now()
    for experiment_id, judgment_path, judgment in discover_judgments(root, entries):
        entry = entries.get(experiment_id)
        labels = feedback.get(experiment_id, [])
        row = {
            "schema": DATASET_SCHEMA,
            "generated_utc": generated_at,
            "experiment_id": experiment_id,
            "judgment_path": str(judgment_path),
            "index_path": str(index_file) if index_file else None,
            "source_judgment_schema": scalar(judgment.get("schema")) or JUDGMENT_SCHEMA,
            "prompt": build_prompt(entry, judgment),
            "model_or_agent_judgment": judgment,
            "operator_feedback": labels,
            "accepted_label": accepted_label(judgment, labels),
            "features": {
                "rules_disclosure_status": nested_status(judgment.get("rules_disclosure")) or nested_status(judgment.get("rulesDisclosure")),
                "data_fit_status": nested_status(judgment.get("data_fit")) or nested_status(judgment.get("dataFit")),
                "execution_fit_status": nested_status(judgment.get("execution_fit")) or nested_status(judgment.get("executionFit")),
                "result_verdict": scalar(judgment.get("result_verdict")) or scalar(judgment.get("resultVerdict")),
                "promotion_verdict": scalar(judgment.get("promotion_verdict")) or scalar(judgment.get("promotionVerdict")),
                "confidence": judgment.get("confidence"),
            },
            "evidence_refs": judgment.get("evidence_refs") or judgment.get("evidenceRefs") or {},
            "safety": {
                "broker_actions": False,
                "signal_publishing": False,
                "paid_data": False,
                "paid_compute": False,
                "network": False,
            },
        }
        rows.append(row)
    return rows


def tinker_rows(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Create a conservative prompt/response JSONL for future Tinker experiments.

    This does not call Tinker. It keeps the output minimal and schema-shaped so a
    future trainer can choose the exact Tinker API/training objective.
    """
    out: list[dict[str, str]] = []
    for row in rows:
        accepted = row["accepted_label"]
        response = {
            "result_verdict": accepted.get("accepted_result_verdict"),
            "promotion_verdict": accepted.get("accepted_promotion_verdict"),
            "operator_label": accepted.get("operator_label"),
        }
        out.append({"prompt": row["prompt"], "response": json.dumps(response, sort_keys=True)})
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-practice-dir", type=Path, default=DEFAULT_SELF_PRACTICE_DIR)
    parser.add_argument("--index-file", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--eval-out", type=Path, default=None)
    parser.add_argument("--tinker-out", type=Path, default=None)
    parser.add_argument("--min-eval-labels", type=int, default=100)
    args = parser.parse_args()

    root = args.self_practice_dir
    index_file = args.index_file or latest_index(root)
    out = args.out or (root / "EXPERIMENT_JUDGMENTS.jsonl")
    eval_out = args.eval_out or (DEFAULT_EVAL_DIR / "judgment_triage_eval.jsonl")
    tinker_out = args.tinker_out or (DEFAULT_EVAL_DIR / "judgment_tinker_prompt_response.jsonl")

    rows = dataset_rows(root, index_file)
    training_count = write_jsonl(out, rows)

    accepted_rows = [row for row in rows if row["accepted_label"].get("operator_label") in {"agree", "disagree", "too_optimistic", "too_conservative", "wrong_blocker", "archive", "requires_approval", "proceed_autonomously"}]
    eval_count = 0
    if len(accepted_rows) >= args.min_eval_labels:
        eval_count = write_jsonl(eval_out, accepted_rows)

    tinker_count = write_jsonl(tinker_out, tinker_rows(rows)) if rows else 0

    print(json.dumps({
        "status": "ok",
        "self_practice_dir": str(root),
        "index_file": str(index_file) if index_file else None,
        "training_out": str(out),
        "training_rows": training_count,
        "accepted_label_rows": len(accepted_rows),
        "eval_out": str(eval_out),
        "eval_rows_written": eval_count,
        "eval_min_labels": args.min_eval_labels,
        "tinker_out": str(tinker_out),
        "tinker_rows": tinker_count,
        "network": False,
        "paid_actions": False,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
