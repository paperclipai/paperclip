#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def paragraphs(markdown: str) -> list[str]:
    chunks = [chunk.strip() for chunk in markdown.split("\n\n")]
    return [chunk for chunk in chunks if chunk]


def evaluate_reader(draft: dict[str, Any], source_path: str) -> dict[str, Any]:
    markdown = draft.get("markdown") or draft.get("content_markdown") or ""
    markdown = markdown if isinstance(markdown, str) else ""
    parts = paragraphs(markdown)
    first_dropoff = None
    if len(parts) >= 3 and len(parts[0]) + len(parts[1]) > 900:
        first_dropoff = "intro_paragraph_3"
    elif len(parts) >= 2 and len(parts[0]) > 700:
        first_dropoff = "intro_paragraph_2"

    keep_reading_hook_present = any(token in markdown.lower() for token in ["이번 글", "이 글", "3가지", "what changed"])
    ending_payoff_present = any(token in markdown.lower() for token in ["지금", "기다", "판단", "next step", "watch next"])
    scan_path_ok = any(token in markdown.lower() for token in ["##", "quick-scan", "목차", "한눈에"])

    reasons: list[str] = []
    if first_dropoff:
        reasons.append("early_dropoff_risk")
    if not keep_reading_hook_present:
        reasons.append("keep_reading_hook_missing")
    if not ending_payoff_present:
        reasons.append("ending_payoff_missing")
    if not scan_path_ok:
        reasons.append("scan_path_missing")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "gate": "reader_experience",
        "status": "pass" if ok else "fail",
        "reasons": reasons,
        "warnings": [],
        "first_dropoff_zone": first_dropoff,
        "keep_reading_hook_present": keep_reading_hook_present,
        "ending_payoff_present": ending_payoff_present,
        "scan_path_ok": scan_path_ok,
        "artifacts_used": [source_path],
        "summary": "reader experience passed" if ok else f"reader experience failed: {', '.join(reasons)}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check scan path, early drop-off risk, and ending payoff.")
    parser.add_argument("--draft", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    result = evaluate_reader(load_json(args.draft), args.draft)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
