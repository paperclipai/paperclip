# Stack Lab v5 corrected OpenVoice runtime measurement — 2026-08-01

## Result: source relock required; assembly not started

The corrected-parser continuous OpenVoice v2 body render completed successfully:

- Audio: `../audio/stack-lab-v5-body-openvoice-v2-corrected.wav`
- Renderer log: `../logs/openvoice-v2-corrected-render.log`
- `ffprobe` body duration: **447.739 s** (07:27.739)
- Parser test: **97** speech segments; **102** authored pauses; **6,354** spoken-text characters.
- WAV: 24 kHz, mono.

The parser test also rejects metadata narration: Markdown headings, fenced code,
CTA/lead-magnet slots, and dictionary annotations (for example, the table note
`(two letters)`) cannot enter the speech stream.  The pronunciation values used
for CI and npm are `C-I` and `N-P-M`, respectively.

## Runtime arithmetic

| Component | Seconds |
| --- | ---: |
| Corrected narrated body | 447.739 |
| Locked intro + outro | 19.880 |
| Locked mid CTA + lead-magnet inserts | 11.000 |
| Natural assembled master | **478.619 (07:58.619)** |
| Binding acceptance band from TSM-6025 | **485–515 (08:05–08:35)** |
| Shortfall to lower bound | **6.381** |

`478.619 s` is outside the approved band. The design decision explicitly says
to stop and open a source relock when this occurs; no hold, time-stretch,
metadata narration, or freeze-frame padding is permitted. Therefore no visual
assembly, forced-alignment map, captions, or master was created from this take.

## Reusable correction applied

`/Users/glad0s/scripts/openvoice-stacklab-v2.py` now parses only the quoted
phonetic value in the script's pronunciation table. It no longer renders table
annotations such as `"C-I" (two letters)` as speech. The focused parser test
asserts the 97/102 structural counts and rejects non-speech production markup.

## Decision needed

CTO must issue a new runtime/source decision for the 6.381-second variance:
either amend the natural-pace acceptance band to encompass this measured
source-driven master, or provide revised narrated source text that naturally
adds the needed spoken content. This implementer must not choose either route
unilaterally.
