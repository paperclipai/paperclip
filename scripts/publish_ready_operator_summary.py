#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def derive_gate_path(merged_path: Path, gate_name: str) -> Path:
    if gate_name == "publish_ready":
        return merged_path
    return merged_path.with_name(f"preflight.{gate_name}.json")


def build_summary(merged: dict[str, Any], merged_path: str) -> str:
    failed_gates = [str(g) for g in merged.get("failed_gates") or [] if str(g).strip()]
    gate_reason_summary = {
        str(k): [str(v) for v in values]
        for k, values in (merged.get("gate_reason_summary") or {}).items()
    }
    owner_routing = [str(o) for o in merged.get("owner_routing") or [] if str(o).strip()]

    lines: list[str] = []
    lines.append("## Publish-Ready Operator Summary")
    lines.append("")
    lines.append(f"- Status: `{'pass' if merged.get('ok') else 'fail'}`")
    lines.append(f"- Summary: {merged.get('summary') or 'n/a'}")
    if owner_routing:
        lines.append(f"- Owner routing: {', '.join(owner_routing)}")
    if merged.get("next_action_hint"):
        lines.append(f"- Next action: {merged['next_action_hint']}")

    if not failed_gates:
        lines.append("")
        lines.append("All publish-ready gates passed.")
        return "\n".join(lines)

    lines.append("")
    lines.append("### Failed Gates")
    for gate in failed_gates:
        lines.append(f"- `{gate}`")
        reasons = gate_reason_summary.get(gate) or []
        if reasons:
            lines.append(f"  reasons: {', '.join(reasons)}")
        gate_path = derive_gate_path(Path(merged_path), gate)
        if gate_path.exists():
            try:
                payload = load_json(str(gate_path))
                detail_summary = str(payload.get("summary") or "").strip()
                if detail_summary:
                    lines.append(f"  detail: {detail_summary}")
            except Exception:
                pass

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a markdown-friendly operator summary from publish_ready preflight output.")
    parser.add_argument("--publish-ready", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    merged = load_json(args.publish_ready)
    output = build_summary(merged, args.publish_ready)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
