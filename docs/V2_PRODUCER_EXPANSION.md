# V2 — Course-Material Producer Expansion

> Decision logged 2026-04-30 from NotebookLM tooling research.

## V1 (current scope)

Two agents handle all course-material production:
- **content-author** — prose chapters + blog drafts
- **slide-audio-producer** — slides + audio + mind-maps + flashcards + briefing PDFs (via `notebooklm-py` primary, `open-notebook` fallback)
- **voice-producer** — short-form custom voice (intros, outros, callouts)

This is sufficient for V1 because Vardaan has a paid NotebookLM account, and `notebooklm-py` exposes the full Studio suite.

## V2 (deferred)

Split course-material producers into 4 specialized agents to maximize quality + independence:

### V2 agents (new)

#### infographic-producer
- **Tool**: Flux.1-dev (Apache 2.0; superior text rendering vs DALL-E 3 for chart labels; runs on Replicate or self-hosted)
- **Output**: PNG/SVG infographics for course chapters; data-vis figures
- **Adapter**: opencode_local with `openrouter/black-forest-labs/flux.1-dev` (verify slug at import time)
- **Why split out**: NotebookLM's infographic output is template-based; for branded, on-message Academy infographics, a dedicated Flux producer wins on consistency

#### video-producer (UPDATED 2026-04-30 from video-tooling research)
- **Tool stack** (locked):
  - **Remotion** (PRIMARY rendering spine; React/TS, 44k⭐, CLI-first, $0.01/render + $100/mo Automator) — narration-over-screens (slides + diagrams + code + transitions)
  - **Manim CE** (math/algorithm scenes, MIT) — composited into Remotion as `<Video />` components
  - **MuseTalk 1.5** (talking-head intros only, MIT, runs on single GPU, real-time 30fps) — for optional 30-sec course welcome
  - **Kokoro / Cartesia** (TTS) — voice tracks (NEVER ElevenLabs)
- **Tools rejected** (with rationale):
  - HeyGen / Synthesia / D-ID / Tavus — too avatar-centric, recurring per-minute cost; OK as fallback for "polished welcome" only
  - Sora 2 / Veo 3.1 — cinematic, wrong shape for screen-based explainers; expensive ($0.10/sec+)
  - Wan 2.5+ / HunyuanVideo / CogVideoX / AnimateDiff — filmic clips, not lectures
  - Seedance 2.0 — keep noted as $0.05/clip B-roll cutaway option only
  - Motion Canvas — runner-up to Remotion; choose Remotion for ecosystem maturity
- **Output**: Narration-over-screens course videos + optional 30-sec talking-head intros
- **Adapter**: process or claude_local with Bash orchestration of `npx remotion render --props <json>`
- **Pipeline**:
  ```
  content-author → markdown + slide JSON
    → Remotion composition (screens/diagrams/code/transitions)
    → Kokoro/Cartesia TTS narration track
    → MuseTalk talking-head intro (30 sec, optional)
    → Remotion concat → MP4 → vault + academy.kspl.tech
  ```
- **De-risk action (V1.5 prep, do this week)**: prototype a Remotion scaffolding repo with `<CourseVideo>` composition, Mermaid + Shiki components, props.json schema matching Content Author's output, and CLI render command Paperclip can invoke. Keeps V1 unblocked while making V1.5 a flip-the-switch release.
- **Bottom line cost**: 3 of 4 tools are MIT/Apache; Remotion's $100/mo Automator scales linearly with output

### V2 agents (existing, refined scope)

#### slide-audio-producer (V2 scope)
- Keeps NotebookLM-driven outputs only: audio overviews + slide decks + mind-maps + flashcards + briefing PDFs
- Hands off `infographics` field of course chapters to infographic-producer
- Hands off `video_intro` field of courses to video-producer

#### content-author (unchanged)
- Continues to handle prose chapters + blogs

## Cost impact (V2)

| Producer | V1 monthly | V2 monthly |
|---|---|---|
| slide-audio-producer | $20 | $15 |
| infographic-producer (NEW) | – | $20 (Flux + Replicate) |
| video-producer (NEW) | – | $40 (HunyuanVideo on Replicate; ~$0.30/min) |
| **Δ total** | – | **+$55/mo** (within $680 ceiling) |

## Trigger to enact V2

Any of:
- A core course consistently underperforms because its visuals are weak (infographics, video) — verified by SEO Optimizer's weekly Search Console pull
- Vardaan explicitly requests video-led courses for differentiation
- We observe NotebookLM's quality on slides/infographics is consistently 80%+ but not 95%+ for our brand

## Reading order to enact V2

1. Hire infographic-producer (run company-creator skill on the existing `learnova-academy` package; add agent + skill + budget)
2. Smoke-test on 1 course chapter
3. Hire video-producer (same path)
4. Smoke-test
5. Update CEO's daily-triage skill to optionally route to infographic + video producers per ticket type

## What to do in V1 in the meantime

- Author every course assuming NotebookLM-style infographics (template-based) until V2 lands
- Track in `vault/retrospectives/_company/` any course where infographic quality was a pain point — that's the trigger evidence
- Skip dedicated video-led courses; lean into prose + audio + slides

## Sources backing this decision

- [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) — 22.9k stars, MIT, v1.8.5
- [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py) — 12.1k stars, MIT, v0.3.4
- [NotebookLM Studio (Google blog)](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/)
- [Cloudflare 2026 headless detection](https://nerdbot.com/2026/04/28/bypass-cloudflare-turnstile-in-2026-headless-browser-scaling-and-deep-dive-into-native-chromium-patching/)
- [browser-use](https://github.com/browser-use/browser-use) — 91.2k stars (kept in our toolchain for non-Google use cases)
