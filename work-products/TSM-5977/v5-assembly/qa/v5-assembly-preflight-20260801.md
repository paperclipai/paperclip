# TSM-5977 v5 assembly preflight — 2026-08-01

## Inputs verified

- Script: `work-products/TSM-5973/script-v5.md`
- Required timing map: `work-products/TSM-5973/script-to-visual-timing-map.md`
- Reusable template pack: `work-products/TSM-5974/USAGE.md`, `work-products/TSM-5974/MANIFEST.json`
- Overlay/template pack: `work-products/TSM-5977/deps/tsm-5975-overlay-pack-src/stack-lab-overlay-templates/`
- Lead-magnet copy: `work-products/TSM-5976/tsm-5974-handoff-copy.md`

## Blocking design conflict

The issue requires a runtime of approximately 12–13 minutes, and the v5 script declares an estimated **13.2 minutes including pauses**. The timing map is also declared as the beat-for-beat assembly law, but its 34th insert starts at **15:37+**, before the standard outro is appended. It therefore yields a minimum runtime over 15:37 plus the locked 9.94-second outro (about 15:47), even if every mapped duration is followed exactly.

These specifications cannot both be met. This is not an encode or pacing defect: it is a source/design decision between the mandatory timing map and the requested target runtime.

Additional cue discrepancy: the timing map has the mid-CTA and lead-magnet inserts but no explicit intro insertion beat, while the issue requires the TSM-5974 intro template at its marked cue point. A resolved timing-map revision must name the intro placement and whether its duration is additive or replaces mapped content.

## Implementer-ready route once resolved

1. Lock a revised map whose accumulated time matches the selected runtime and includes the 9.94s intro/outro and the required CTA/lead-magnet inserts.
2. Provide the Beat 33 filled lead-magnet derivative or approve its render from the supplied TSM-5976 copy.
3. I will author the 34-beat deck spec, render VO with pause/pronunciation controls, splice locked inserts, then run cut-transition frame QA, SRT generation, cut-map, and watch-through.

## No production render started

No partial master was rendered. Rendering the current map would knowingly violate the issue's 12–13 minute acceptance criterion, while shortening it would violate the declared beat-for-beat timing-map law.

## 2026-08-01 continuation — timing decision resolved; runtime provision blocks render

`work-products/TSM-6019/stack-lab-v5-runtime-decision-timing-map-20260801.md`
resolves the design conflict: the production master target is 15:38 (accepted
range 15:30–15:45), with the explicit intro and locked insert timings. The
TSM-5973, TSM-5974, and TSM-5975 dependency outputs are present and usable.

The next hard blocker is execution capacity, not content or design:

- This runner has no `openvoice` Python module, no installed OpenVoice v2
  checkpoint directory, no MeloTTS runtime, and no Charon/Sam reference source
  from which to synthesize the v5 narration.
- The two governed work-product roots were checked: the served company root
  contains the script/template inputs above; `/Users/glad0s/paperclip/work-products/`
  contains no TSM-5973/5974/5977 mirror or narration source.
- The upstream OpenVoice v2 instructions require its checkpoints and MeloTTS;
  its runtime cannot be honestly substituted with the stale v4 Lumen narration.

The production master must not start until the OpenVoice v2 + MeloTTS runtime,
its model checkpoints, and an approved Charon/Sam reference clip are provisioned
on the self-hosted render runner. This preserves the locked v5 text,
pronunciation dictionary, authored pauses, and the no-segmented-VO law.
