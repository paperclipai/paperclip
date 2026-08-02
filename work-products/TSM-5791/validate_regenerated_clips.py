#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ISSUE_ID = "TSM-5791"
OUT_ROOT = ROOT / "work-products" / ISSUE_ID
SOURCE_ROOT = OUT_ROOT / "source"
MANIFEST_PATH = SOURCE_ROOT / "tsm-5791-regenerated-clip-manifest.template.json"
REPORT_JSON = OUT_ROOT / "tsm-5791-regenerated-clip-gate-report.json"
REPORT_MD = OUT_ROOT / "tsm-5791-regenerated-clip-gate-report.md"

QUARANTINED_LINEAGE_ROOTS = [
    ROOT / "work-products" / "TSM-5718",
    ROOT / "work-products" / "TSM-5719",
    ROOT / "work-products" / "TSM-5737",
]

ORIGINAL_SEED_ROOT = Path("/Users/glad0s/Pictures/ThinkStack Assets/Jessica James/Emotion cards - ORIGINALS")
REQUIRED_SEED_FILENAMES = sorted(path.name for path in ORIGINAL_SEED_ROOT.glob("*.png"))
EXPECTED_CLIP_COUNT = 39


@dataclass(frozen=True)
class ClipResult:
    n: int
    slug: str
    replacement_path: str | None
    cast_truth_report: str | None
    provenance_record: str | None
    passed: bool
    violations: list[str]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def read_references(record_path: Path) -> list[str]:
    if record_path.suffix.lower() == ".json":
        payload = load_json(record_path)
        references = payload.get("referenceFiles")
        if isinstance(references, list):
            return [str(item).strip() for item in references if str(item).strip()]
    text = record_path.read_text(encoding="utf-8", errors="replace")
    return [name for name in REQUIRED_SEED_FILENAMES if name in text]


def validate_manifest() -> tuple[dict[str, Any], list[ClipResult]]:
    if not MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"Missing manifest template: {MANIFEST_PATH}")
    payload = load_json(MANIFEST_PATH)
    entries = payload.get("clips")
    if not isinstance(entries, list):
        raise RuntimeError(f"Manifest clips must be a list: {MANIFEST_PATH}")
    if len(entries) != EXPECTED_CLIP_COUNT:
        raise RuntimeError(
            f"Manifest clip count mismatch: expected {EXPECTED_CLIP_COUNT}, observed {len(entries)}"
        )

    results: list[ClipResult] = []
    seen_slots: set[int] = set()
    for raw in entries:
        n = int(raw["n"])
        slug = str(raw["slug"])
        if n in seen_slots:
            raise RuntimeError(f"Duplicate clip slot {n} in {MANIFEST_PATH}")
        seen_slots.add(n)

        replacement_raw = str(raw.get("replacementPath") or "").strip()
        cast_truth_raw = str(raw.get("perClipCastTruthReport") or "").strip()
        provenance_raw = str(raw.get("provenanceRecord") or "").strip()

        violations: list[str] = []
        replacement_path = Path(replacement_raw).expanduser() if replacement_raw else None
        cast_truth_path = Path(cast_truth_raw).expanduser() if cast_truth_raw else None
        provenance_path = Path(provenance_raw).expanduser() if provenance_raw else None

        if replacement_path is None:
            violations.append("replacementPath missing")
        elif not replacement_path.is_file():
            violations.append(f"replacementPath missing on disk: {replacement_path}")
        else:
            for quarantined in QUARANTINED_LINEAGE_ROOTS:
                if quarantined == replacement_path or quarantined in replacement_path.parents:
                    violations.append(f"replacementPath still points into quarantined lineage: {replacement_path}")
                    break

        if cast_truth_path is None:
            violations.append("perClipCastTruthReport missing")
        elif not cast_truth_path.is_file():
            violations.append(f"perClipCastTruthReport missing on disk: {cast_truth_path}")
        else:
            gate_payload = load_json(cast_truth_path)
            if gate_payload.get("pass") is not True:
                violations.append(f"perClipCastTruthReport is not pass=true: {cast_truth_path}")

        if provenance_path is None:
            violations.append("provenanceRecord missing")
        elif not provenance_path.is_file():
            violations.append(f"provenanceRecord missing on disk: {provenance_path}")
        else:
            references = read_references(provenance_path)
            if not references:
                violations.append(
                    "provenanceRecord names no attached ORIGINAL emotion-card reference file "
                    f"from {ORIGINAL_SEED_ROOT}"
                )

        results.append(
            ClipResult(
                n=n,
                slug=slug,
                replacement_path=rel(replacement_path) if replacement_path else None,
                cast_truth_report=rel(cast_truth_path) if cast_truth_path else None,
                provenance_record=rel(provenance_path) if provenance_path else None,
                passed=not violations,
                violations=violations,
            )
        )

    return payload, sorted(results, key=lambda item: item.n)


def write_reports(manifest_payload: dict[str, Any], results: list[ClipResult]) -> dict[str, Any]:
    passed = sum(1 for item in results if item.passed)
    failed = len(results) - passed
    report = {
        "issue": ISSUE_ID,
        "manifestPath": rel(MANIFEST_PATH),
        "quarantinedLineageRoots": [rel(path) for path in QUARANTINED_LINEAGE_ROOTS],
        "requiredSeedRoot": str(ORIGINAL_SEED_ROOT),
        "requiredSeedFilenames": REQUIRED_SEED_FILENAMES,
        "expectedClipCount": EXPECTED_CLIP_COUNT,
        "manifestClipCount": len(results),
        "passCount": passed,
        "failCount": failed,
        "assemblyEligible": failed == 0,
        "clips": [
            {
                "n": item.n,
                "slug": item.slug,
                "replacementPath": item.replacement_path,
                "perClipCastTruthReport": item.cast_truth_report,
                "provenanceRecord": item.provenance_record,
                "pass": item.passed,
                "violations": item.violations,
            }
            for item in results
        ],
        "sourceAudit": {
            "path": rel(OUT_ROOT / "tsm-5791-per-clip-cast-truth-audit-2026-07-29.json"),
            "fullySalvageable": manifest_payload.get("fullySalvageable"),
            "sourceManifest": manifest_payload.get("sourceManifest"),
        },
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# TSM-5791 regenerated clip gate report",
        "",
        f"- Manifest: `{rel(MANIFEST_PATH)}`",
        f"- Quarantined lineage: `{rel(QUARANTINED_LINEAGE_ROOTS[0])}`, `{rel(QUARANTINED_LINEAGE_ROOTS[1])}`, `{rel(QUARANTINED_LINEAGE_ROOTS[2])}`",
        f"- Seed root: `{ORIGINAL_SEED_ROOT}`",
        f"- Assembly eligible: `{report['assemblyEligible']}`",
        f"- Clip PASS count: `{passed}`",
        f"- Clip FAIL count: `{failed}`",
        "",
        "| # | slug | pass | notes |",
        "|---|---|---|---|",
    ]
    for item in results:
        notes = "pass" if item.passed else "; ".join(item.violations)
        lines.append(f"| {item.n} | {item.slug} | {'PASS' if item.passed else 'FAIL'} | {notes} |")
    REPORT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main() -> int:
    manifest_payload, results = validate_manifest()
    report = write_reports(manifest_payload, results)
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return 0 if report["assemblyEligible"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
