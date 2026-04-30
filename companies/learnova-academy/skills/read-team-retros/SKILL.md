---
schema: agentcompanies/v1
kind: skill
slug: read-team-retros
name: Read Team Retros
description: Chief skill — Monday 09:00 IST. Read this week's per-task retrospectives from your team's agents, look for patterns, write a 1-page weekly retro, propose SOUL changes for CEO batching.
version: 0.1.0
license: MIT
sources: []
---

# Read Team Retros

Shared by `chief-research`, `chief-content`, `chief-engineering`, `chief-marketing`. Runs Mon 09:00 IST after the company-wide weekly cron.

## Procedure

1. **List your team's per-task retros** — `ls vault/retrospectives/<agent-slug>/*.md` for each agent reporting to you, filtered to last 7 days
2. **Read each** — they're 3-line files: what worked / what to fix / SOUL update proposed?
3. **Pattern-spot** — same blocker repeating, same agent saturating, same handoff failing
4. **Write your weekly retro** to `vault/retrospectives/_team/<your-team>-W<n>.md`:

```markdown
---
date: 2026-04-29
team: research
chief: chief-research
agents_reviewed: 5
tasks_reviewed: 24
---

# Research team — Week 17 retro

## What worked
- 4 researchers ran 100% on schedule; editor synthesised within 10 min target on 5/5 days
- HOT items flagged early on Tue (Anthropic 7-connector launch)

## What to fix
- researcher-anthropic hit per-task budget twice (Tue + Thu); cap of $0.50 may be too low for HOT-day deep-dives
- Crawl4AI rate-limited on Wed; Tavily fallback not auto-tried

## SOUL changes proposed for CEO batching
- researcher-anthropic: raise per-task cap to $0.75 on HOT-flagged days only
- vendor-watcher skill: add explicit "Crawl4AI failure → Tavily after 30s" step (already in SOUL but not the skill)

## Praise
- @researcher-community caught the open-source MCP-postgres trend 24h before it hit official channels — well done
```

5. **Hand off to CEO** — comment on the company-wide weekly retro task with your retro link

## Inputs

- 7 days of `vault/retrospectives/<agent-slug>/*.md` for your direct reports
- Your team's `.paperclip.yaml` budget configs

## Outputs

- One markdown file per week per chief
- A comment on CEO's weekly retro task

## Never do

- Never act on SOUL changes yourself — that's a G4 decision (proposed → CEO batches → human approves)
- Never write praise without specific evidence
- Never block on missing retros from agents that didn't run that week

## Budget

Per-task cap $1.
