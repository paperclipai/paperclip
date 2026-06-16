# Media Output Standard

## Goal
The organisation must produce ready-to-upload media packs. Text-only output is not enough.

## Required Output Pack
Every completed media job should produce:

- README.md
- media_pack.json
- final_reel.mp4
- cover image
- voiceover audio
- subtitle file or subtitle text
- caption.txt
- hashtags.txt
- qa_report.md
- learning_note.md

## Reel Standard
Default reel format:

- 9:16 vertical
- 20 to 35 seconds
- strong hook in first 2 seconds
- 4 to 6 scenes
- readable overlay text
- clear voiceover
- safe visual style
- page identity or watermark
- human approval required before upload

## Scene Standard
Each scene must include:

- durationSec
- overlayText
- visualDirection
- voiceoverText
- scenePurpose

## Caption Standard
Caption must include:

- emotional first line
- short context
- mature insight
- comment prompt
- relevant hashtags

## QA Standard
QA report must include:

- Brand fit
- Niche drift check
- Safety note
- Originality note
- Upload readiness
- Manual approval status

## Media Worker Rule
Paperclip should not run heavy media rendering on the same server as the dashboard.

The correct pattern is:

Paperclip -> Remote Media Worker -> Output Links -> Paperclip Task -> Human Approval.

## Failure Standard
If media render fails, the system must still return:

- text pack
- cover
- error log
- retry suggestion
- learning note

A failed render must not crash the Paperclip dashboard.
