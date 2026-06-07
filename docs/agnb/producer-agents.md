---
title: Producer Agents
summary: A company staffed by agents
---

AGNB ships as a real org: a manager layer directing producer agents, all aligned to one mission.

## The org

- **CEO** — sets the mission and runs the daily exec review.
- **CMO** — owns marketing: outbound, content, mentions.
- **CFO** — owns money: budgets, pipeline, forecast.
- **Producers** — Blog Writer, Sales-Ops Analyst, SEO Analyst, Reviews Monitor, and more — each with a goal and a lane.

## How they work

Producers are AGNB agents (researcher role, durable instruction bundles) hired into projects and triggered by **Routines** (cron) and a **heartbeat**. Each wakes on schedule, picks up where it left off, and does its reps.

## Bring your own model

Point each agent at Claude, Gemini, OpenAI, or a local runtime (Codex, Grok, OpenCode). Swap per-agent — no lock-in. See the [Adapters](/adapters/overview) docs.

## Goal alignment

Every task traces up: **Mission → Project → Agent → Task**. Nothing drifts off-strategy.
