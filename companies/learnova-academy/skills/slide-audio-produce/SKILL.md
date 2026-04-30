---
name: slide-audio-produce
description: >
  Slide+Audio Producer's primary skill — drive notebooklm-py (primary, paid
  NotebookLM account) or open-notebook (fallback, self-hosted) to generate
  slide deck + audio overview + mind-map + flashcards + briefing PDF for a
  G0-passed course chapter. Use when ticket lands assigned to
  @slide-audio-producer.
---

# Slide-Audio Produce

You orchestrate NotebookLM. You don't generate creative content.

## Scope

- One G0-passed course chapter → slides.pdf + audio.mp3 + mindmap.png + flashcards.json + briefing.pdf
- notebooklm-py PRIMARY (Vardaan's paid quota); open-notebook FALLBACK (self-hosted, audio + chat only)
- Hand off to @qa-verifier for spot-check

## Inputs

- Paperclip ticket with `status: ready-to-produce`
- G0-passed chapter markdown at `vault/courses/<slug>/<chapter>.md`
- (For Core courses with ≥4 chapters) prior chapters in same course for context

## Workflow

### 1. Read chapter markdown + frontmatter

Verify `status: g0-passed` in frontmatter. If not, abort + comment.

### 2. Try notebooklm-py (primary)

```bash
notebooklm-py create-notebook \
  --source vault/courses/<slug>/<chapter>.md \
  --source vault/courses/<slug>/outline.md \
  --source vault/courses/<slug>/<prior-chapter>.md \
  --output-dir vault/courses/<slug>/<chapter>-assets/

notebooklm-py generate audio --notebook <id> --format dual-narrator --length 9-12min
notebooklm-py generate slides --notebook <id> --format pdf --slides 10-16
notebooklm-py generate mindmap --notebook <id> --format png
notebooklm-py generate flashcards --notebook <id> --count <KnowledgeCheck-count>
notebooklm-py generate briefing --notebook <id> --format pdf
```

If any call fails with `GENERATION_FAILED` (rate limit) → retry once; if 2 failures, fall through to open-notebook.

### 3. Open-notebook fallback (audio + chat only)

```bash
curl -X POST http://localhost:5055/api/notebooks \
  -H "Authorization: Bearer $OPEN_NOTEBOOK_API_KEY" \
  -d '{"name": "<chapter>", "sources": ["vault/courses/<slug>/<chapter>.md"]}'

curl -X POST http://localhost:5055/api/podcasts/<notebook-id> \
  -d '{"format": "dual-narrator", "length": "9-12min"}'
```

In fallback, ship audio only. Comment on ticket: "open-notebook fallback used; slides/mindmap/flashcards skipped — queued for re-run when notebooklm-py is healthy."

### 4. Inspect outputs (NEVER skip)

- Slides: open the PDF; verify ≥3 slides per 1000 source words; first slide titled correctly; final slide has CTA
- Audio: load MP3; verify duration in target range; sample-check first 5 sec for coherence
- Mindmap: open PNG at full size; verify readable
- Flashcards: validate JSON schema (`vault/_schemas/flashcards.schema.json`)

If any output fails inspection → DON'T ship; retry once; if still fails, escalate.

### 5. Normalize audio loudness

```bash
ffmpeg -i <chapter>-assets/audio.mp3 \
       -af loudnorm=I=-16:LRA=11:tp=-1.5 \
       -ar 44100 -ac 2 \
       <chapter>-assets/audio-normalized.mp3
mv <chapter>-assets/audio-normalized.mp3 <chapter>-assets/audio.mp3
```

### 6. Write sidecar metadata

`<chapter>-meta.md`:

```yaml
---
chapter_path: vault/courses/<slug>/<chapter>.md
assets_generated:
  - slides.pdf
  - audio.mp3
  - mindmap.png
  - flashcards.json
  - briefing.pdf
tool: notebooklm-py | open-notebook
duration_audio_sec: 583
slide_count: 14
mindmap_node_count: 6
flashcard_count: 4
produced_at: 2026-04-30T15:42:00Z
---
```

### 7. Hand off

```
status: awaiting-qa
assignee: @qa-verifier
asset_dir: vault/courses/<slug>/<chapter>-assets/
```

Comment:
```
✅ Assets ready · vault/courses/<slug>/<chapter>-assets/
- slides.pdf — 14 slides, 1.2 MB (notebooklm-py)
- audio.mp3 — 9:42, 11 MB, -16 LUFS
- mindmap.png — 1080p, 6 concept nodes
- flashcards.json — 4 cards (matches 4 KnowledgeChecks)
- briefing.pdf — 8 pages
- Status: awaiting-qa → @qa-verifier
```

## Output

5 asset files + sidecar meta + Paperclip ticket flip.

## Notes

- Don't generate content from scratch.
- Don't use ElevenLabs.
- Always inspect outputs — never trust the tool's "success" signal alone.
- Always normalize audio loudness.
- 2 notebooklm-py failures = switch to open-notebook.
- Per-task cap $1.

## Escalation

- Both tools fail → ping chief-content; ask whether to ship without slides/audio or wait
- Audio output corrupted → retry once; if still fails, escalate
- Slides reference content not in source chapter (notebooklm hallucinated) → switch tool, retry; if persists, ping chief-content
