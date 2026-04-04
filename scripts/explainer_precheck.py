#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def first_screen_text(draft: dict[str, Any]) -> str:
    markdown = draft.get("markdown") or draft.get("content_markdown") or ""
    if not isinstance(markdown, str):
        return ""
    lines = [line.strip() for line in markdown.splitlines() if line.strip()]
    return " ".join(lines[:5])


def evaluate_explainer(draft: dict[str, Any], source_path: str) -> dict[str, Any]:
    opening = first_screen_text(draft)
    lowered = opening.lower()

    opening_complete = all(
        marker in lowered or marker in opening
        for marker in ("what changed", "why it matters", "who should care")
    ) or all(marker in opening for marker in ("무엇", "왜", "누가"))

    jargon_terms = ["mcp", "token", "latency", "inference", "orchestrator", "context window"]
    jargon_hits = sum(1 for term in jargon_terms if term.lower() in lowered)
    jargon_risk = "high" if jargon_hits >= 3 else "medium" if jargon_hits >= 1 else "low"

    analogy_risk = "high" if "like " in lowered and "actually" not in lowered else "low"
    uncertainty_loss_risk = "high" if any(term in lowered for term in ["will definitely", "확실히", "반드시"]) else "low"

    reasons: list[str] = []
    if not opening_complete:
        reasons.append("opening_incomplete")
    if jargon_risk == "high":
        reasons.append("jargon_too_dense")
    if analogy_risk == "high":
        reasons.append("analogy_risk_high")
    if uncertainty_loss_risk == "high":
        reasons.append("uncertainty_loss_risk_high")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "gate": "explainer_quality",
        "status": "pass" if ok else "fail",
        "reasons": reasons,
        "warnings": [],
        "opening_complete": opening_complete,
        "jargon_risk": jargon_risk,
        "analogy_risk": analogy_risk,
        "uncertainty_loss_risk": uncertainty_loss_risk,
        "artifacts_used": [source_path],
        "summary": "explainer quality passed" if ok else f"explainer quality failed: {', '.join(reasons)}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check opening clarity, jargon, analogy risk, and uncertainty loss.")
    parser.add_argument("--draft", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    result = evaluate_explainer(load_json(args.draft), args.draft)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
