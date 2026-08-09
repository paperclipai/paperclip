---
name: video-gen-ops
description: How to produce video assets for issues. Use whenever an issue needs video (channel clip, promo/teaser, listing video, social short, explainer, B-roll). If you have the native video_generate tool (grok-imagine), generate + ATTACH the clip directly. If you do NOT have the tool, ROUTE the issue to your company's Designer-Media agent (which generates via grok-imagine). Escalate to the BOARD only when the brief specifically needs Veo or Flow (Google) — or Sora (ChatGPT Pro) — capabilities grok-imagine lacks. Agents never call paid video APIs and never block silently on missing video capability. Then assemble clips + sourced b-roll with ffmpeg.
---

# Video Gen Ops

The portfolio guardrail still holds: **no pay-per-call video APIs.** But native
generation via grok-imagine (the hermes `video_gen` toolset → `video_generate` tool) is
**$0** and is the default path whenever you have the tool — same engine as image gen.
Board-subscription tools (Veo/Flow/Sora) are the last resort, reserved for capabilities
grok-imagine can't match. Your job is everything around generation too: the creative
package before it, the assembly and QA after it.

Grok Imagine model-routing note (validated 2026-08-09):
- Current production-safe text-to-video path remains `grok-imagine-video` at 480p/720p.
- The installed Hermes xAI provider can select `grok-imagine-video-1.5` per call and
  accepts image input plus an explicit 1080p request. TSM-6553 served-proved that exact
  **image-to-video** route (one `video_generate` call; 6.04s H.264 result). Do not change
  the global provider default or use 1.5 as a text-to-video fallback.
- A moving asset means the `video_generate` tool. Never use `image_generate` with an
  image input as a substitute; that is an image edit and must fail the media gate.
- Hermes caches completed xAI video locally and provider public storage is off by default.
  Copy/attach the cached asset into the governed package promptly; do not depend on a
  temporary xAI URL or re-enable permanent public URLs without a retention owner.
- xAI may return a 1920x1088 padded stream while declaring 1080p. The Mini assembly
  handler deterministically normalizes text-free motion B-roll to 1920x1080 and records
  the source/delivery geometry. It is not an upscale or a reason to regenerate.
- The provider supports reference-to-video, edit and extension on the base model. Generated
  URLs are temporary: download, hash, attach, and register the asset promptly.
- Native generated audio can speed rough cuts, but it is still scratch ambience until ear
  QA plus provenance/licensing review say otherwise; do not replace the audio-bed registry
  path by default.

## Decision rule (in priority order)

0. **If you have the `video_generate` tool (grok-imagine — the hermes `video_gen`
   toolset), USE IT DIRECTLY. This is the preferred path whenever available** — $0, no
   board round-trip, no GPU contention. Steps:
   - Call `video_generate` with an art-directed prompt (state subject, camera movement,
     lighting, palette, aspect ratio, duration *inside the prompt*).
   - The tool writes the clip under `~/.hermes/cache/` (video alongside the image cache).
     **The asset is NOT delivered until you ATTACH that file to the issue** — leaving it
     in the cache is an INCOMPLETE disposition. Attach it:
     ```bash
     curl -sS -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       -F "file=@<the-generated-clip-path>;type=video/mp4" \
       "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/<this-issue-id>/attachments"
     ```
   - Comment the exact prompt used and confirm the attachment, then set the disposition.
   - **Exception:** if the brief *explicitly* requires Veo, Flow, or Sora — capabilities
     grok-imagine lacks — do NOT force grok-imagine; escalate to the board (step 3).
1. **If you do NOT have the `video_generate` tool, ROUTE to the media agent — do NOT
   board it, do NOT call a paid API.** Reassign the issue to your company's
   **Designer-Media** agent (a `hermes_local` agent with the `video_gen` toolset that
   generates natively via grok-imagine):
   - find it: `GET /api/companies/$PAPERCLIP_COMPANY_ID/agents` → the agent named
     `Designer-Media`, or a `hermes_local` agent whose `adapterConfig.toolsets` includes
     `video_gen`;
   - hand it off: `PATCH /api/issues/<id>` with `{"assigneeAgentId":"<designer-media-id>"}`
     and comment that you routed it for generation.
   - If your company has NO media agent yet, escalate to the board to provision one.
2. **Asset already obtainable as b-roll/stock?** Check the **broll-sourcing** skill — a
   licensed stock clip beats a generated one for generic footage (cityscapes, hands
   typing, nature). A generated still with a Ken Burns pan/zoom (stills→motion
   recipe in **video-editing**, via **image-gen-ops**) is often enough; generate
   video only when motion is essential and stock can't supply it.
3. **Escalate to the BOARD only for Veo, Flow, or Sora.** grok-imagine (via the
   Designer-Media agent) covers essentially all routine clips, so the board is the LAST
   resort — reserved for briefs that specifically need **Veo or Flow (Google)** or
   **Sora (ChatGPT Pro app)**: the brief explicitly asks for one, or it needs a
   long-form / high-fidelity shot grok-imagine can't match. Produce the full package
   (below) and mark the issue for board action via the "Copy prompt" flow; a human runs
   it in the subscription app and drops the file into the workspace. Do NOT board a
   request merely because YOU lack the tool — that is what routing to Designer-Media
   (step 1) is for.
4. **Clips delivered** (native, routed, or board-dropped into the workspace `assets/`
   dir) → assemble per **video-assembly-pipeline** (ffmpeg recipes live in
   **video-editing**), then run the QA checklist.

## The generation package (for board action on Veo/Flow/Sora only)

Only when step 3 applies (the brief needs Veo/Flow/Sora, not for routine clips that
go native via step 0/1). ONE comment, with the prompt in its own fenced block ready
for "Copy prompt":

1. **Script** — full voiceover/dialogue text, timed (words ÷ 2.5 ≈ seconds at
   narration pace). Mark emphasis and pauses.
2. **Storyboard** — one line per scene: visual, motion, on-screen text, duration.
3. **Shot list** — each shot that needs generating gets its own row: shot id,
   duration, prompt summary, target tool (Sora/Veo), and what it cuts to.
4. **Copy-ready generation prompt(s)** — one fenced block per shot. State subject,
   style, camera movement, lighting, palette, aspect ratio, and duration *inside the
   prompt text*. One subject per prompt; no compound scenes — cut in the edit instead.
5. **Spec block** (machine-checkable, see below) and the exact workspace path each
   file should land at: `assets/gen/<shot-id>.mp4`.

## Spec format (every video issue carries one)

```yaml
spec:
  duration_s: 30            # total runtime, ±2s tolerance
  aspect: "16:9"            # 16:9 (YouTube), 9:16 (Shorts/Reels), 1:1
  resolution: 1920x1080     # output container resolution
  fps: 30
  voiceover: |              # exact VO text, or "none"
    ...
  captions: burned | srt | none
  audio_bed: <file or "none">   # licensed music/ambience, see broll-sourcing
  deliverable: assets/final/<slug>.mp4
```

## Assembly (board clips + b-roll → deliverable)

Drive assembly with the **video-assembly-pipeline** skill; the ffmpeg command recipes
(normalize, concat, overlay/captions, audio-bed mix, stills→motion) are owned by the
**video-editing** skill — use them, don't hand-roll.
Convention: inputs in `assets/gen/` and `assets/broll/`, normalized intermediates in
`assets/_norm/`, output in `assets/final/`. Never re-encode more than once after
normalization. A Mini-only legacy-b-roll upscale is permitted only for non-text,
non-hero, short background footage with `upscaled_from`, source/output hash,
source/target dimensions, intended use, and a passing visual QA record in its manifest.
It is normalization for delivery, not evidence that native 1080p detail exists.

## Handoff / QA checklist (before marking done or requesting board publish)

- [ ] `ffprobe` confirms resolution, fps, and duration match the spec block.
- [ ] Audio: VO intelligible over bed (bed ducked ≥ 12 dB under VO); no clipping;
      no silent video track where the spec has VO.
- [ ] Captions per spec (burned in, or `.srt` shipped next to the file); spot-check
      caption timing at start/middle/end.
- [ ] First and last frames are not black/garbage (check with `ffmpeg -ss`).
- [ ] **Licensing note per asset** in the issue: every clip, still, and audio track
      listed with source URL + licence (generated assets: tool + prompt link;
      b-roll: the manifest entry from broll-sourcing).
- [ ] Publication is board-gated: the deliverable + publish instructions go to the
      board for approval. Agents never upload/publish externally.
