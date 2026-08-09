#!/usr/bin/env python3
"""Deterministic pre-render gate for TSM animated-serial source packages.

This is intentionally separate from the faceless deck/b-roll gate.  JJ needs
character provenance and continuity evidence; it must not inherit slide-video,
YMYL, or archive rules just because it shares a media company.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="serial asset provenance manifest")
    parser.add_argument(
        "--output-root",
        type=Path,
        help="root containing the manifest's relative local_path files (default: manifest directory)",
    )
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    output_root = (args.output_root or manifest_path.parent).resolve()
    errors: list[str] = []

    try:
        manifest: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report one actionable gate failure
        print(json.dumps({"pass": False, "error": f"manifest unreadable: {exc}"}, indent=2))
        return 2
    if not isinstance(manifest, dict):
        print(json.dumps({"pass": False, "error": "manifest must be a JSON object"}, indent=2))
        return 2

    for key in ("issue", "source_refs", "binding_rule", "character_constraints"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            fail(errors, f"missing required serial provenance field: {key}")
    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        fail(errors, "assets must be a non-empty array")
        assets = []

    verified: list[dict[str, str]] = []
    for index, asset in enumerate(assets):
        label = f"assets[{index}]"
        if not isinstance(asset, dict):
            fail(errors, f"{label} must be an object")
            continue
        for key in ("name", "source_refs", "intended_beats", "local_path", "local_sha256", "local_status"):
            if not isinstance(asset.get(key), str) or not asset[key].strip():
                fail(errors, f"{label} missing {key}")
        relative = asset.get("local_path")
        expected_hash = asset.get("local_sha256")
        if not isinstance(relative, str) or not isinstance(expected_hash, str):
            continue
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts:
            fail(errors, f"{label} local_path must be a safe relative path")
            continue
        candidate = (output_root / path).resolve()
        if output_root not in candidate.parents and candidate != output_root:
            fail(errors, f"{label} local_path escapes output root")
            continue
        if not candidate.is_file():
            fail(errors, f"{label} governed asset missing: {relative}")
            continue
        actual_hash = sha256(candidate)
        if actual_hash != expected_hash.lower():
            fail(errors, f"{label} hash mismatch: {relative}")
            continue
        verified.append({"name": str(asset.get("name")), "path": relative, "sha256": actual_hash})

    report = {
        "pipeline_family": "animated-serial",
        "manifest": str(manifest_path),
        "output_root": str(output_root),
        "pass": not errors,
        "verified_assets": verified,
        "errors": errors,
        "note": "This gate verifies JJ-style provenance and exact bytes only; faceless slide/b-roll, finance YMYL, and archive gates are intentionally not applied.",
    }
    print(json.dumps(report, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
