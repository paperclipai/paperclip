# TSM-5791 rerender gate scaffold — 2026-07-30

This heartbeat converts the 2026-07-30 approval into fail-closed execution controls before any EP-001 reassembly can resume.

## Consulted authority

- Canonical recipe: `~/TSKB/KB/TSKB0175 [TSM] - JJ Shot Production Recipe - Tile-Seeded Plates, Composite Two-Shots, img2video - v1.0 - 07-23/README.md`
- Root-cause addendum: `~/TSKB/KB/TSKB0175 [TSM] - JJ Shot Production Recipe - Tile-Seeded Plates, Composite Two-Shots, img2video - v1.0 - 07-23/ADDENDUM-20260730-child-canon-prompt-inversion.md`
- Audio strip rule: `docs/TSKB/TSKB0082-jj-authoritative-motion-packs-must-audio-screen-embedded-clip-tracks.md`
- Coverage-floor context now subordinate to cast truth: `docs/TSKB/TSKB0083-authoritative-motion-pack-must-cover-locked-runtime-before-assembly.md`

## What was added

- `work-products/TSM-5791/source/tsm-5791-regenerated-clip-manifest.template.json`
  - Generated from the 2026-07-29 per-clip audit.
  - Carries all 39 clip slots, including clip 33, and marks every slot as `action: "regenerate"`.
  - Records the quarantined source bytes so the replacement chain is explicit and auditable.
- `work-products/TSM-5791/validate_regenerated_clips.py`
  - Enforces L1-L4 before assembly.
  - Fails if any clip lacks a replacement file, a per-clip cast-truth PASS report, or a provenance record naming attached ORIGINAL emotion-card references.
  - Fails if any replacement still points into `TSM-5718`, `TSM-5719`, or `TSM-5737`.
- `work-products/TSM-5791/tsm-5791-regenerated-clip-gate-report.json`
- `work-products/TSM-5791/tsm-5791-regenerated-clip-gate-report.md`
  - First run is intentionally red: `0/39` clip slots are currently eligible, so assembly remains blocked honestly.

## Verification

Command run:

```bash
python3 work-products/TSM-5791/validate_regenerated_clips.py
```

Observed result:

- Exit code: `2`
- PASS clips: `0`
- FAIL clips: `39`
- Assembly eligible: `false`

This is the expected fail-closed state before regenerated on-model clips exist.

## Next action

Use the manifest template as the shot-production contract: fill `replacementPath`, `perClipCastTruthReport`, and `provenanceRecord` for each regenerated clip, re-run the validator until it reaches `39/39 PASS`, and only then start the authoritative master assembly pass.
