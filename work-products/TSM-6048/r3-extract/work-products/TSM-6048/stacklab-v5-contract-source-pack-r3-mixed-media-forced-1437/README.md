# Stack Lab v5 contract source pack — R3 mixed-media reissue (TSM-6048)

Governed input bundle for `stacklab-v5-render`.

## Contents
- `audio/narration.wav` — locked continuous OpenVoice v2 body (SHA ff790ce9…)
- `script/script-v5.md` — locked script
- `transcript/spoken.txt` — the exact 1,437-word recovered production forced-alignment transcript; renderers must consume this file, never parse the production Markdown
- `script/script-to-visual-timing-map.md` — reconciled v6 natural-narration map
- `alignment.json` — WhisperX forced alignment recovered from failed run 30721295295 (1,437 words)
- `cut-plan.json` — 34 ordered non-overlapping word ranges + relative sources; locked TSM-5974 insertion semantics retained
- `visuals/beat-01.mp4` … `beat-34.mp4` — 31 classified mixed-media moving treatments + 3 locked inserts
- `overlays/` — locked templates + overlay stills retained for audit
- `manifest.json` — SHA-256 / duration / provenance
- `qa/validation-report.md` — duration, source-type and contact-sheet validation
- `qa/visual-types.json` / `qa/broll-provenance.json` — beat classifications and 111 moving-shot source records
- `qa/contact-sheet/contact-sheet-34-beats.jpg` — pre-render visual QA sheet

## Master arithmetic
447.738792s body + 5.000s Beat 24 + 6.000s Beat 33 + 9.940s Beat 34 = **478.618792s**

Dispatch target: `stacklab-v5-render`, Mini-first. This artifact may not be accepted against the superseded 15:30–15:45 master band without an explicit board band amendment or new authored narration; its measured master is 478.618792s.

## Transcript contract (TSM-6047)

`transcript/spoken.txt` matches the recovered `alignment.json` exactly: 1,437 source
rows and an equivalent normalized sequence. A renderer must validate both properties
before starting WhisperX or ffmpeg; no fallback Markdown parser is permitted.
