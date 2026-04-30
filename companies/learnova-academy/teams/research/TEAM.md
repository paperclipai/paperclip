---
schema: agentcompanies/v1
kind: team
slug: research
name: Research
description: Daily AI-vendor research and synthesis. 4 specialist researchers (one per source) plus an editor that produces the daily brief at 06:30 IST.
manager: ../../agents/chief-research/AGENTS.md
includes:
  - ../../agents/researcher-anthropic/AGENTS.md
  - ../../agents/researcher-openai/AGENTS.md
  - ../../agents/researcher-google/AGENTS.md
  - ../../agents/researcher-community/AGENTS.md
  - ../../agents/research-editor/AGENTS.md
tags:
  - team
  - research
---

# Research team

Specialist-per-source pattern (Anthropic style: lead-agent spawns parallel subagents). Each researcher owns one source bucket, writes per-vendor daily notes to `vault/research/<vendor>/<date>.md`. The Research Editor reads all four notes at 06:30 IST and synthesises a daily brief at `vault/research/_daily/<date>.md` that the CEO reads at 07:00 IST to triage tickets.

## Workflow

```
06:00 IST (parallel)
├── researcher-anthropic   → vault/research/anthropic/<date>.md
├── researcher-openai      → vault/research/openai/<date>.md
├── researcher-google      → vault/research/google/<date>.md
└── researcher-community   → vault/research/community/<date>.md

06:30 IST
└── research-editor reads all 4 → vault/research/_daily/<date>.md
                                  (relevance-tagged, cross-linked, recommendations)
```

## What the team produces

A single daily brief at `vault/research/_daily/YYYY-MM-DD.md` with:

- **TL;DR** — 5-line summary of today's most important AI news
- **Per-vendor sections** — what shipped, why it matters, source links
- **Recommendations** — what should we ship today? "New course on X", "update course Y module Z", "blog post about A", or "no-action"
- **Out-of-scope** — items the editor judged not worth a course, with reason

## Reporting

- Each researcher's daily note is the unit of work; logged to Paperclip audit + `vault/retrospectives/<researcher>/<date>-<task-id>.md` (3-line after-action by Chief Research)
- Chief Research writes a 1-page weekly summary every Monday 09:00 IST → `vault/retrospectives/_team/research-W<n>.md`

## Out-of-bounds for V1

- Vendors outside Anthropic / OpenAI / Google / community (Reddit/HN/X). Don't add Meta / Mistral / DeepSeek / Qwen / Kimi / MiniMax until explicit user instruction.
- Direct course publishing — researchers feed the Content team via the daily brief, never publish themselves.
