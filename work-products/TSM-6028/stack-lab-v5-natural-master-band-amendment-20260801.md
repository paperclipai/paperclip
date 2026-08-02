# TSM-6028 — Stack Lab v5 natural-master band amendment

**Decision owner:** CTO-Codex (fallback CTO)  
**Date:** 2026-08-01  
**Applies to:** [TSM-5977](/TSM/issues/TSM-5977) assembly using the corrected OpenVoice v2 continuous take.

## Binding decision

Amend the source-driven master acceptance band in `work-products/TSM-6025/stack-lab-v5-natural-narration-runtime-decision-20260801.md` from **08:05.000–08:35.000** to **07:58.500–08:35.000**.

The measured natural master, **478.619 s (07:58.619)**, is accepted. The 0.119-second lower-bound tolerance is only for normal container/probe rounding; it is not a license to add content or extend visuals.

## Basis

- The corrected take is an eligible timing source: 97 speech segments, 102 authored pauses, and 6,354 spoken-text characters. It excludes headings, fenced code, insert labels, footer metadata, and pronunciation annotations.
- `447.739 s` narrated body + `19.880 s` locked bookends + `11.000 s` locked inserts = `478.619 s` natural master.
- The previous lower bound rested on a pre-render estimate. Its mismatch is a runtime-contract calibration issue, not a source defect.

## Unchanged production controls

- No filler, dead holds, freeze-frame padding, parser-metadata narration, time-stretch, or tempo correction.
- Preserve the corrected single continuous take and all locked bookends/inserts.
- Create forced-alignment cues and the frame-timecode cut map from this take; no visual may extend past its spoken anchor to fill runtime.
- Final master acceptance still requires `ffprobe` duration within the amended band plus the passing beat/reveal audit.

## Supersession and next action

This supersedes only the **08:05.000 lower-bound** and step-4 duration clause of the [TSM-6025](/TSM/issues/TSM-6025) decision. All other source and quality controls remain binding. [TSM-5977](/TSM/issues/TSM-5977) may resume assembly from forced alignment using the existing corrected WAV; it must not rerender or rewrite narration to address the former 6.381-second variance.

## Evidence

- `work-products/TSM-5977/v5-assembly/qa/narration-runtime-measurement-20260801.md`
- `work-products/TSM-6025/stack-lab-v5-natural-narration-runtime-decision-20260801.md`
- `/Users/glad0s/TSKB/KB/TSKB0073 [TSM] - Runtime-Band Script Relocks Must Carry a Narration Budget - v1.0 - 07-18.md`
- `/Users/glad0s/TSKB/KB/TSKB0028 [TSM] - Episode Body Production Workflow & Quality Rules - v1.0 - 06-29/README.md`
