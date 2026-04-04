#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def first_screen_text(draft: dict[str, Any]) -> str:
    markdown = draft.get("markdown") or draft.get("content_markdown") or ""
    if isinstance(markdown, str) and markdown.strip():
        lines = [line.strip() for line in markdown.splitlines() if line.strip()]
        return " ".join(lines[:5])
    article_html = draft.get("article_html") or draft.get("wordpress_body_html") or ""
    if isinstance(article_html, str) and article_html.strip():
        text = re.sub(r"<[^>]+>", " ", article_html)
        text = re.sub(r"\s+", " ", text).strip()
        return " ".join(text.split()[:120])
    return ""


def first_screen_sentences(text: str) -> list[str]:
    source = re.sub(r"\s+", " ", text or "").strip()
    if not source:
        return []
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|(?<=[다요죠])\s+", source) if part.strip()]


def contains_plain_language_bridge(text: str) -> bool:
    lowered = text.lower()
    markers = [
        "쉽게 말하면",
        "한마디로",
        "풀어 말하면",
        "일반 사용자 기준",
        "쉽게 보면",
        "in plain english",
        "put simply",
        "simply put",
        "for ordinary users",
    ]
    return any(marker in lowered or marker in text for marker in markers)


def contains_concrete_example(text: str) -> bool:
    lowered = text.lower()
    markers = [
        "예를 들어",
        "가령",
        "대표적으로",
        "실제로는",
        "for example",
        "for instance",
        "in practice",
        "for a typical user",
    ]
    return any(marker in lowered or marker in text for marker in markers)


def evaluate_explainer(draft: dict[str, Any], source_path: str) -> dict[str, Any]:
    opening = first_screen_text(draft)
    lowered = opening.lower()
    full_markdown = (draft.get("markdown") or draft.get("content_markdown") or draft.get("article_html") or draft.get("wordpress_body_html") or "")
    full_text = re.sub(r"<[^>]+>", " ", str(full_markdown))
    full_text = re.sub(r"\s+", " ", full_text).strip()
    opening_sentences = first_screen_sentences(opening)

    english_opening_complete = all(
        marker in lowered or marker in opening
        for marker in ("what changed", "why it matters", "who should care")
    )
    korean_opening_complete = (
        ("변화" in opening or "달라졌" in opening or "무슨 일" in opening)
        and ("일반 사용자" in opening or "누가" in opening or "사용자" in opening or "비즈니스 사용자" in opening)
        and ("중요" in opening or "의미" in opening or "체감" in opening or "판단" in opening or "왜" in opening)
    )
    opening_complete = english_opening_complete or korean_opening_complete

    jargon_terms = ["mcp", "token", "latency", "inference", "orchestrator", "context window"]
    jargon_hits = sum(1 for term in jargon_terms if term.lower() in lowered)
    jargon_risk = "high" if jargon_hits >= 3 else "medium" if jargon_hits >= 1 else "low"

    analogy_risk = "high" if "like " in lowered and "actually" not in lowered else "low"
    uncertainty_loss_risk = "high" if any(term in lowered for term in ["will definitely", "확실히", "반드시"]) else "low"
    lead_window = " ".join(opening_sentences[:5]) if opening_sentences else opening
    significance_present = any(token in lead_window.lower() or token in lead_window for token in ["why it matters", "중요", "의미", "체감", "왜"])
    change_present = any(token in lead_window.lower() or token in lead_window for token in ["what changed", "change", "변화", "달라", "무슨 일"])
    reader_present = any(token in lead_window.lower() or token in lead_window for token in ["who should care", "reader", "user", "일반 사용자", "비즈니스 사용자", "누가"])
    lead_quality_ok = change_present and significance_present and reader_present
    term_explanation_ok = True
    if any(term.lower() in full_text.lower() for term in jargon_terms):
      term_explanation_ok = contains_plain_language_bridge(full_text)
    concrete_example_present = contains_concrete_example(full_text)

    reasons: list[str] = []
    if not opening_complete:
        reasons.append("opening_incomplete")
    if not lead_quality_ok:
        reasons.append("lead_value_missing")
    if jargon_risk == "high":
        reasons.append("jargon_too_dense")
    if not term_explanation_ok:
        reasons.append("term_explanation_missing")
    if analogy_risk == "high":
        reasons.append("analogy_risk_high")
    if uncertainty_loss_risk == "high":
        reasons.append("uncertainty_loss_risk_high")
    if not concrete_example_present:
        reasons.append("concrete_example_missing")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "gate": "explainer_quality",
        "status": "pass" if ok else "fail",
        "reasons": reasons,
        "warnings": [],
        "opening_complete": opening_complete,
        "lead_quality_ok": lead_quality_ok,
        "jargon_risk": jargon_risk,
        "term_explanation_ok": term_explanation_ok,
        "analogy_risk": analogy_risk,
        "uncertainty_loss_risk": uncertainty_loss_risk,
        "concrete_example_present": concrete_example_present,
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
