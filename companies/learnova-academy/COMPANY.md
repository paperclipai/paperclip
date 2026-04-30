---
schema: agentcompanies/v1
kind: company
slug: learnova-academy
name: Koenig AI Academy
description: 24/7 AI agent organization that runs the free B2C AI-learning portal at academy.kspl.tech — research, content, engineering, marketing, and QA all delegated to AI workers, with human approval only at the final publish gate.
version: 0.1.0
license: MIT
authors:
  - name: Koenig Solutions Pvt Ltd
homepage: https://academy.kspl.tech
tags:
  - ai-learning
  - b2c
  - content-pipeline
  - hybrid-org
goals:
  - Publish at least one course delta or blog every weekday from daily AI-vendor research
  - Reach Lighthouse 95+ on every page; Core Web Vitals INP <200ms, LCP <2.5s
  - Stay at or below ~$680/month total token spend with hard per-agent caps
  - Keep G4 backlog <24h typical; CEO summarises in EOD digest
requirements:
  secrets:
    - OPENROUTER_API_KEY     # via OpenCode auth (~/.local/share/opencode/auth.json), not in env
    - XAI_API_KEY            # optional — Grok x_search direct (also reachable via OpenRouter)
    - TAVILY_API_KEY         # free tier — research search
    - RESEND_API_KEY         # email magic-link + EOD digest + G4 approvals
    - ACADEMY_AGENT_API_KEY  # bearer for the Convex agentApi.ts HTTP action (Phase 1.4)
    - CLOUDFLARE_R2_*        # media uploads (Phase 1.4)
---

# Koenig AI Academy — agent company

The team that runs the **Koenig AI Academy** product (`academy.kspl.tech`) end-to-end: scrapes daily AI-vendor news, authors and reviews course content, ships frontend + backend changes, optimises for SEO + GEO, and only asks the human (Vardaan) at the final publish gate.

## Mission

Make every new AI release accessible to non-experts within 24 hours of launch — through structured courses, daily blogs, and an always-on Nova tutor. Free, B2C, content-first (not video-first).

## Architecture — hybrid hub-and-spoke + per-stream pipelines

```
                              ┌───────────────────────┐
                              │   CEO (Opus 4.7)      │
                              │   delegates · monitors│
                              │   G3 + G4             │
                              └─────────┬─────────────┘
                                        │ ticket triage
        ┌───────────────────┬───────────┼───────────────────┬───────────────────┐
        │                   │           │                   │                   │
   Chief Research     Chief Content  Chief Eng       Chief Marketing/SEO   (cross-cutting)
   (Sonnet 4.6)       (Sonnet 4.6)   (Sonnet 4.6)    (Sonnet 4.6)
        │                   │           │                   │
   ┌────┴────┐          ┌───┴───┐    ┌──┴──┐            ┌───┴───┐
   │ 4 Vendor│          │Author │    │Plan-│            │  SEO  │
   │ Research│          │       │    │Execu│            │ Opti- │
   │  -ers   │          │  ↓    │    │ tor │            │ mizer │
   │ (Grok   │          │Reviewr│    │  ↓  │            │       │
   │ 4.1     │          │ (G0)  │    │Code │            └───────┘
   │ Fast)   │          │  ↓    │    │Revwr│
   └────┬────┘          │Slide+ │    │(G_c)│
        │               │Audio  │    │  ↓  │
   Research Editor      │  +    │    │ QA  │
   (Sonnet 4.6)         │Voice  │    │Verif│
        │               └───┬───┘    │(G2) │
        │                   │        └──┬──┘
        ▼                   ▼           ▼
                   vault/research, vault/courses, draft PRs
                              │
                              ▼  
                         CEO G3 alignment
                              │
                              ▼
                         G4 — Vardaan
                  (email · Slack/Teams · Paperclip UI)
                              │
                              ▼
                         publish to academy.kspl.tech
```

## Workflow patterns by ticket type

| Ticket | Path |
|---|---|
| **Daily research → blog** | Researchers (×4 parallel) → Editor → CEO triage → Author → Reviewer (G0) → CEO G3 → Vardaan G4 → publish blog |
| **New course** | Editor's recommendation → CEO ticket → Author + Slide+Audio + Voice (parallel) → all converge to Reviewer (G0) → CEO G3 → Vardaan G4 → publish |
| **Course update** | Editor's "this affects course X" → CEO ticket → Author (small scope) → Reviewer → G3 → G4 → publish delta |
| **Bug / UI / UX** | Vardaan brief OR QA Verifier finding → CEO ticket → Chief Eng → Planner-Executor (plan mode) → Code Reviewer (G_code) → QA Verifier (G2) → CEO G3 → Vardaan G4 → merge PR |
| **SEO/GEO** | SEO Optimizer continuously monitors Search Console + Lighthouse → files tickets → CEO triage → fix path |

## Why hybrid not pure pipeline

Pure pipeline is too rigid: research, content, engineering, and SEO progress in **parallel** every day, each on their own cadence. Pure hub-and-spoke loses the gates that make AI-authored content trustworthy. Hybrid gives:

- **Hub at top** (CEO routes by ticket type) — keeps coordination cheap; each chief owns their domain end-to-end
- **Pipeline within each chief's domain** — ensures every output passes the gates that catch AI failure modes (hallucinated facts, broken code, vague descriptions, content drift)

## Scalability — multi-product

This package is the V1 template. When Vardaan launches the next product (Marketing dashboard, Sales dashboard), we run `scripts/seed-company.sh` against `companies/_template/` (a copy of this), swap product-specific roles (e.g., Content Author → Campaign Author), update goals + skills, and the same hybrid pattern applies. Multi-tenancy is native to Paperclip; companies share the `shared-skills/` directory across the org.

## Self-improvement (V1)

- After every completed task, the agent's manager writes a 3-line after-action review to `vault/retrospectives/<agent-slug>/<date>-<task-id>.md`: what worked / what to fix / SOUL update proposed?
- Every Monday 09:00 IST, each chief reads their team's retrospectives and writes a 1-page weekly summary
- CEO batches proposed SOUL changes weekly and routes to Vardaan (G4) for approval
- No DSPy / Self-Refine Trainer in V1 — these layer in V3 once we have data

## Cost discipline

Total ceiling: ~$680/month. Per-agent monthly + per-task hard caps enforced by Paperclip's budget engine (80% soft warning, 100% auto-pause). Watchdog (`watchdog/watchdog.mjs`) adds: pause on 5 consecutive heartbeats with no status delta, pause on 2× rolling-avg tokens-per-task. Models picked for cost-vs-quality fit: Opus only at the top, Sonnet for synthesis + review, Grok Fast for research, Gemini Flash for writing, Haiku for QA.

## Vault — agent narrative output

`/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/vault/` is an Obsidian-readable markdown vault. Researchers write per-vendor daily notes; Research Editor synthesizes; CEO writes weekly retrospectives; per-agent retrospectives in `vault/retrospectives/`. Vardaan opens Obsidian to browse, search, follow `[[wikilinks]]`. Vault paths are referenced from skill files so agents know where to write.

## Vendor scope V1

Anthropic + OpenAI + Google + community (Reddit r/LocalLLaMA, r/ClaudeAI, HN front page, X via Grok `x_search`). Don't expand without explicit user instruction.

## Related repos

- **`Koenig-Solutions-Private-Limited/learnovaBeast`** — the product (LMS frontend + Convex backend). The agency in this repo writes courses and ships PRs into branch `academy/redesign-v1` (and later `academy/main`).
- **`paperclipai/paperclip`** (upstream) — orchestrator we forked.
