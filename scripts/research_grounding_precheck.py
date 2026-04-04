#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REQUIRED_KEYS = [
    "notebook_reference",
    "fact_pack",
    "source_registry",
    "uncertainty_ledger",
]


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def resolve_presence(payload: dict[str, Any], key: str) -> bool:
    value = payload.get(key)
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True


def evaluate_grounding(payload: dict[str, Any], source_path: str) -> dict[str, Any]:
    missing = [key for key in REQUIRED_KEYS if not resolve_presence(payload, key)]
    largest_gap = payload.get("largest_evidence_gap")
    if not largest_gap and missing:
        largest_gap = f"missing required grounding artifacts: {', '.join(missing)}"
    notebook_reference = payload.get("notebook_reference")
    uncertainty_ok = resolve_presence(payload, "uncertainty_ledger")
    ok = len(missing) == 0
    return {
        "ok": ok,
        "gate": "research_grounding",
        "status": "pass" if ok else "fail",
        "reasons": [] if ok else [f"missing:{item}" for item in missing],
        "warnings": [],
        "missing_artifacts": missing,
        "largest_evidence_gap": largest_gap,
        "notebook_reference": notebook_reference,
        "uncertainty_ledger_ok": uncertainty_ok,
        "artifacts_used": [source_path],
        "summary": "research grounding complete" if ok else f"grounding incomplete: {', '.join(missing)}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check whether research grounding artifacts are complete.")
    parser.add_argument("--research", required=True, help="Path to a JSON research artifact")
    parser.add_argument("--out")
    args = parser.parse_args()

    result = evaluate_grounding(load_json(args.research), args.research)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
