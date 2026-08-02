# TSM-6032 Stack Lab v5 contract-source audit — 2026-08-01

## Disposition

The input bundle cannot be truthfully completed from the governed sources now
present. This audit is the CTO fallback handoff record and the exact input
brief for the design/render owner. It does **not** authorize Coder to invent,
retime, substitute, loop, or freeze-pad any treatment clip.

## Reconciled timing decision

The only current timing source is the accepted continuous OpenVoice take:

- body: `447.738792 s` (SHA-256
  `ff790ce9c0cb5583e5325d44af019329e7eaaad807dea7f85de0fb57edb5f039`)
- locked non-narrated inserts: Beat 24 = 5.000 s, Beat 33 = 6.000 s,
  Beat 34 = 9.940 s
- natural final master: `478.618792 s` / `07:58.619`, within the amended
  `07:58.500–08:35.000` acceptance band.

The stale 15:22–15:37 (Beat 33) and 15:37+ (Beat 34) clock rows are
superseded. The design owner must retain treatments and reveal requirements
from `work-products/TSM-5973/script-to-visual-timing-map.md`, but bind the
31 narrated beats to forced-alignment phrase ranges from this exact take.

## Contract inventory

| Required contract member | Governed source available | Package-ready? |
|---|---|---|
| `audio/narration.wav` | corrected continuous WAV above | Yes |
| locked script + treatment map | `TSM-5973` hashes below | Yes |
| Beat 24 locked CTA | `TSM-5974/templates/03-mid-cta-bump-v1.mp4` | Yes |
| Beat 33 locked lead magnet | `TSM-5974/templates/04-ad-lead-magnet-slot-v1.mp4` | Yes |
| Beat 34 locked outro | `TSM-5974/templates/02-channel-outro-signoff-v1.mp4` | Yes |
| forced alignment | no `alignment.json` / WhisperX word list found | No |
| `cut-plan.json` | no 34 ordered word ranges found | No |
| narrated moving clips (`beat-01`–`beat-23`, `beat-25`–`beat-32`) | no approved pre-rendered treatment clips found | No |

## Locked source hashes

```text
f97c8db973819ff354bdf55e952fda899ae14f61dbc7ad4aecb4804e6ade3a2e  script-v5.md
f175539f6b039a6da8861b3f0287c7af11086eab56810e34b0b2c44a6b077080  script-to-visual-timing-map.md
1973c97888601ef4c4627fa7e2d9acc4d369b1d4f4b06245d86b68e841210e4d  beat-24 locked CTA
583c813ac7263dab83e5408351ef6f335e65944c9f03303a45cb98652abb180d  beat-33 locked lead magnet
585fd3d48e90f9e7dab4e37209a441988032647b9db11fc41bd88f562f68c336  beat-34 locked outro
```

## Exact completion deliverable

Create `work-products/TSM-6032/stacklab-v5-contract-source-pack/` containing
the renderer contract tree:

```text
audio/narration.wav
script/script-v5.md
script/script-to-visual-timing-map.md       # reconciled timing/reveal plan
alignment.json                              # WhisperX word array for the accepted WAV
cut-plan.json                               # exactly 34 ordered, non-overlapping word ranges
visuals/beat-01.mp4 … visuals/beat-34.mp4
overlays/
manifest.json                               # SHA-256 + duration + source provenance
```

`cut-plan.json` must use zero-based, monotonic, non-overlapping WhisperX word
indices. Its `source` values must be relative bundle paths. Beats 24, 33 and
34 must point to their staged locked source copies, with the hashes above.
The 31 narrated clips must have genuine motion and satisfy their matching
reveal requirements; existing old proof segments are not approved substitutes.

## Governing references consulted

- `work-products/TSM-6030/thinkstack-media-render/infra/runner/stacklab_v5/INPUT-CONTRACT.md`
- `work-products/TSM-6025/stack-lab-v5-natural-narration-runtime-decision-20260801.md`
- `work-products/TSM-6028/*` (natural-master band amendment)
- `/Users/glad0s/TSKB/KB/TSKB0028 [TSM] - Episode Body Production Workflow & Quality Rules - v1.0 - 06-29/README.md`
- `/Users/glad0s/TSKB/KB/TSKB0073 [TSM] - Runtime-Band Script Relocks Must Carry a Narration Budget - v1.0 - 07-18.md`

TSKB0028 prohibits freeze-padding/time stretching and requires motion plus
narration-synced reveals. TSKB0073 confirms this accepted take is valid for a
source-driven timing map, not the stale legacy clock.
