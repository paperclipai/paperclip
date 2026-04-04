#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def extract_sections(payload: dict[str, Any]) -> list[str]:
    section_titles: list[str] = []
    for key in ("sections", "outline", "headings"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    section_titles.append(item)
                elif isinstance(item, dict):
                    title = item.get("title") or item.get("heading")
                    if isinstance(title, str) and title.strip():
                        section_titles.append(title.strip())
    markdown = payload.get("markdown") or payload.get("content_markdown") or ""
    if isinstance(markdown, str):
        for line in markdown.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                section_titles.append(stripped.lstrip("#").strip())
    return section_titles


def extract_title(payload: dict[str, Any]) -> str:
    for key in ("title", "headline"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def normalize_compare_text(value: str) -> str:
    lowered = value.lower().strip()
    lowered = re.sub(r"\d+\s*가?지", "", lowered)
    lowered = re.sub(r"[^a-z0-9가-힣 ]+", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def evaluate_alignment(payload: dict[str, Any], approved_topic: str) -> dict[str, Any]:
    title = extract_title(payload)
    sections = extract_sections(payload)
    ending = payload.get("ending_judgment") or payload.get("ending") or ""

    numbered_promise = any(token in title for token in ("3", "세 ", "세 가지", "3가지"))
    section_text = " ".join(sections)
    ending_text = ending if isinstance(ending, str) else json.dumps(ending, ensure_ascii=False)

    drift_type = None
    broken_section = None
    ending_alignment = True
    reasons: list[str] = []

    if numbered_promise and len(sections) < 3:
        drift_type = "title_structure_mismatch"
        broken_section = "visible sections do not expose the numbered promise"
        reasons.append("numbered_title_promise_not_reflected")

    normalized_approved = normalize_compare_text(approved_topic)
    normalized_title = normalize_compare_text(title)
    normalized_sections = normalize_compare_text(section_text)
    if normalized_approved and title and normalized_approved not in normalized_title and normalized_approved not in normalized_sections:
        drift_type = drift_type or "approved_topic_drift"
        broken_section = broken_section or "title/body no longer reflect the approved topic"
        reasons.append("approved_topic_not_reflected")

    if title and ending_text and any(token in title.lower() for token in ("3", "세 가지", "3가지")) and not any(
        token in ending_text.lower() for token in ("지금", "기다", "판단", "누가", "사람")
    ):
        ending_alignment = False
        drift_type = drift_type or "ending_alignment_mismatch"
        broken_section = broken_section or "ending does not pay off the title promise"
        reasons.append("ending_alignment_missing")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "gate": "topic_alignment",
        "status": "pass" if ok else "fail",
        "reasons": reasons,
        "warnings": [],
        "approved_topic": approved_topic,
        "title_promise": title,
        "drift_type": drift_type,
        "broken_section": broken_section,
        "ending_alignment": ending_alignment,
        "artifacts_used": [],
        "summary": "topic alignment intact" if ok else f"topic alignment failed: {drift_type}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check topic/title/body/ending alignment.")
    parser.add_argument("--draft", required=True, help="Path to draft JSON")
    parser.add_argument("--approved-topic", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    result = evaluate_alignment(load_json(args.draft), args.approved_topic)
    result["artifacts_used"] = [args.draft]
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
