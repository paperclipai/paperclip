---
name: speech-synthesis-ops
description: Use when a lane needs to generate or refine spoken audio output for TSB surfaces.
---

# Speech Synthesis Ops

Use this skill when an issue needs a narrated voiceover, text-to-speech render, or script-to-audio artifact.

## Rules

- Route only deliberate voiceover work here. Bare discussion of audio lanes is not an execution request.
- Use the local Grok subscription path first. Do not switch to paid API-key flows.
- Preserve the request payload, raw provider response, headers, and final audio file under the issue's governed `work-products/<ISSUE-ID>/` path.
- Prefer MP3 output unless the card explicitly asks for something else.
- If the card names a voice, use it. Otherwise default to `lumen` for neutral explainer reads.

## Runner

Primary runner:

```bash
python3 scripts/tts/xai-oauth-tts.py \
  --text-file work-products/<ISSUE-ID>/script.txt \
  --voice lumen \
  --out work-products/<ISSUE-ID>/audio/voiceover.mp3 \
  --request-json work-products/<ISSUE-ID>/audio/request.json \
  --response-json work-products/<ISSUE-ID>/audio/response.json \
  --headers-path work-products/<ISSUE-ID>/audio/response.headers.txt \
  --provenance-json work-products/<ISSUE-ID>/audio/provenance.json
```

Inline-text variant:

```bash
python3 scripts/tts/xai-oauth-tts.py \
  --text "Short verification line." \
  --voice lumen \
  --out work-products/<ISSUE-ID>/audio/voiceover.mp3
```

## Closeout Evidence

- Cite the final audio path.
- Cite the preserved request/response provenance paths.
- If the run failed, quote the provider status and response artifact path instead of paraphrasing.
