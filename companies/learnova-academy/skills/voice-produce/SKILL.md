---
name: voice-produce
description: >
  Voice Producer's primary skill — drive Kokoro CLI (primary, MIT, local CPU) or
  OmniVoice (premium fallback) to synthesize short-form custom-voiced audio
  in Nova brand voice. Use when ticket lands assigned to @voice-producer.
---

# Voice Produce

You voice scripts. You don't write them.

## Scope

- One script (≤500 words) → one MP3 file
- Kokoro PRIMARY (free, local Mac CPU); OmniVoice FALLBACK (paid, premium quality)
- Brand voice = **Nova** (default)
- Hand back to caller (Slide+Audio Producer or Chief Content)

## Inputs

- Paperclip ticket with script text + target vault path
- Voice preset (default `nova-warm`; ticket may override)
- Speed (default 1.0x)

## Workflow

### 1. Validate inputs

- Script length 50-500 words?
- Target path under `vault/courses/` or `vault/audio/` or `vault/blogs/`?
- Voice preset is one of {nova-warm, nova-bright, nova-serious}?

If any fails → BLOCK + ask ticket for clarification.

### 2. Try Kokoro (primary)

```bash
kokoro --text "$(cat /tmp/script.txt)" \
       --voice nova-warm \
       --speed 1.0 \
       --output /tmp/voiceover-raw.mp3
```

If exit code != 0 OR output file <10KB → retry once. If still fails → fall through to OmniVoice.

### 3. OmniVoice fallback (premium)

```bash
omnivoice synthesize \
  --text "$(cat /tmp/script.txt)" \
  --voice nova-warm \
  --speed 1.0 \
  --output /tmp/voiceover-raw.mp3
```

Document fallback in sidecar metadata.

### 4. Normalize audio loudness

```bash
ffmpeg -i /tmp/voiceover-raw.mp3 \
       -af loudnorm=I=-16:LRA=11:tp=-1.5 \
       -ar 44100 -ac 2 \
       <target-path>/voiceover-<idx>.mp3
```

### 5. Inspect (NEVER skip)

- Load the MP3
- Play first 5 sec → confirm coherent + correct voice
- Verify duration matches script length (±10%) at requested speed

If fails inspection → retry once; if still fails, escalate.

### 6. Write sidecar metadata

`<target-path>/voiceover-<idx>-meta.json`:

```json
{
  "tool": "kokoro" or "omnivoice",
  "voice_preset": "nova-warm",
  "duration_sec": 47,
  "lufs": -16.0,
  "bitrate_kbps": 128,
  "produced_at": "2026-04-30T15:45:00Z",
  "script_word_count": 142
}
```

### 7. Hand back

Comment on Paperclip ticket:
```
✅ voiceover-<idx>.mp3 · <target-path>/
- 47 sec @ -16 LUFS, 128kbps, kokoro voice "nova-warm"
- Script 142 words; spoken at 1.0x
- Hand-back → @<requesting-agent>
```

Flip status to whatever the parent ticket expects (typically `slide-audio-resume` or `content-resume`).

## Output

The MP3 file + sidecar JSON + Paperclip ticket flip.

## Notes

- **No ElevenLabs. Ever.** Hard rule.
- Always normalize loudness — never ship raw TTS.
- Always inspect — load + play 5 sec.
- Don't modify the script. Caller provides exact text.
- Per-task cap $0.50. Most Kokoro runs are free; cap mainly bounds OmniVoice fallbacks.

## Escalation

- Kokoro + OmniVoice both fail → ping chief-content; ask whether to ship without voiceover
- Voice quality below brand threshold (judged by 10-sec sample) → escalate; chief-content may swap to OmniVoice
