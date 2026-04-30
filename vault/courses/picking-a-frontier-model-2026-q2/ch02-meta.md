---
chapter_path: vault/courses/picking-a-frontier-model-2026-q2/02-tool-use-determinism-benchmark.md
issue: KOE-62
produced_at: 2026-04-30T16:30:00Z
assets_generated:
  - ch02-slides.pptx
assets_blocked:
  - ch02-audio.mp3
tool: python-pptx (slides) / audio-blocked
slide_count: 12
slide_file: vault/courses/picking-a-frontier-model-2026-q2/ch02-slides.pptx
duration_audio_sec: null
audio_blocked_reason: >
  notebooklm-py not installed; open-notebook running but has no provider
  credentials configured (all providers show false in /api/credentials/env-status);
  kokoro-onnx dep conflict (onnxruntime unavailable for Python 3.9 env);
  CARTESIA_API_KEY empty in .env; OPENAI_API_KEY empty.
status: partial — slides shipped, audio blocked pending Chief Content decision
escalation_owner: chief-content
escalation_action: >
  Configure one of: (1) notebooklm-py + Vardaan's NotebookLM credentials,
  (2) CARTESIA_API_KEY in .env and re-run, (3) OPENAI_API_KEY in open-notebook
  so podcast generation works. Then re-trigger KOE-62 for audio-only re-run.
notes:
  - Chapter frontmatter says status:draft-for-review (not g0-passed) — dispatched
    by Paperclip issue KOE-62 as authoritative G0 signal; flagged for follow-up.
  - Voiceover script already exists at voiceover-02.md (285s, 450 words) but is
    too short (DOD = 8-12 min); will need expansion before TTS synthesis.
  - PPTX slide quality: 12 slides covering all DOD topics (10x3x5 design,
    results table, pipeline math, failure modes, GPT-5.5 strict schema finding,
    interpretation guide, hands-on exercise, Try-it-next CTA).
---
