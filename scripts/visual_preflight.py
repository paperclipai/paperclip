#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import hashlib
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def infer_existing_featured(image_path: str) -> dict[str, Any]:
    image_file = Path(image_path)
    run_dir = image_file.parent
    featured_path = Path("/Users/daehan/.openclaw/workspace/generated") / f"{run_dir.name}-featured.png"
    if not featured_path.exists():
        return {}
    digest = hashlib.sha256(featured_path.read_bytes()).hexdigest()
    return {
        "sha256": digest,
        "saved_path": str(featured_path),
        "provider": "existing",
    }


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
    article_html = draft.get("article_html") or draft.get("wordpress_body_html") or ""
    if isinstance(article_html, str) and ("이번 글에서 바로 볼" in article_html or "핵심 요약" in article_html):
        return True
    return False


def has_toc(draft: dict[str, Any]) -> bool:
    if isinstance(draft.get("toc"), list) and len(draft["toc"]) > 0:
        return True
    markdown = draft.get("markdown") or draft.get("content_markdown") or ""
    if isinstance(markdown, str) and ("## 목차" in markdown or "table of contents" in markdown.lower()):
        return True
    article_html = draft.get("article_html") or draft.get("wordpress_body_html") or ""
    if isinstance(article_html, str) and ("reader-toc" in article_html or ">목차<" in article_html):
        return True
    return False


def evaluate_visual(image_payload: dict[str, Any], draft_payload: dict[str, Any], image_path: str, draft_path: str) -> dict[str, Any]:
    error_text = str(image_payload.get("error") or "").strip()
    duplicate_assets: list[str] = []
    digest_map: dict[str, str] = {}
    supporting_entries = image_payload.get("supporting") or []
    featured_asset = image_payload.get("featured") or {}
    if not featured_asset and image_payload.get("sha256"):
        featured_asset = {
            "sha256": image_payload.get("sha256"),
            "saved_path": image_payload.get("saved_path"),
            "provider": image_payload.get("provider"),
        }
    if not featured_asset:
        featured_asset = infer_existing_featured(image_path)
    inferred_structured_fallback = False
    if not supporting_entries and error_text:
        inferred_structured_fallback = True
        supporting_entries = [
            {"kind": "structured_fallback", "role": "comparison", "heading": "핵심 비교 정리"},
            {"kind": "structured_fallback", "role": "workflow", "heading": "도입 흐름 한눈에 보기"},
        ]
    slot_assets = {
        "featured": featured_asset,
        "support-1": supporting_entries[0] if len(supporting_entries) > 0 else image_payload.get("support-1") or {},
        "support-2": supporting_entries[1] if len(supporting_entries) > 1 else image_payload.get("support-2") or {},
    }
    for slot in ("featured", "support-1", "support-2"):
        asset = slot_assets.get(slot) or {}
        digest = asset.get("sha256")
        if isinstance(digest, str) and digest:
            if digest in digest_map:
                duplicate_assets.append(slot)
            else:
                digest_map[digest] = slot

    support_roles_ok = True
    support1 = slot_assets.get("support-1") or {}
    support2 = slot_assets.get("support-2") or {}
    role1 = support1.get("role")
    role2 = support2.get("role")
    if role1 and role2:
        support_roles_ok = role1 != role2 and role1 == "comparison" and role2 in {"workflow", "sequence"}
    elif duplicate_assets:
        support_roles_ok = False

    if error_text.startswith("duplicate_image_detected:"):
        slot = error_text.split(":", 1)[1].strip()
        if slot:
            duplicate_assets.append(slot)

    quick_scan_present = has_quick_scan_block(draft_payload)
    toc_present = has_toc(draft_payload)
    dense_article = len((draft_payload.get("markdown") or draft_payload.get("content_markdown") or "").split()) > 600
    hero_ok = bool((slot_assets.get("featured") or {}).get("sha256")) or error_text.startswith("duplicate_image_detected:support-")
    structured_fallback_used = inferred_structured_fallback or any((entry or {}).get("kind") == "structured_fallback" for entry in supporting_entries if isinstance(entry, dict))

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
        "structured_fallback_used": structured_fallback_used,
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
