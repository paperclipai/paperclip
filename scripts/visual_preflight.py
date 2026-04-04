#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def has_quick_scan_block(draft: dict[str, Any]) -> bool:
    text_candidates = [
        draft.get("quick_scan"),
        draft.get("quick_scan_block"),
        draft.get("markdown"),
        draft.get("content_markdown"),
    ]
    for value in text_candidates:
        if isinstance(value, str) and ("quick-scan" in value.lower() or "빠르게 보기" in value or "한눈에" in value):
            return True
    return False


def has_toc(draft: dict[str, Any]) -> bool:
    if isinstance(draft.get("toc"), list) and len(draft["toc"]) > 0:
        return True
    markdown = draft.get("markdown") or draft.get("content_markdown") or ""
    if isinstance(markdown, str) and ("## 목차" in markdown or "table of contents" in markdown.lower()):
        return True
    return False


def evaluate_visual(image_payload: dict[str, Any], draft_payload: dict[str, Any], image_path: str, draft_path: str) -> dict[str, Any]:
    duplicate_assets: list[str] = []
    digest_map: dict[str, str] = {}
    for slot in ("featured", "support-1", "support-2"):
        asset = image_payload.get(slot) or {}
        digest = asset.get("sha256")
        if isinstance(digest, str) and digest:
            if digest in digest_map:
                duplicate_assets.append(slot)
            else:
                digest_map[digest] = slot

    support_roles_ok = True
    support1 = image_payload.get("support-1") or {}
    support2 = image_payload.get("support-2") or {}
    role1 = support1.get("role")
    role2 = support2.get("role")
    if role1 and role2:
        support_roles_ok = role1 != role2 and role1 == "comparison" and role2 in {"workflow", "sequence"}
    elif duplicate_assets:
        support_roles_ok = False

    quick_scan_present = has_quick_scan_block(draft_payload)
    toc_present = has_toc(draft_payload)
    dense_article = len((draft_payload.get("markdown") or draft_payload.get("content_markdown") or "").split()) > 600
    hero_ok = bool((image_payload.get("featured") or {}).get("sha256"))

    reasons: list[str] = []
    if duplicate_assets:
        reasons.append("duplicate_visual_assets")
    if not support_roles_ok:
        reasons.append("support_role_separation_failed")
    if dense_article and not quick_scan_present:
        reasons.append("quick_scan_missing")
    if dense_article and not toc_present:
        reasons.append("toc_missing")
    if not hero_ok:
        reasons.append("hero_missing")

    ok = len(reasons) == 0
    return {
        "ok": ok,
        "gate": "visual_quality",
        "status": "pass" if ok else "fail",
        "reasons": reasons,
        "warnings": [],
        "hero_ok": hero_ok,
        "support_roles_ok": support_roles_ok,
        "duplicate_assets": duplicate_assets,
        "quick_scan_present": quick_scan_present,
        "toc_present": toc_present,
        "artifacts_used": [image_path, draft_path],
        "summary": "visual preflight passed" if ok else f"visual preflight failed: {', '.join(reasons)}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check visual readiness before publish.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--draft", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    result = evaluate_visual(load_json(args.image), load_json(args.draft), args.image, args.draft)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
