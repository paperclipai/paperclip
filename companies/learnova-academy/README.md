# Koenig AI Academy — agent company

A Paperclip company that runs the **Koenig AI Academy** product (`academy.kspl.tech`) 24/7. 18 agents, hybrid hub-and-spoke + pipeline, hard per-agent budgets, 5-gate publish pipeline (G0 review → G1 code review → G2 QA → G3 CEO alignment → G4 human).

This package conforms to the [Agent Companies Specification](https://agentcompanies.io/specification) (`agentcompanies/v1`).

## What it does

- 06:00 IST every weekday: 4 vendor researchers (Anthropic / OpenAI / Google / community) scrape the morning's AI news in parallel
- 06:30: Research Editor synthesises into a daily brief (saved to `vault/research/_daily/`)
- 07:00: CEO reads the brief, decides what to ship today (new course, course update, blog post, UI tweak, no-action)
- Throughout the day: workers execute; chiefs gate; CEO aligns
- 18:00: CEO emails an EOD digest with G4-pending items (also surfaced in Slack/Teams + Paperclip UI)
- Mon 09:00: Weekly retrospective → SOUL changes proposed → Vardaan approves

## Org chart

```
CEO (Opus 4.7)
├── Chief Research (Sonnet 4.6)
│   ├── Researcher · Anthropic       (Grok 4.1 Fast)
│   ├── Researcher · OpenAI          (Grok 4.1 Fast)
│   ├── Researcher · Google          (Grok 4.1 Fast)
│   ├── Researcher · Community       (Grok 4.1 Fast)
│   └── Research Editor              (Sonnet 4.6)
├── Chief Content (Sonnet 4.6)
│   ├── Content Author               (Gemini 2.5 Flash)
│   ├── Content Reviewer             (Sonnet 4.6) ← G0
│   ├── Slide+Audio Producer         (Sonnet 4.6)
│   └── Voice Producer               (Sonnet 4.6 + Kokoro/OmniVoice)
├── Chief Engineering (Sonnet 4.6)
│   ├── Planner-Executor             (Opus 4.7 — plan mode)
│   ├── Code Reviewer                (Codex / GPT-5) ← G_code
│   └── QA Verifier                  (Haiku 4.5 + browser-use) ← G2
└── Chief Marketing/SEO (Sonnet 4.6)
    └── SEO Optimizer                (Sonnet 4.6)
```

| Agent | Role | Adapter | Monthly | Per-task |
|---|---|---|---|---|
| CEO | Delegates only; G3 + G4 routing | claude_local | $80 | $2 |
| Chief Research | Coordinates 4 researchers + editor | claude_local | $40 | $1 |
| Researcher · Anthropic | Anthropic news | opencode_local → OpenRouter | $20 | $0.50 |
| Researcher · OpenAI | OpenAI news | opencode_local → OpenRouter | $20 | $0.50 |
| Researcher · Google | Google AI news | opencode_local → OpenRouter | $20 | $0.50 |
| Researcher · Community | Reddit/HN/X via Grok x_search | opencode_local → OpenRouter | $20 | $0.50 |
| Research Editor | Daily brief synthesizer | claude_local | $20 | $0.50 |
| Chief Content | Owns course outline → publish | claude_local | $80 | $2 |
| Content Author | Drafts MDX courses + quizzes | opencode_local → OpenRouter | $40 | $1 |
| Content Reviewer (G0) | Audits accuracy + brand voice | claude_local | $20 | $0.50 |
| Slide+Audio Producer | Drives notebooklm-py | claude_local | $20 | $1 |
| Voice Producer | Kokoro/OmniVoice TTS | claude_local | $10 | $0.50 |
| Chief Engineering | Owns frontend + backend | claude_local | $120 | $4 |
| Planner-Executor | Plans (mode) → executes | claude_local | $60 | $2 |
| Code Reviewer (G_code) | Audit-only reviewer lens | codex_local | $30 | $0.75 |
| QA Verifier (G2) | Browser walks + tests + facts | claude_local | $20 | $0.50 |
| Chief Marketing/SEO | Distribution + GEO | claude_local | $40 | $1 |
| SEO Optimizer | Search Console + meta + sitemap | claude_local | $20 | $0.50 |
| **TOTAL** | | | **$680** | |

## Workflow patterns

| Ticket | Path through the company |
|---|---|
| Daily blog | Researchers → Editor → CEO → Author → Reviewer (G0) → CEO (G3) → Human (G4) → publish |
| New course | Editor → CEO → Author + Slide+Audio + Voice (parallel) → Reviewer (G0) → CEO (G3) → Human (G4) → publish |
| Course delta | Editor → CEO → Author (small) → Reviewer (G0) → CEO (G3) → Human (G4) → publish |
| Bug / feature | Vardaan or QA → CEO → Chief Eng → Planner-Executor → Code Reviewer (G_code) → QA (G2) → CEO (G3) → Human (G4) → merge |
| SEO change | SEO Optimizer → CEO (G3) → Human (G4) → publish |

## Self-improvement (V1)

After every task, the manager writes 3 lines to `vault/retrospectives/<agent>/`:
- What worked
- What to fix
- SOUL update proposed (yes/no — exact line if yes)

Weekly retrospectives roll up. CEO batches changes for human approval. No DSPy / Self-Refine Trainer in V1 — layer those in V3 with real data.

## Vault

All narrative output goes to `/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/vault/`. Open it as an Obsidian vault. Structure: `research/<vendor>/<date>.md`, `research/_daily/<date>.md`, `courses/<slug>/`, `decisions/`, `retrospectives/<agent>/`, `people/`.

## Getting started

```bash
# 1. Boot Paperclip
cd /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org
pnpm dev   # Paperclip on http://localhost:3100

# 2. Import the company
pnpm paperclipai company import --from companies/learnova-academy

# 3. Wire adapters (claude-local, codex-local, opencode-local) in Paperclip UI

# 4. Add secrets via Paperclip UI Secrets store (encrypted at rest):
#    - RESEND_API_KEY, TAVILY_API_KEY, GH_TOKEN, ACADEMY_AGENT_API_KEY
#    OpenRouter is via OpenCode auth (~/.local/share/opencode/auth.json)

# 5. Hire each agent (one-by-one in UI), then enable the company

# 6. Test: in Paperclip UI, send each agent a smoke task and verify
```

## Scalability

This is the V1 template. To launch a second product (e.g. Marketing dashboard), copy this directory to `companies/marketing/`, swap product-specific agents (Content Author → Campaign Author, etc.), update goals, and import. Paperclip is multi-tenant — companies share `shared-skills/` and `vault/` patterns.

## License

MIT (see `LICENSE`). Generated with the [company-creator](https://github.com/paperclipai/paperclip) skill.

## References

- [Agent Companies Specification](https://agentcompanies.io/specification)
- [Paperclip](https://github.com/paperclipai/paperclip) (upstream)
- [Anthropic Harness Engineering](https://www.anthropic.com/engineering/harness-design-long-running-apps) (April 2026)
- [Anthropic Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
