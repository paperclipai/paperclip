#!/usr/bin/env python3
"""Validate CMPAAA-115 controlled failure drill evidence package."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


DOCS_ROOT = Path(__file__).resolve().parents[3]
EVIDENCE_DIR = Path(__file__).resolve().parent

SCHEMA_PATH = EVIDENCE_DIR / "cmpaaa-115-failure-drill-record.v1.schema.json"
RUN_SAMPLE_PATH = EVIDENCE_DIR / "samples" / "cmpaaa-115-failure-drill-run.v1.json"
CMPAAA49_SAMPLE_PATH = DOCS_ROOT / "cto" / "evidence" / "CMPAAA-49" / "traceback-audit-samples.v1.json"
OUTPUT_PATH = EVIDENCE_DIR / "cmpaaa-115-failure-drill-validation-output.v1.json"

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


def relative(path: Path) -> str:
    return str(path.relative_to(DOCS_ROOT))


def all_required_prefixes_exist(refs: list[str]) -> bool:
    required_prefixes = ("lineage://", "run://", "traceback://")
    return all(any(ref.startswith(prefix) for ref in refs) for prefix in required_prefixes)


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    run_sample = load_json(RUN_SAMPLE_PATH)
    cmpaaa49_payload = load_json(CMPAAA49_SAMPLE_PATH)
    cmpaaa49_sample = cmpaaa49_payload["samples"][0]

    records = run_sample.get("records", [])
    if not isinstance(records, list):
        raise ValueError("records must be a list")

    validator = Draft202012Validator(schema)
    schema_errors: list[dict[str, Any]] = []

    failed_records = []
    ordering_failures = []
    latency_mismatch_records = []
    target_breach_records = []
    evidence_prefix_failures = []
    root_cause_missing_records = []

    cmpaaa49_missing_shared_fields = [
        field for field in SHARED_FIELDS if field not in cmpaaa49_sample
    ]

    for index, record in enumerate(records):
        record_errors = sorted(
            validator.iter_errors(record),
            key=lambda err: (list(err.path), err.message),
        )
        for err in record_errors:
            schema_errors.append(
                {
                    "record_index": index,
                    "sample_id": record.get("sample_id"),
                    "path": "/".join(str(p) for p in err.path),
                    "message": err.message,
                }
            )

        if record.get("traceback_status") != "failed":
            continue

        failed_records.append(record)

        if not isinstance(record.get("root_cause_category"), str) or not record["root_cause_category"].strip():
            root_cause_missing_records.append(record.get("sample_id"))

        refs = record.get("audit_evidence_refs")
        if not isinstance(refs, list) or not all_required_prefixes_exist(refs):
            evidence_prefix_failures.append(record.get("sample_id"))

        sent_at = parse_utc(record["escalation_sent_at"])
        ack_at = parse_utc(record["escalation_acknowledged_at"])
        mitigation_at = parse_utc(record["mitigation_started_at"])
        resolved_at = parse_utc(record["resolved_at"])

        ordering_ok = sent_at <= ack_at <= mitigation_at <= resolved_at
        if not ordering_ok:
            ordering_failures.append(record.get("sample_id"))

        handling_minutes = int((resolved_at - sent_at).total_seconds() / 60)
        if handling_minutes != record["handling_latency_minutes"]:
            latency_mismatch_records.append(record.get("sample_id"))

        escalation_target_minutes = int(record["escalation_target_minutes"])
        if handling_minutes > escalation_target_minutes:
            target_breach_records.append(record.get("sample_id"))

    failed_records_missing_shared_fields: dict[str, list[str]] = {}
    for record in failed_records:
        sample_id = str(record.get("sample_id", "unknown"))
        missing = [field for field in SHARED_FIELDS if field not in record]
        if missing:
            failed_records_missing_shared_fields[sample_id] = missing

    summary = {
        "record_count": len(records),
        "failed_record_count": len(failed_records),
        "schema_error_count": len(schema_errors),
        "shared_field_total": len(SHARED_FIELDS),
        "cmpaaa49_shared_fields_present_count": len(SHARED_FIELDS) - len(cmpaaa49_missing_shared_fields),
        "failed_records_with_missing_shared_fields_count": len(failed_records_missing_shared_fields),
        "failed_records_with_root_cause_missing_count": len(root_cause_missing_records),
        "failed_records_with_evidence_prefix_failure_count": len(evidence_prefix_failures),
        "failed_records_with_timestamp_order_failure_count": len(ordering_failures),
        "failed_records_with_latency_mismatch_count": len(latency_mismatch_records),
        "failed_records_with_target_breach_count": len(target_breach_records),
    }

    acceptance = {
        "record_count_gte_1": summary["record_count"] >= 1,
        "failed_record_count_gte_1": summary["failed_record_count"] >= 1,
        "schema_error_count_eq_0": summary["schema_error_count"] == 0,
        "cmpaaa49_shared_fields_present_eq_11": summary["cmpaaa49_shared_fields_present_count"]
        == len(SHARED_FIELDS),
        "failed_records_missing_shared_fields_eq_0": summary["failed_records_with_missing_shared_fields_count"]
        == 0,
        "failed_records_root_cause_missing_eq_0": summary["failed_records_with_root_cause_missing_count"]
        == 0,
        "failed_records_evidence_prefix_failure_eq_0": summary["failed_records_with_evidence_prefix_failure_count"]
        == 0,
        "failed_records_timestamp_order_failure_eq_0": summary["failed_records_with_timestamp_order_failure_count"]
        == 0,
        "failed_records_latency_mismatch_eq_0": summary["failed_records_with_latency_mismatch_count"]
        == 0,
        "failed_records_target_breach_eq_0": summary["failed_records_with_target_breach_count"] == 0,
    }
    acceptance["closeout_ready"] = all(acceptance.values())

    output = {
        "issue": "CMPAAA-115",
        "baseline_contract_issue": "CMPAAA-49",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "inputs": {
            "schema_path": relative(SCHEMA_PATH),
            "run_sample_path": relative(RUN_SAMPLE_PATH),
            "cmpaaa49_sample_path": relative(CMPAAA49_SAMPLE_PATH),
        },
        "drill_id": run_sample.get("drill_id"),
        "summary": summary,
        "acceptance": acceptance,
        "missing_shared_fields": {
            "cmpaaa49_sample": cmpaaa49_missing_shared_fields,
            "failed_records": failed_records_missing_shared_fields,
        },
        "schema_errors": schema_errors,
        "failures": {
            "root_cause_missing_samples": root_cause_missing_records,
            "evidence_prefix_failed_samples": evidence_prefix_failures,
            "timestamp_order_failed_samples": ordering_failures,
            "latency_mismatch_samples": latency_mismatch_records,
            "target_breach_samples": target_breach_records,
        },
    }

    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
