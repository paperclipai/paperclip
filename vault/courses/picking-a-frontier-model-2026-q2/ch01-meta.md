---
chapter_path: vault/courses/picking-a-frontier-model-2026-q2/01-dimensions-that-matter.md
assets_generated:
  - ch01-slides.pptx
  - ch01-audio.mp3
tool: cartesia (audio) + python-pptx (slides)
notebooklm_status: not available in environment
open_notebook_fallback: not applicable (no podcast endpoint on local instance)
duration_audio_sec: 186
slide_count: 13
flashcard_count: 0
produced_at: 2026-04-30T16:25:00Z
g0_passed_at: 2026-04-30T11:17:47Z
inspection_passed_at: 2026-04-30T11:20:00Z
audio_lufs: -16
audio_kbps: 128
audio_hz: 44100
voice_id: 4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991
voice_name: George - Composed Consultant (Cartesia)
script_source: vault/courses/picking-a-frontier-model-2026-q2/voiceover-01.md
script_words: 486
---

## Production notes

- `notebooklm-py` not installed in environment; no `$PATH` entry.
- Local open-notebook (port 5055) has no `/api/podcasts` endpoint — audio-only fallback not viable.
- Used **Cartesia API** (`sonic-2` model, George voice) directly for audio generation — permitted by `CLAUDE.md` ("Use Kokoro / OmniVoice / Cartesia / Chatterbox") and explicit in issue DOD ("via Kokoro/Cartesia, NOT ElevenLabs").
- Slides built with **python-pptx** from chapter source content — no content invented; all text derived from `01-dimensions-that-matter.md` and `voiceover-01.md`.
- Audio normalized to −16 LUFS via `ffmpeg loudnorm`.
- Audio duration (186s / 3.1 min) is shorter than the notebooklm-py dual-narrator 9–12 min target; this is a tool-availability constraint, not a content gap. The DOD does not specify a minimum duration.

## Inspection results (G0-passed revision)

| Check | Result | Notes |
|---|---|---|
| Slide count ≥ 6 | ✅ 13 slides | |
| 5 production dimensions covered | ✅ | Slides 6–10, one per dimension |
| 3 deprioritized benchmarks covered | ✅ | Slides 3–4 (MMLU, HumanEval, GPQA) |
| First slide titled correctly | ✅ | "PICKING A FRONTIER MODEL · 2026 Q2 / Chapter 1" |
| Final slide has CTA | ✅ | Slide 13: "Try it next → Chapter 2" |
| Audio format | ✅ | Cartesia (not ElevenLabs), MP3 128kbps |
| Audio loudness | ✅ | −16 LUFS |
| Slides contain unverified G0 claims | ✅ | None — context-window specs and HELM stat were body-text only |

## G0 review advisory (for G3/G4)

- OpenAI models URL (platform.openai.com/docs/models): verify live before publish
- HELM 15–25pp production gap statistic: verify against current HELM tool-use leaderboard
- `editorial-team` author record: verify exists in learnovaBeast `src/lib/authors.ts`
