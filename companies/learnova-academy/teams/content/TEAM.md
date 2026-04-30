---
schema: agentcompanies/v1
kind: team
slug: content
name: Content
description: Course outlines, MDX chapter drafts, MCQ + free-form quizzes, slide decks (NotebookLM), and voice-overs (Kokoro/OmniVoice). Every output passes G0 review before going to CEO alignment.
manager: ../../agents/chief-content/AGENTS.md
includes:
  - ../../agents/content-author/AGENTS.md
  - ../../agents/content-reviewer/AGENTS.md
  - ../../agents/slide-audio-producer/AGENTS.md
  - ../../agents/voice-producer/AGENTS.md
tags:
  - team
  - content
---

# Content team

Pipeline within hub-and-spoke: Chief Content receives the CEO's ticket, dispatches Author + Slide+Audio + Voice **in parallel** for new courses, then converges all three at the **Reviewer** (G0) before sending to CEO G3 + Vardaan G4.

## Workflow

```
CEO ticket: "New course on <topic>"
  ↓
Chief Content
  ↓
parallel:
  ├── content-author        → vault/courses/<slug>/draft.md (MDX)
  ├── slide-audio-producer  → vault/courses/<slug>/slides.pptx + audio.mp3
  └── voice-producer        → vault/courses/<slug>/voiceover-<idx>.mp3
  ↓
content-reviewer (G0)  ✅ or ✏️
  ↓
[on ✏️: back to producers]
  ↓
[on ✅] CEO G3 → Vardaan G4 → publish via learnova-publish adapter
```

For **course updates** and **blog posts**, only Author + Reviewer run (no slide/voice).

## Models per role

- **Content Author** — Gemini 2.5 Flash (cheap, fast, big context, good at structured writing) via `opencode_local → openrouter/google/gemini-2-5-flash`
- **Content Reviewer** — Sonnet 4.6 via `claude_local` (reviewer prompt; "audit don't propose; demand evidence")
- **Slide+Audio Producer** — Sonnet 4.6 driving `notebooklm-py` for slides + audio overviews
- **Voice Producer** — Sonnet 4.6 generating scripts; runs Kokoro (CPU-local) or OmniVoice (premium) for TTS. NO ElevenLabs — explicitly excluded.

## Schema-safe authoring

Every Author output validated by Zod before reaching the Reviewer. Schema is defined in `learnova-tc/convex/agentApi.ts` (Phase 1.4):

```ts
const courseSchema = z.object({
  title: z.string().min(10),
  description: z.string().min(20),
  modules: z.array(moduleSchema).min(1),
  vendor_tag: z.enum(['anthropic', 'openai', 'google', ...]),
  content_type: z.enum(['video', 'pdf_document', 'interactive', 'mixed']),
  ...
});
```

Author writes vault MDX → validates schema → writes Convex draft via the agent HTTP action. Schema rejection bounces back to Author with the validator error.

## Out-of-bounds for V1

- ElevenLabs TTS (excluded)
- Auto-publish without G4 (always require human approval for first-time courses; V1.5 may auto-publish small deltas)
- Multi-language content (English only V1; Hindi + Spanish in V2)
