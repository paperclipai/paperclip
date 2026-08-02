# TSM-5977 Stack Lab v5 input-contract readiness — 2026-08-01

## Decision

**Do not upload or dispatch yet.** The deployed `stacklab-v5-render` workflow
accepts only a complete, pre-rendered 34-beat bundle.  The governed source set
does not yet contain that bundle.  Dispatching now would be a deliberate
contract failure, not useful production work.

## Contract checked

- Renderer input contract:
  `work-products/TSM-6030/thinkstack-media-render/infra/runner/stacklab_v5/INPUT-CONTRACT.md`
- Deployed renderer guard:
  `work-products/TSM-6030/thinkstack-media-render/infra/runner/stacklab_v5/render.py`
- Production-rule consultation:
  `/Users/glad0s/TSKB/KB/TSKB0028 [TSM] - Episode Body Production Workflow & Quality Rules - v1.0 - 06-29/README.md`

## Measured readiness

| Required bundle member | Measured state | Result |
|---|---:|---|
| `audio/narration.wav` continuous take | Present: 447.738792 s | Ready |
| `script/script-v5.md` | Present | Ready |
| 34-row timing map | Present: 34 numbered rows | Ready |
| `cut-plan.json` (34 ordered aligned-word ranges) | 0 files | Missing |
| `visuals/beat-01.mp4` through `beat-34.mp4` | 0 files | Missing |
| locked inserts | 4 template MP4s exist in TSM-5974 | Not staged into a bundle |

The active timing map still declares Beat 33 at `15:22–15:37` and Beat 34 at
`15:37+`, whereas the accepted natural narration body is 447.739 seconds
(07:27.739).  `TSM-6028` permits a 07:58.500–08:35.000 final master only after
the locked 19.880 seconds of bookends and 11.000 seconds of inserts.  Therefore
the required `cut-plan.json` cannot be truthfully inferred from the stale map
without a design-owned reconciled 34-beat treatment/word-range source.

## Exact unblock action

CTO must provide or approve a contract-complete v5 treatment source package:

1. a reconciled 34-beat timing/reveal plan against the accepted continuous take;
2. 31 pre-rendered moving treatment clips plus the three staged locked insert
   clips, named `visuals/beat-01.mp4` … `visuals/beat-34.mp4`; and
3. `cut-plan.json` with ordered, non-overlapping WhisperX-aligned word ranges.

After that package lands, Coder will validate the input contract, upload the
governed Actions artifact, dispatch `stacklab-v5-render`, retrieve its output,
and complete the required render QA.  No publish or video-platform upload has
occurred.

## Input hashes

```text
ff790ce9c0cb5583e5325d44af019329e7eaaad807dea7f85de0fb57edb5f039  narration.wav
f97c8db973819ff354bdf55e952fda899ae14f61dbc7ad4aecb4804e6ade3a2e  script-v5.md
f175539f6b039a6da8861b3f0287c7af11086eab56810e34b0b2c44a6b077080  script-to-visual-timing-map.md
```
