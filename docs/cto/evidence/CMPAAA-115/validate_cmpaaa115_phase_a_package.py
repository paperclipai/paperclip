#!/usr/bin/env python3
"""Validate CMPAAA-115 Phase A first-review package against CMPAAA-49 field baseline."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


DOCS_ROOT = Path(__file__).resolve().parents[3]
EVIDENCE_DIR = Path(__file__).resolve().parent

SCHEMA_PATH = EVIDENCE_DIR / "cmpaaa-115-failure-drill-record.v1.schema.json"
SAMPLE_PATH = EVIDENCE_DIR / "samples" / "cmpaaa-115-failure-drill-record.sample.v1.json"
CMPAAA49_SAMPLE_PATH = DOCS_ROOT / "cto" / "evidence" / "CMPAAA-49" / "traceback-audit-samples.v1.json"
OUTPUT_PATH = EVIDENCE_DIR / "cmpaaa-115-phase-a-validation-output.v1.json"

SHARED_FIELDS = [
    "sample_id",
    "candidate_id",
    "run_id",
    "lineage_id",
    "traceback_request_id",
    "checked_at",
    "traceback_status",
    "missing_lineage_fields",
    "root_cause_category",
    "source_gate_decision_id",
    "audit_evidence_refs",
]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_utc(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def has_required_evidence_prefixes(refs: list[str]) -> bool:
    required_prefixes = ("lineage://", "run://", "traceback://")
    return all(any(ref.startswith(prefix) for ref in refs) for prefix in required_prefixes)


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    sample = load_json(SAMPLE_PATH)
    cmpaaa49_payload = load_json(CMPAAA49_SAMPLE_PATH)
    cmpaaa49_sample = cmpaaa49_payload["samples"][0]

    validator = Draft202012Validator(schema)
    schema_errors = sorted(validator.iter_errors(sample), key=lambda err: (list(err.path), err.message))

    sample_keys = set(sample.keys())
    cmpaaa49_keys = set(cmpaaa49_sample.keys())

    missing_in_115 = [field for field in SHARED_FIELDS if field not in sample_keys]
    missing_in_49 = [field for field in SHARED_FIELDS if field not in cmpaaa49_keys]

    escalation_sent_at = parse_utc(sample["escalation_sent_at"])
    escalation_acknowledged_at = parse_utc(sample["escalation_acknowledged_at"])
    mitigation_started_at = parse_utc(sample["mitigation_started_at"])
    resolved_at = parse_utc(sample["resolved_at"])

    ordering_valid = (
        escalation_sent_at
        <= escalation_acknowledged_at
        <= mitigation_started_at
        <= resolved_at
    )

    latency_minutes_expected = int((resolved_at - escalation_sent_at).total_seconds() / 60)
    latency_matches = sample["handling_latency_minutes"] == latency_minutes_expected

    evidence_prefixes_ok = has_required_evidence_prefixes(sample["audit_evidence_refs"])

    summary = {
        "schema_error_count": len(schema_errors),
        "shared_field_total": len(SHARED_FIELDS),
        "shared_fields_present_in_cmpaaa115_count": len(SHARED_FIELDS) - len(missing_in_115),
        "shared_fields_present_in_cmpaaa49_count": len(SHARED_FIELDS) - len(missing_in_49),
        "evidence_prefixes_ok": evidence_prefixes_ok,
        "escalation_timestamp_ordering_ok": ordering_valid,
        "handling_latency_matches_timestamp_diff": latency_matches,
    }

    acceptance = {
        "schema_error_count_eq_0": summary["schema_error_count"] == 0,
        "shared_fields_present_in_cmpaaa115_eq_11": summary["shared_fields_present_in_cmpaaa115_count"]
        == len(SHARED_FIELDS),
        "shared_fields_present_in_cmpaaa49_eq_11": summary["shared_fields_present_in_cmpaaa49_count"]
        == len(SHARED_FIELDS),
        "evidence_prefixes_ok": summary["evidence_prefixes_ok"],
        "escalation_timestamp_ordering_ok": summary["escalation_timestamp_ordering_ok"],
        "handling_latency_matches_timestamp_diff": summary["handling_latency_matches_timestamp_diff"],
    }

    output = {
        "issue": "CMPAAA-126",
        "parallel_lane": "CMPAAA-115",
        "baseline_contract": "CMPAAA-49",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "inputs": {
            "schema_path": str(SCHEMA_PATH.relative_to(DOCS_ROOT)),
            "sample_path": str(SAMPLE_PATH.relative_to(DOCS_ROOT)),
            "cmpaaa49_sample_path": str(CMPAAA49_SAMPLE_PATH.relative_to(DOCS_ROOT)),
        },
        "shared_fields": SHARED_FIELDS,
        "summary": summary,
        "acceptance": acceptance,
        "missing_shared_fields": {
            "cmpaaa115_sample": missing_in_115,
            "cmpaaa49_sample": missing_in_49,
        },
        "schema_errors": [
            {
                "path": "/".join(str(p) for p in err.path),
                "message": err.message,
            }
            for err in schema_errors
        ],
    }

    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
