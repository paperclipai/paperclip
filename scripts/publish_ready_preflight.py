#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


OWNER_ROUTING = {
    "research_grounding": "Research Lead",
    "topic_alignment": "Editor-in-Chief",
    "reader_experience": "Reader Experience Editor",
    "explainer_quality": "Explainer Editor",
    "visual_quality": "Visual Editor",
    "validation": "Founding Engineer",
    "publish_boundary": "Publisher",
    "public_verify": "Verifier",
}


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def normalize_gate_result(payload: dict[str, Any], source_path: str) -> dict[str, Any]:
    gate = payload.get("gate") or Path(source_path).stem
    ok = bool(payload.get("ok"))
    status = "pass" if ok else payload.get("status") or "fail"
    reasons = list(payload.get("reasons") or [])
    warnings = list(payload.get("warnings") or [])
    summary = payload.get("summary") or ""
    return {
        "gate": gate,
        "ok": ok,
        "status": status,
        "reasons": reasons,
        "warnings": warnings,
        "summary": summary,
        "source_path": source_path,
        "payload": payload,
    }


def merge_gate_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    failed = [result["gate"] for result in results if not result["ok"]]
    warnings: list[str] = []
    for result in results:
        warnings.extend(result["warnings"])

    owner_routing: list[str] = []
    for gate in failed:
        owner = OWNER_ROUTING.get(gate)
        if owner and owner not in owner_routing:
            owner_routing.append(owner)

    next_action_hint = None
    if failed:
        next_action_hint = f"Resolve failed gates before publish-ready review: {', '.join(failed)}"

    return {
        "ok": len(failed) == 0,
        "gate": "publish_ready",
        "status": "pass" if len(failed) == 0 else "fail",
        "failed_gates": failed,
        "warnings": warnings,
        "owner_routing": owner_routing,
        "next_action_hint": next_action_hint,
        "artifacts_used": [result["source_path"] for result in results],
        "summary": "all publish-ready gates passed" if len(failed) == 0 else f"failed gates: {', '.join(failed)}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge publish-ready gate outputs into one fail-closed result.")
    parser.add_argument("--gate-result", action="append", required=True, dest="gate_results")
    parser.add_argument("--out")
    args = parser.parse_args()

    results = [normalize_gate_result(load_json(path), path) for path in args.gate_results]
    merged = merge_gate_results(results)
    payload = json.dumps(merged, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
