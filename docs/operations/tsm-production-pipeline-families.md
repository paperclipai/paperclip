# TSM production pipeline families and controlled validation

## Purpose

TSM shares operational controls, not one creative pipeline. This document prevents
the repeated failure mode in which a valid rule for a faceless editorial episode
is applied to Jessica James animation or a future scientific explainer.

## Family routing

| Pipeline family | Channels | Required family contract | Explicit non-inheritance |
| --- | --- | --- | --- |
| `faceless-editorial` | Stack Lab, Cashflow Compass, Vault Cases | Package-first, Stage-3 storyboard, b-roll/visual-type manifest, shared rejection QA, Mini-first render, exact-byte binding | Cashflow YMYL applies only to Cashflow; archive licence hard-fail applies only to Vault Cases; Stack Lab proof requires real capture. |
| `animated-serial` | Jessica James | Approved character bible/reference pack, episode/shot/pose/continuity ledger, character and motion/audio QA, Mini-first render, exact-byte binding | No slide/b-roll-runtime test, Cashflow YMYL, or Vault Cases archive gate unless an exact asset/segment needs it. |
| `scientific-explainer` | Future science channel | Package-first, source/numerical ledger, explanatory-visual accuracy QA, Mini-first render, exact-byte binding | No finance or archive policy; faceless visual QA applies only if the visual form is faceless editorial. |

Every issue declares exactly one `pipeline-family:` value. A family conflict blocks
pre-production until corrected.

## Render lanes

- Simple self-contained assembly: `routine-op: video-assembly` → TSM RoutineOps →
  `scripts/video-assembly-shell.py` → Mini. This is zero-LLM mechanical work.
- Normal faceless episodes: `build-deck.sh` / `build-episode.sh` → Mini plus shared
  rejection QA. Do not substitute the simple assembly wrapper for this full route.
- JJ animation: a dedicated serial-animation source package and Mini render; it may
  share output/provenance controls but not faceless b-roll/slide rules.

## Legacy 720p b-roll normalization

Mini upscaling is free in token terms but does not recreate image detail. It is
allowed only for short, non-text, non-hero background b-roll. The manifest must
record `upscaled_from`, original/target dimensions and hashes, intended use, renderer,
and a passing visual check. It is forbidden for readable text, UI/capture proof,
charts, evidence, and hero shots. A final 1080p container must never be described
as native 1080p source quality.

Provider video marked “1080p” can arrive as a padded 1920×1088 H.264 stream.
That is not an upscale and does not require another generation: the Mini-only
assembly handler deterministically normalizes it to the requested 1920×1080
delivery frame (`scale`/centred `crop`) and records both source geometry/hash and
delivery geometry in `metrics.json` / `cut-map.json`. Use this only for a
text-free moving asset; do not crop UI, charts, evidence, captions, or other
edge-critical material without a visual approval.

## Controlled validation sequence

No fleet-wide resume is part of this sequence.

1. **Baseline:** record the exact route, agent configuration, model/provider,
   and current quota/health state. Confirm the inactive legacy automated b-roll
   job remains inactive.
2. **Deterministic proof:** run one self-contained RoutineOps assembly; retain
   `metrics.json`, Mini queue evidence, output hash, and zero LLM-token fields.
3. **Grok capability probe:** served validation is recorded in TSM-6552/6553.
   The first two-call probe exposed an incorrect `image_generate` route; the
   corrected revalidation used exactly one `video_generate` call with
   `grok-imagine-video-1.5`, reused its source still, and returned 6.04 seconds
   of H.264 video. Future pilots retain the same one-call/no-retry evidence
   contract: attach both assets, record requested/served model, resolution,
   elapsed time, tool result, and Paperclip heartbeat token counts. In a
   Paperclip-managed Hermes run the xAI provider now attaches the cached MP4 to
   the owning issue before it can report success; that attachment is the first
   durable handoff and X10 custody mirrors it. A cache path or temporary xAI URL
   alone is never closeout evidence.
4. **Faceless full-route proof:** use one bounded Stack Lab source package through
   the shared Mini/deck/rejection-QA path. It must carry normal brand marks via the
   deterministic brand layer, not AI-generated text.
5. **Animated-serial provenance proof:** before a JJ Mini render, validate its
   character/source package without applying faceless controls:

   ```bash
   python3 scripts/validate-tsm-animated-serial-package.py \
     <serial-output-root>/provenance-manifest.json
   ```

   The gate checks source references and exact hashes of each governed asset. It
   does not make an old demo package an approval to render a new episode.
6. **Verdict:** only a complete `execution-ledger.json` and passing route-specific
   evidence promotes a provider/route to the next pilot. A failure opens one
   scoped repair/re-scope issue; it does not create repeated generation attempts.

## Execution ledger

`execution-ledger.json` has one row per deterministic or model step:

```json
{
  "step": "grok-i2v-1080-probe",
  "pipeline_family": "faceless-editorial",
  "issue_id": "TSM-…",
  "agent_id": "…",
  "heartbeat_run_id": "…",
  "requested": {"provider": "xai-oauth", "model": "grok-imagine-video-1.5", "resolution": "1080p"},
  "served": {"model": "…", "resolution": "…"},
  "tokens": {"paperclip_input": 0, "paperclip_output": 0, "handler_llm": 0},
  "elapsed_s": 0,
  "outcome": "pass|fail",
  "evidence": ["asset hash", "ffprobe", "Mini queue entry"]
}
```

The ledger distinguishes LLM tokens from zero-token shell-handler work; it does
not fold retries or unrelated context into the step total.
