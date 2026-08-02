# TSM-6025 — Stack Lab v5 natural-narration runtime decision and beat map

**Decision owner:** CTO-Codex (fallback CTO)  
**Date:** 2026-08-01  
**Applies to:** TSM-5977 production assembly. This supersedes the fixed
15:30–15:45 / 15:37.88 runtime requirement in
`work-products/TSM-6019/stack-lab-v5-runtime-decision-timing-map-20260801.md`.
It does not change the approved v5 narration, visual treatments, on-screen
copy, locked assets, or beat-level reveal requirements in TSM-5973.

## Binding decision

Use the authored v5 narration at its natural OpenVoice v2 pace. Do **not**
expand it with filler, insert dead holds, time-stretch the audio, or retain
parser metadata as narration merely to reach a previous duration target.

The accepted master is now **08:05–08:35**, with an expected master of about
**08:20** from first intro frame to final outro frame. Its duration is:

`corrected-parser narration body + the two locked 5 s / 6 s inserts + 19.88 s locked bookends`.

The final acceptance value is the `ffprobe` duration of that source-driven
assembly. It must be in the stated band and the forced-alignment cut map must
show every spoken reveal at its matching narration phrase. This replaces the
unachievable 15:37.88 target.

## Why this replaces TSM-6019

- The earlier 15:37.88 map was a duration arithmetic correction to the
  *old visual map*, not a narration-budgeted source decision.
- The only recorded OpenVoice v2 render was invalid: it produced a
  485.471-second WAV while narrating headings, fenced code, insert labels,
  and footer metadata. It is diagnostic evidence only, not an eligible timing
  source.
- The corrected parser now emits 97 speech segments, 102 authored pauses, and
  6,354 spoken-text characters, excluding those non-speech elements. The
  produced body will be shorter than the invalid WAV and cannot naturally
  synchronize to a 15:38 master.
- TSKB0028 forbids time-stretch/freeze-padding; TSKB0073 requires the runtime
  contract to arise from a usable narration budget rather than padding.

## Locked insert and bookend semantics

1. Intro: `01-channel-intro-v1.mp4`, additive, **9.94 s**, before Beat 1.
2. Beat 24: `03-mid-cta-bump-v1.mp4`, **5.00 s**, replacing the former
   15-second CTA slot. Its quoted copy is not fed to OpenVoice.
3. Beat 33: filled derivative of `04-ad-lead-magnet-slot-v1.mp4`, **6.00 s**,
   replacing the former 15-second lead-magnet slot. Its quoted copy is not
   fed to OpenVoice.
4. Outro: `02-channel-outro-signoff-v1.mp4`, additive, **9.94 s**, after
   Beat 33.

## Beat-to-narration map (v6)

This is the implementation map. Unlike the invalid clock map, `Narration
anchor` is a source segment range in the corrected parser output; exact frame
timecodes are produced by forced alignment of the single continuous take. No
visual may be extended past its associated anchor to fill time.

| Beat | Narration anchor / slot | Treatment inherited from TSM-5973 | Required sync |
|---|---|---|---|
| Intro | locked asset | locked intro | 00:00–00:09.94 |
| 1 | Hook: “Every push…” through “waiting” | stat-card | 8:42 before “forty-two seconds” |
| 2 | Hook: “That is how long…” through node pipeline | screen-cap | 8m 42s on exact spoken claim |
| 3 | Hook payoff: “By the end…” | motion-graphic | 8:42 → 1:12 builds on phrase |
| 4 | “Let me show…” | b-roll transition | no hold beyond anchor |
| 5 | “Here is the GitHub Actions timeline” through three stages | screen-cap | each duration on phrase |
| 6 | npm + Docker total-cost explanation | motion-graphic | 7m 26s on phrase |
| 7 | runner-memory explanation | progressive-list | one clause per reveal |
| 8 | 20% / 80% push explanation | stat-card | 80% on phrase |
| 9 | “Fix one…” | chapter slide | section transition |
| 10 | bad cache-key explanation | code-reveal | `github.sha` red before claim |
| 11 | fixed hashFiles / restore-keys explanation | code-reveal | line-by-line on phrase |
| 12 | npm 2:17 → 4s | stat-card | both figures visible ≥3 s while spoken |
| 13 | fix-one timeline result | motion-graphic | 8:42 → 6:25 on phrase |
| 14 | “Fix two…” | chapter slide | section transition |
| 15 | bad Dockerfile / layer invalidation | code-reveal | COPY cascade builds on clauses |
| 16 | fixed Dockerfile ordering | code-reveal | each COPY/RUN on mention |
| 17 | cached build-log result | screen-cap | CACHED 0.0s legible on phrase |
| 18 | 5:09 → 1:20 / 2:55 result | motion-graphic | numbers on phrase |
| 19 | “Fix three…” | chapter slide | section transition |
| 20 | repeated-build tax | motion-graphic | show ×3 before solution |
| 21 | build-once YAML walkthrough | code-reveal | jobs appear as narrated |
| 22 | “Build once. Pull twice.” | motion-graphic | 12s on phrase |
| 23 | 1:12 pipeline result | stat-card | result on phrase |
| 24 | locked CTA asset | insert | exactly 5.00 s; not narrated |
| 25 | “Three quick additions…” | chapter slide | section transition |
| 26 | BuildKit addition | slide | parallel visual on “parallel” |
| 27 | multi-stage 800MB → 60MB | stat-card | numbers on phrase |
| 28 | bottleneck-finding method | screen-cap | longest step and cache result on phrases |
| 29 | recap “Before…” | stat-card | 8:42 visual bookend |
| 30 | three-change recap | progressive-list | zero pre-loading |
| 31 | “After…” / 1:12 / 7× | stat-card | 1:12 then 7× on phrases |
| 32 | 10+ min / under 2 min fork | slide | both paths on matching clauses |
| 33 | locked lead-magnet asset | insert | exactly 6.00 s; not narrated |
| 34 | locked outro asset | insert | final 9.94 s |

## Production handoff gates

1. Run the corrected parser test first. It must retain the 97 speech segments
   and 102 authored pauses and exclude headings, fenced code, inserts, and
   footer metadata.
2. Render one continuous OpenVoice v2 take of those segments only, preserving
   the authored pause values and pronunciation dictionary.
3. Generate forced-alignment cues for the table above, then create the
   frame-timecode cut map. This is the authoritative execution sidecar; it
   must be attached with the master rather than guessed beforehand.
4. Assemble the two replacement inserts and additive bookends. Accept only
   an 08:05–08:35 `ffprobe` master and a passing beat/reveal audit.
5. If the corrected take falls outside the band, stop and open a new source
   relock: do not correct it with padding or tempo changes.

## Evidence and provenance

- `work-products/TSM-5977/v5-assembly/logs/openvoice-v2-render.log`
- `work-products/TSM-5977/v5-assembly/qa/narration-timing-preflight-20260801.md`
- `work-products/TSM-5977/v5-assembly/README.md`
- `work-products/TSM-6019/stack-lab-v5-runtime-decision-timing-map-20260801.md`
- `work-products/TSM-5973/script-v5.md` and `script-to-visual-timing-map.md`
- `/Users/glad0s/TSKB/KB/TSKB0073 [TSM] - Runtime-Band Script Relocks Must Carry a Narration Budget - v1.0 - 07-18.md`
- `/Users/glad0s/TSKB/KB/TSKB0028 [TSM] - Episode Body Production Workflow & Quality Rules - v1.0 - 06-29/README.md`
