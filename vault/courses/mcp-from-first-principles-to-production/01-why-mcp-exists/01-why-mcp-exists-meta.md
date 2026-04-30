---
chapter: 1
course_slug: mcp-from-first-principles-to-production
chapter_slug: 01-why-mcp-exists
assets_generated:
  - ch01-slides-v2.pptx
  - ch01-audio-v2.mp3
tool: open-notebook
tool_fallback_reason: "notebooklm-py not yet wired; open-notebook E2E validation run"
duration_audio_sec: 579
slide_count: 19
audio_bitrate_kbps: 192
audio_lufs: -16
produced_at: "2026-04-30T16:48:00Z"
open_notebook_episode_id: "episode:06hsdir57e86s967ruw0"
open_notebook_notebook_id: "notebook:sgfi39gphpuythrv46cy"
status: awaiting-qa
---

# Ch01 Production Meta

## Assets

| Asset | Size | Notes |
|-------|------|-------|
| `ch01-slides-v2.pptx` | 218 KB | 19 slides, pptxgenjs; first slide = chapter title; last slide = "Try it next" CTA |
| `ch01-audio-v2.mp3` | 14 MB | 9:39, 192 kbps, normalized to -16 LUFS; dual-narrator (Dr. Alex Chen + Jamie Rodriguez) via OpenAI gpt-4o-mini-tts |

## Slide outline (19 slides)

1. Title — "Why MCP Exists: The Design Problem It Actually Solves"
2. Learning Objectives (4 objectives from chapter frontmatter)
3. Section header: The N×M Integration Problem
4. Before MCP: Every Team Wired Every Tool from Scratch
5. N×M → N+M: The Standard Protocol Solution
6. Section header: Three Alternatives That Didn't Survive Reality
7. Alternative 1: Custom REST Adapters (two-column)
8. Alternative 2: WebSocket Hub (two-column)
9. Alternative 3: OpenAPI Spec Passthrough (two-column)
10. Section header: The LSP Lineage
11. LSP → MCP: Three Borrowed Design Choices
12. Section header: Host / Client / Server Triad
13. Three Distinct Roles — Not Two
14. The Unidirectional Constraint Is the Security Model
15. Section header: What MCP Deliberately Does NOT Solve
16. Five Problems Deferred to Higher Layers
17. Code: Minimal MCP Server (~38 lines, no SDK)
18. Key Takeaways
19. Try It Next (CTA)

## Audio segments

5 segments from open-notebook tech_discussion profile:
1. Introduction to the MCP Integration Problem
2. LSP Lineage: Shaping MCP's Design
3. Choosing JSON-RPC: The Wire Format Decision
4. What MCP Does NOT Solve: Understanding Limitations
5. Conclusion and Takeaways

## QA checklist

- [ ] Slides open in PowerPoint/LibreOffice without errors
- [ ] Slide 1 title matches chapter title exactly
- [ ] Slide 19 (last) is "Try it next" CTA
- [ ] No placeholder/lorem ipsum copy
- [ ] Audio plays in standard MP3 player
- [ ] Audio duration 8–12 min ✅ (9:39)
- [ ] Loudness normalized (−16 LUFS) ✅
- [ ] Bitrate ≥ 128 kbps ✅ (192 kbps)

## Notes

- open-notebook required manual credential + model + profile setup (first run against this instance)
- Episode profiles defaulted to non-existent `gpt-5-mini` model; updated to `gpt-4o-mini` (outline) + `gpt-4o` (transcript)
- Speaker profiles missing `voice_model` field; updated with `model:twqicci8hsae5kyznzsk` (gpt-4o-mini-tts)
- Audio content is good quality but reflects open-notebook's generative style; some nuance around N×M framing could be tighter
- Flag for notebooklm-py re-run when that adapter is wired up (will produce richer dual-narrator Studio audio)
