#!/bin/bash
# TSM visual-QA door (board 2026-08-16, operator directive: "make sure TSM QA agent
# can VISUALLY inspect the video"). Deterministic frame extraction so a vision-capable
# QA lane LOOKS at the actual pixels before any accept — the "always LOOK at a frame"
# law made mechanical, and the Trap-8 protection (a gate substitution cannot silently
# strip vision when the accept requires this door's artifacts).
#
# Usage: tsm-qa-frames.sh <video> [outdir]
#   Extracts frames at 5%, 25%, 50%, 75%, 95% of duration plus a 3x2 contact sheet.
#   Prints JSON naming every artifact. QA lanes attach/read the frames and must cite
#   concrete visual observations (per frame) in the QA verdict — a verdict without
#   frame citations is a vacuous pass.
set -euo pipefail
V="${1:?usage: tsm-qa-frames.sh <video> [outdir]}"
OUT="${2:-$(dirname "$V")/qa-frames-$(basename "${V%.*}")}"
command -v ffmpeg >/dev/null || { echo '{"error":"ffmpeg not found"}'; exit 1; }
[ -f "$V" ] || { echo "{\"error\":\"no such file: $V\"}"; exit 1; }
mkdir -p "$OUT"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V" 2>/dev/null | cut -d. -f1)
[ -n "$DUR" ] && [ "$DUR" -gt 0 ] || { echo '{"error":"could not read duration"}'; exit 1; }
FRAMES=()
for PCT in 5 25 50 75 95; do
  TS=$((DUR * PCT / 100))
  F="$OUT/frame-${PCT}pct-t${TS}s.png"
  ffmpeg -v error -ss "$TS" -i "$V" -frames:v 1 -y "$F"
  FRAMES+=("$F")
done
SHEET="$OUT/contact-sheet.png"
ffmpeg -v error -i "$V" -vf "select='not(mod(n\,$(( (DUR*25) / 6 + 1 ))))',scale=480:-1,tile=3x2" -frames:v 1 -y "$SHEET" 2>/dev/null || SHEET=""
python3 - "$V" "$DUR" "$SHEET" "${FRAMES[@]}" <<'PY'
import json, sys
video, dur, sheet, *frames = sys.argv[1:]
print(json.dumps({
  "video": video, "durationSec": int(dur),
  "frames": frames, "contactSheet": sheet or None,
  "law": "QA verdicts MUST cite concrete visual observations from ≥2 of these frames; a verdict without frame citations is vacuous and gets reopened.",
}, indent=1))
PY
