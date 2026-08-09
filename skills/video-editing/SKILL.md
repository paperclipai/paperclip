---
name: video-editing
description: >
  ThinkStack Media's ffmpeg editing reference — concrete commands for joining, trimming,
  transitioning, audio-mixing, captioning, overlaying, scaling, thumbnailing and exporting
  YouTube-ready 1080p video. Use whenever you have raw clips (grok-imagine-video output,
  b-roll, stills) and need to cut/assemble/finish them locally. ffmpeg is installed; other
  CLIs install on demand. For the full script→clips→finished-MP4 run use video-assembly-pipeline.
---

# Video Editing (ffmpeg)

ffmpeg lives at `/opt/homebrew/bin/ffmpeg` (8.x GPL build: libx264/265, aac, libmp3lame, xfade,
acrossfade, loudnorm, drawtext, subtitles, overlay). `ffprobe` ships with it. This is the editing
reference; **video-assembly-pipeline** drives these steps end-to-end; **video-gen-ops** owns the
generation package + handoff QA.

## TSM house spec (every YouTube deliverable unless the issue overrides)
1920x1080 · 30fps · yuv420p · AAC 48kHz stereo 192kbps · loudness -14 LUFS / -1.5 dBTP · MP4 `+faststart`.
Directory convention: `assets/gen/` (board/grok clips) · `assets/broll/` (sourced) · `assets/_norm/`
(normalized intermediates) · `assets/audio/` (VO+bed) · `assets/final/` (deliverables).

## THE ONE RULE: normalize before you concat
grok-imagine-video clips are ~8s, 720p, no audio, mixed fps. Concatenating mismatched streams
produces broken files. Normalize EVERY input to spec first, then concat is a lossless `-c copy`.

## 0. Inspect first
```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration -of default=nw=1 assets/gen/clip-01.mp4
```
## 1. Normalize every input (scale+pad, force fps, add silent audio)
```bash
ffmpeg -y -i assets/gen/clip-01.mp4 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 \
  -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -c:a aac -ar 48000 -ac 2 assets/_norm/clip-01.mp4
```
## 2. Trim
```bash
ffmpeg -y -ss 1.5 -i in.mp4 -t 4.0 -c:v libx264 -crf 18 -c:a aac assets/_norm/trim.mp4
```
## 3. Join — hard cuts (lossless, instant)
```bash
printf "file 'clip-01.mp4'\nfile 'clip-02.mp4'\n" > assets/_norm/list.txt
ffmpeg -y -f concat -safe 0 -i assets/_norm/list.txt -c copy assets/_norm/timeline.mp4
```
## 4. Join — crossfade (offset = clipA length − fade)
```bash
ffmpeg -y -i a.mp4 -i b.mp4 -filter_complex \
  "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=7.5[v];[0:a][1:a]acrossfade=d=0.5[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac out.mp4
```
transitions: `fade dissolve fadeblack wipeleft slideup circleopen`.
## 5. Audio — VO over ducked music bed, normalized
```bash
ffmpeg -y -i timeline.mp4 -i assets/audio/vo.wav -i assets/audio/bed.mp3 -filter_complex "\
  [2:a]volume=0.9,afade=t=out:st=28:d=2[bed];\
  [bed][1:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[duck];\
  [duck][1:a]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-14:TP=-1.5[a]" \
  -map 0:v -map "[a]" -shortest -c:v copy -c:a aac -b:a 192k assets/final/out.mp4
```
## 6. Captions (burn in from SRT — generate via auto-captions)
```bash
ffmpeg -y -i timeline.mp4 -vf "subtitles=captions.srt:force_style='FontName=Helvetica,FontSize=22,Outline=2,MarginV=60'" -c:v libx264 -crf 18 -c:a copy captioned.mp4
```
Soft captions (spec `srt`): ship the `.srt` beside the MP4, don't burn in. Burn in only for Shorts/silent autoplay.
## 7. Title cards / lower-thirds (timed)
```bash
ffmpeg -y -i timeline.mp4 -vf "drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='Title':fontsize=64:fontcolor=white:borderw=3:bordercolor=black@0.8:x=80:y=h-160:enable='between(t,1,5)'" -c:v libx264 -crf 18 -c:a copy titled.mp4
```
## 8. Watermark / logo (PNG alpha)
```bash
ffmpeg -y -i timeline.mp4 -i logo.png -filter_complex "[1]format=rgba,colorchannelmixer=aa=0.7[wm];[0][wm]overlay=W-w-40:H-h-40" -c:v libx264 -crf 18 -c:a copy wm.mp4
```
## 9. Still → motion (Ken Burns)
```bash
ffmpeg -y -loop 1 -i hero.png -t 5 -vf "scale=7680:4320,zoompan=z='min(zoom+0.0015,1.2)':d=150:s=1920x1080:fps=30,format=yuv420p" -c:v libx264 -crf 18 hero-kb.mp4
```
## 10. Thumbnail
```bash
ffmpeg -y -ss 6.0 -i timeline.mp4 -frames:v 1 -vf scale=1920:1080 assets/final/thumb.png
```
## 11. Final YouTube export
```bash
ffmpeg -y -i edit.mp4 -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart assets/final/youtube-1080p.mp4
```
9:16 Shorts: scale/pad target `1080:1920`, keep captions burned in.

## QA before handing back
```bash
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate -of json assets/final/youtube-1080p.mp4
ffmpeg -ss 0 -i out.mp4 -frames:v 1 /tmp/first.png        # not black?
ffmpeg -i out.mp4 -af volumedetect -f null - 2>&1 | grep -E 'mean|max'
```

### Mandatory temporal cut-map
Every assembled cut must attach `assets/final/cut-map/cut-map.json`. No cut-map means the video is not
closeable. Run this after final export from the project root; keep the JSON with the MP4 and cite it in
the issue closeout.

```bash
FINAL=assets/final/youtube-1080p.mp4
CUT_DIR=assets/final/cut-map
mkdir -p "$CUT_DIR"

# Scene boundaries from the finished render.
ffprobe -v error -f lavfi \
  -i "movie=$FINAL,select=gt(scene\\,0.24)" \
  -show_entries frame=best_effort_timestamp_time:frame_tags=lavfi.scene_score \
  -of csv=p=0 > "$CUT_DIR/scene-cuts.csv"

# Black/frozen-span detector; any black_start or freeze_start in the log is a failure.
ffmpeg -hide_banner -i "$FINAL" \
  -vf "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=1" \
  -an -f null - 2> "$CUT_DIR/black-freeze.log" || true

python3 - "$FINAL" "$CUT_DIR" assets/_norm/*.mp4 <<'PY'
import collections
import json
import math
import re
import subprocess
import sys
from pathlib import Path

final = Path(sys.argv[1])
cut_dir = Path(sys.argv[2])
sources = [
    Path(p) for p in sys.argv[3:]
    if Path(p).is_file() and Path(p).name not in {"timeline.mp4", final.name}
]

def duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], text=True).strip()
    return float(out)

def ahash(path, t):
    raw = subprocess.check_output([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(t, 0):.3f}",
        "-i", str(path), "-frames:v", "1", "-vf", "scale=8:8,format=gray",
        "-f", "rawvideo", "-"
    ])
    if len(raw) != 64:
        raise RuntimeError(f"could not hash frame for {path} at {t:.3f}s")
    avg = sum(raw) / len(raw)
    return "".join("1" if b >= avg else "0" for b in raw)

def hamming(a, b):
    return sum(x != y for x, y in zip(a, b))

final_dur = duration(final)
cuts = [0.0]
for line in (cut_dir / "scene-cuts.csv").read_text().splitlines():
    if not line.strip():
        continue
    try:
        t = float(line.split(",", 1)[0])
    except ValueError:
        continue
    if 0.25 < t < final_dur - 0.25:
        cuts.append(t)
cuts.append(final_dur)
cuts = sorted(set(round(t, 3) for t in cuts))

source_hashes = []
for src in sources:
    dur = duration(src)
    samples = max(1, math.ceil(dur / 0.5))
    for i in range(samples):
        t = min(dur - 0.05, i * 0.5 + 0.25)
        source_hashes.append({
            "source_asset": str(src),
            "source_time": round(max(t, 0), 3),
            "hash": ahash(src, max(t, 0)),
        })
if not source_hashes:
    raise SystemExit("cut-map QA FAIL: no source clips indexed under assets/_norm/*.mp4")

segments = []
for idx, (start, end) in enumerate(zip(cuts, cuts[1:]), start=1):
    mid = start + ((end - start) / 2)
    fh = ahash(final, mid)
    match = min(source_hashes, key=lambda row: hamming(fh, row["hash"]))
    segments.append({
        "index": idx,
        "start": round(start, 3),
        "end": round(end, 3),
        "duration": round(end - start, 3),
        "frame_hash": fh,
        "source_asset": match["source_asset"],
        "source_time": match["source_time"],
        "hash_distance": hamming(fh, match["hash"]),
    })

violations = []
uses = collections.Counter(seg["source_asset"] for seg in segments)
for asset, count in sorted(uses.items()):
    if count > 2:
        violations.append({"rule": "source_clip_max_2_uses", "source_asset": asset, "uses": count})
for prev, cur in zip(segments, segments[1:]):
    if prev["source_asset"] == cur["source_asset"]:
        violations.append({"rule": "no_adjacent_repeats", "source_asset": cur["source_asset"], "at": cur["start"]})
for asset in sorted(uses):
    starts = [seg["start"] for seg in segments if seg["source_asset"] == asset]
    for a, b in zip(starts, starts[1:]):
        if b - a < 90:
            violations.append({"rule": "reuse_separation_90s", "source_asset": asset, "gap": round(b - a, 3)})
for seg in segments:
    if seg["duration"] > 20:
        violations.append({"rule": "visual_change_span_max_20s", "segment": seg["index"], "duration": seg["duration"]})

black_freeze_log = (cut_dir / "black-freeze.log").read_text(errors="replace")
for kind in ("black_start", "freeze_start"):
    if re.search(kind, black_freeze_log):
        violations.append({"rule": "zero_black_or_frozen_spans", "detector": kind})

report = {
    "final": str(final),
    "duration": round(final_dur, 3),
    "source_index_count": len(source_hashes),
    "segments": segments,
    "assertions": {
        "source_clip_max_uses": 2,
        "no_adjacent_repeats": True,
        "reuse_separation_seconds": 90,
        "max_visual_change_span_seconds": 20,
        "zero_black_frozen_spans": True,
    },
    "violations": violations,
    "pass": not violations,
}
(cut_dir / "cut-map.json").write_text(json.dumps(report, indent=2) + "\n")
if violations:
    raise SystemExit(f"cut-map QA FAIL: {len(violations)} violation(s); see {cut_dir / 'cut-map.json'}")
print(f"cut-map QA PASS: {len(segments)} segment(s), {len(uses)} source asset(s)")
PY
```

Required pass conditions: no source clip >2 uses, no adjacent repeats, repeated use separated by
>=90s, no segment >20s without a detected visual change, and zero black/frozen spans. If the future
historical vision-judge example is validated, run it as the second mandatory QA gate
after this cut-map and attach its verdict beside the JSON.

## Re-encode discipline
Encode once after normalize, once at final export. Use `-c copy` for container-only steps (concat,
watermark-over-encoded-timeline, remux). Pad by default. A Mini-only legacy-b-roll upscale is
allowed for non-text, non-hero, short background footage when its native/target dimensions and
hashes, intended use, and passing visual QA are recorded in the asset manifest. It cannot restore
lost detail and must never be used for UI/capture proof, charts, readable text, evidence, or hero
footage.
## Quality ceiling — when to stop and request premium
grok clips are 8s/720p/no-audio. ffmpeg joins/captions/finishes them into a clean 1080p cut but
can't add detail that isn't there. For shots >8s continuous, photoreal humans, or broadcast
fidelity → raise `[CREATIVE REQUEST] Flow/Veo: …` (see creative-stack) rather than over-process
weak footage. ffmpeg makes good footage finished, not bad footage good.
