# TSM-6030 — Stack Lab v5 production dispatch contract

**Repository:** `ThinkStackDM/thinkstack-media-render` (private)

**Served commit:** `0af6bb006b834709d3a090ca56cfffcd73096c47` on `main`

## Dispatch

Workflow: `stacklab-v5-render`

Required inputs:

- `source_run_id` — Actions run that uploaded the governed Stack Lab input bundle.
- `source_artifact` — artifact name, normally `stacklab-v5-inputs-<run-id>`.

Optional input: `artifact_name` (defaults to `stacklab-v5-render`).

The bundle contract is committed at
`infra/runner/stacklab_v5/INPUT-CONTRACT.md`. It requires the continuous
OpenVoice v2 narration WAV, locked v5 script, 34-row timing map, a 34-beat
aligned-word cut plan, the 34 visual clips (including the three locked inserts),
and retained overlay/template sources.

## Render guarantees

- WhisperX aligns the locked transcript against the continuous WAV before cuts.
- The renderer refuses absent/short/still sources and does not loop or
  freeze-frame-pad a beat.
- It creates `stack-lab-v5.mp4`, `stack-lab-v5.srt`, `alignment.json`,
  `cut-map.json`, `metrics.json`, and 66 pre/post transition frames.

## Retrieval

Download `stacklab-v5-render-<run-id>` from the dispatched GitHub Actions run.
The workflow retains the artifact for 14 days.

## Verification

- `python3 -m py_compile infra/runner/stacklab_v5/render.py`
- Ruby YAML parse passed for `.github/workflows/stacklab-v5-render.yml`.
- Static acceptance checks confirmed private `self-hosted, tsm-render` targeting,
  artifact download/upload, WhisperX invocation, 34-beat validation, and required
  output checks.
