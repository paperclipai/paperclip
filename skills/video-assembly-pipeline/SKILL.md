---
name: video-assembly-pipeline
description: >
  End-to-end driver: turn a script + generated/b-roll clips + audio into a finished, spec-conformant,
  YouTube-ready 1080p MP4. Use when an issue hands you the creative inputs (timed script,
  grok clips in assets/gen/, optional VO + music) and asks for the final cut. Orchestrates the
  video-editing recipes in order with one normalize pass and a single final encode.
---

# Video Assembly Pipeline

The repeatable run from creative inputs to a finished MP4. Command detail lives in **video-editing**;
generation in **video-gen-ops**; sourcing in **broll-sourcing**; captions in **auto-captions**.

## Inputs
Script with a shot/timing breakdown · clips in `assets/gen/` (grok ~8s) and/or `assets/broll/` ·
audio in `assets/audio/` (`vo.wav`, `bed.mp3`, or "none") · a spec block (duration, aspect,
resolution, fps, voiceover, audio_bed, captions: burned|srt|none, deliverable path).

## The 8 stages (gate each)
1. **Plan timeline vs script** — map each shot to a clip+duration; total clip time must cover the VO
   (VO sec ≈ words ÷ 2.5). Compute usable **unique-footage seconds before assembly**, counting each
   source asset only once after trims. If unique-footage seconds < VO/final duration, the plan must
   name the fill techniques: generate/source more clips, speed-ramp holds, stills+Ken Burns, or section
   cards. Naive looping is forbidden. Any planned reuse must obey the temporal-QA gate: no source asset
   >2 uses, no adjacent repeats, and repeated uses separated by >=90s.
2. **Inventory + inspect** every clip (`ffprobe`); flag anything below deliverable resolution. Native-resolution assets are the default. The only exception is the governed legacy-b-roll path: non-text, non-hero, short background footage may be Mini-upscaled after its source and target dimensions, purpose, source hash, and a passing visual check are recorded. Never upscale UI/capture proof, charts, readable text, evidence, a hero shot, or an asset whose artefacts are already visible at review size.
3. **Normalize all inputs** to spec into `assets/_norm/` (video-editing §1; silent-audio track mandatory for grok). Trim here.
4. **Build visual timeline** — default hard cuts (lossless concat); crossfades only at act breaks (chain for 3+ clips). → `assets/_norm/timeline.mp4`.
5. **Layer graphics** — title/lower-thirds + watermark (video-editing §7/§8), batched into few passes.
6. **Captions** per spec — none / srt (ship beside MP4) / burned (Shorts + silent autoplay) via **auto-captions**.
7. **Audio mix + master** — VO over ducked bed → -14 LUFS (video-editing §5); `-c:v copy` so picture isn't re-encoded.
8. **Final export + QA gate** — single faststart encode; then QA: ffprobe matches spec (±2s), VO clear over bed, captions spot-checked start/mid/end, first/last frames clean, **per-asset licence note on the issue**, and a mandatory **cut-map artifact** generated from the final render (video-editing §QA). The cut-map must use scene-cut detection on the finished MP4, map every detected segment to its source asset by frame hash, and assert: no source clip >2 uses, no adjacent repeats, reuse separation >=90s, no >20s span without visual change, and zero black/frozen spans. A cut without attached `cut-map.json` is not closeable.

### TSM shared CC / SL / VC slide-video gate (mandatory)

For Cashflow Compass, Stack Lab, and Vault Cases, run the shared rejection-QA
path after assembly and before review:

```bash
DECK_STORYBOARD=/absolute/storyboard.md \
DECK_BROLL_MANIFEST=/absolute/broll-manifest.json \
~/scripts/deck/run-rejection-qa-gates.sh <final.mp4> <cashflow-compass|stack-lab|vault-cases> <body/deck.mp4> <qa-out> <body/work>
```

The Stage-3 storyboard and b-roll manifest are required evidence whenever the
storyboard calls for real-world proof. `render-manifest.json` must declare
`motionTreatment` and `seamTreatment` per segment: text-bearing still slides
can be static but may never use Ken Burns/zoompan, their seams may not use that
treatment, and more than two consecutive slide-only segments fail. Channel
styling cannot bypass this gate. The deterministic regression is
`python3 ~/scripts/deck/test-shared-slide-video-policy.py`.

## Work-product retention
Once the final MP4, caption/SRT files, cut-map, QA report, licence note, and issue closeout evidence are present, render intermediates are not deliverables. Do not leave multi-GB segment/overlay folders behind. Before closing or requesting board review, run or cite the retention path:

```bash
~/scripts/paperclip-retention.sh
```

The retention script prunes TSM directories literally named `work` under work-products when the issue is no longer actively `in_progress` and the files are not fresh. Keep final renders, manifests, logs, scripts, QA reports, and source packets; prune regenerated overlays/segments.

## Temporal QA closeout contract
Attach `assets/final/cut-map/cut-map.json` beside the final MP4 and cite it in the issue closeout.
The artifact is pipeline-native evidence, not an optional reviewer aid. If it fails, fix the timeline
and rerun export+QA; do not ask the operator to catch obvious looping. When the historical vision-judge example
validates the vision judge, wire that judge into this same closeout as the second mandatory gate after
the cut-map.

## Exact-byte binding
Any candidate described as green, accepted, promoted, or requeue-ready must have the final MP4 SHA-256 recomputed after QA and recorded beside the QA report and promote record. The closeout must name one governed MP4 path whose current on-disk SHA matches both records. After QA passes, copy the exact MP4 into an immutable versioned path or mark the governed path read-only before any requeue/publish comment. If the MP4 at the cited path changes after QA, the prior green packet is void and the issue must rerun QA on the new bytes.

## One-encode discipline
Footage encodes exactly twice: normalize (3) + final export (8). Stages 4–7 `-c copy` or fold into one filtergraph.

## When NOT to assemble — kick to premium
If stage 1 shows a continuous shot >8s, photoreal people, lip-sync, or broadcast fidelity, grok won't
carry it — raise `[CREATIVE REQUEST] Flow/Veo: <need>` (creative-stack) and assemble the returned
footage with this same pipeline. Faceless montage / infographic-over-Ken-Burns / hooks assemble fine; hero/talking-head do not.

## Publication is board-gated
Agents never upload. Finished MP4 + thumbnail + caption file + licence table → board for approval + upload.
