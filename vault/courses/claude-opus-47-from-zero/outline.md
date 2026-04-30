---
course_slug: claude-opus-47-from-zero
title: "How to build production-grade agents with Claude Opus 4.7 in 7 chapters"
status: outline-draft-for-review
author: course-author
agent_drafted_by: course-author
date: 2026-04-30
level: Builder
vendor_tag: anthropic
target_audience: "Developers and AI engineers who have used at least one LLM API (Claude, OpenAI, or equivalent) and are comfortable with Python or TypeScript. No prior Opus 4.7 or agent-orchestration experience required."
prerequisites:
  - "Python 3.10+ or Node.js 20+ installed and functional"
  - "Anthropic API key with available credits"
  - "Familiarity with async/await and JSON/HTTP fundamentals"
  - "Basic command-line comfort (git, pip/npm)"
learning_outcomes:
  - "Migrate from Opus 4.6 (or Sonnet 4.x) to Opus 4.7 with correct tokenizer expectations, effort tuning, and task-budget configuration"
  - "Deploy a Managed Agents session using the decoupled brain/hands architecture and recover from harness failures automatically"
  - "Configure Claude Code auto mode with custom block rules and environment trust boundaries for safe autonomous operation"
  - "Wire creative MCP connectors (Blender, Adobe CC, Ableton) into a multi-tool agent pipeline and handle provider-outage failover"
  - "Ship a production multi-modal agent that orchestrates tools, manages high-resolution vision tasks, and runs behind a resilience stack"
total_duration_min: 280
chapter_count: 7
capstone_project_min: 60
related_courses:
  - claude-tool-use-from-zero
  - production-agents-claude-agent-sdk-mcp-connector
sources:
  - https://www.anthropic.com/news/claude-opus-4-7
  - https://www.anthropic.com/engineering/managed-agents
  - https://www.anthropic.com/engineering/claude-code-auto-mode
  - https://www.anthropic.com/engineering/april-23-postmortem
  - https://www.anthropic.com/news/claude-for-creative-work
---

# How to build production-grade agents with Claude Opus 4.7

## Why this course

Claude Opus 4.7 launched on April 16, 2026, and most tutorials treat it as "a faster chat API." That misses the point. Opus 4.7 is the first Claude model designed from the ground up as an **agentic substrate** — the brain in a managed multi-agent system. Anthropic shipped the managed-agent architecture (decoupled orchestrator + executors), auto mode with a two-layer classifier, task budgets, and an `xhigh` effort tier alongside the model itself. No other free resource covers this stack at launch.

This course takes you from zero to shipping a production multi-modal agent that orchestrates tools, processes high-resolution images, recovers from failures, and knows when to stop spending your money. Every code example is drawn from primary Anthropic documentation and engineering posts — not blog summaries.

A contrarian thread runs through every chapter: the defaults aren't always safe, the new tokenizer changes your bill, and "just use auto mode" is not a deployment strategy. We name all of it.

## Course outline

### Chapter 1: What Opus 4.7 changes — and what it costs

- **Duration**: 40 min
- **Prerequisites**: course intro only
- **Learning objectives**:
  - Identify the five most important capability changes from Opus 4.6 to Opus 4.7 (coding, vision, instruction following, memory, effort levels)
  - Predict token-cost impact using the updated tokenizer (1.0–1.35× factor) and configure `effort` and `task_budget` parameters to control spend
  - Migrate an existing `claude-opus-4-6` API call to `claude-opus-4-7` and verify that output quality and cost match expectations
  - Explain why Opus 4.7's stricter instruction following can break prompts written for earlier models
- **Key concepts**: `claude-opus-4-7` model ID, updated tokenizer, `xhigh` effort level, `task_budget` (public beta), 2,576px vision limit, migration guide, instruction-following sensitivity, $5/$25 pricing
- **Hands-on exercise**: Migrate a three-turn tool-use script from Opus 4.6 to Opus 4.7, compare token usage and output quality across `high`/`xhigh`/`max` effort levels, and set a task budget that caps spend at 150% of the Opus 4.6 baseline

---

### Chapter 2: Your first agent — from Messages API to Managed Agents

- **Duration**: 45 min
- **Prerequisites**: Chapter 1
- **Learning objectives**:
  - Describe the three core Managed Agents interfaces: session (durable log), harness (the loop), sandbox (execution environment)
  - Create an agent, environment, and session via the REST API and stream SSE events to completion
  - Recover from a simulated harness failure using `wake(sessionId)` and `getSession(id)`
  - Apply the decision rule: when to use Managed Agents vs the Agent SDK vs raw Messages API for five real scenario types
- **Key concepts**: `managed-agents-2026-04-01` beta header, decoupled brain/hands, `execute(name, input) → string`, session as append-only log, `session.status_idle`, SSE streaming, runtime pricing ($0.08/hr), 60% p50 TTFT improvement
- **Hands-on exercise**: Build a Managed Agents session that runs a multi-step data analysis task (fetch a CSV from a URL, clean it, generate a summary), kill the harness mid-run, and demonstrate automatic recovery from the session log

---

### Chapter 3: Auto mode — safe autonomy for long-running agents

- **Duration**: 45 min
- **Prerequisites**: Chapter 1
- **Learning objectives**:
  - Explain the two-layer defense: prompt-injection probe (input) and transcript classifier (output)
  - Configure custom environment trust boundaries and block rules for a specific project
  - Interpret classifier decisions: 0.4% FPR, 17% FNR on real overeager actions, and what that means for your deployment
  - Implement a deny-and-continue recovery strategy when the classifier blocks an action
- **Key concepts**: `--auto-mode` flag, Tier 1/2/3 allow rules, two-stage classifier, reasoning-blind design, subagent handoff checks, deny-and-continue, 3-consecutive/20-total escalation thresholds, `claude auto-mode defaults`
- **Hands-on exercise**: Enable auto mode on a Claude Code project, customize the environment slot to trust your GitHub org and S3 bucket, add a block rule that prevents pushing to `main`, then test with a prompt that would trigger scope escalation — verify the classifier blocks it and the agent recovers

---

### Chapter 4: High-resolution vision and multi-modal agent workflows

- **Duration**: 40 min
- **Prerequisites**: Chapter 1
- **Learning objectives**:
  - Send images up to 2,576px on the long edge (~3.75 megapixels) to Opus 4.7 and extract structured data from dense screenshots and technical diagrams
  - Build a multi-modal agent that accepts image + text inputs, reasons across both, and produces structured output
  - Downsample images appropriately when full resolution isn't needed to control token costs
  - Design a document-analysis pipeline that processes multi-page PDFs as high-res page images
- **Key concepts**: 2,576px long-edge limit, model-level vision change (not an API parameter), token cost of high-res images, `document`/`image`/`container_upload` content blocks, vision + tool-use in a single agent loop
- **Hands-on exercise**: Build an image-analysis agent that takes a screenshot of a complex dashboard, extracts all visible metrics into a structured JSON object, then uses those metrics to generate a written summary — compare results at native resolution vs downsampled to understand the quality/cost tradeoff

---

### Chapter 5: Creative MCP connectors — Claude for Creative Work

- **Duration**: 45 min
- **Prerequisites**: Chapters 1 and 2
- **Learning objectives**:
  - Install and configure the Blender MCP connector and execute Python against a live Blender scene via Claude tool-use
  - Build a multi-tool pipeline spanning Adobe Creative Cloud (Library search → Photoshop edit → Export) using MCP tool calls
  - Navigate the Ableton, Affinity, and other creative connector ecosystems and choose the right connector for a creative task
  - Explain the local-first architecture: why creative assets stay on your machine while Claude sends structured commands
- **Key concepts**: 9 creative connectors (Blender, Adobe CC, Ableton, Affinity, Autodesk Fusion, SketchUp, Resolume, Splice), `bpy` Python API, local MCP server architecture, `blender-mcp-server`, Adobe CC 50+ tools, paid vs free tiers, MCP connector naming (`mcp__<server>__<tool>`)
- **Hands-on exercise**: Build a product-launch pipeline: search Adobe Libraries for a hero image, apply a smart-object blur in Photoshop via MCP, and export as web-optimised JPEG — then connect the Blender connector to generate a 3D product mockup from a text description

---

### Chapter 6: Production resilience — trust, failover, and the HERMES lesson

- **Duration**: 40 min
- **Prerequisites**: Chapters 2 and 3
- **Learning objectives**:
  - Implement a provider-agnostic fallback chain that routes tool-use calls to an alternative model when Claude is unavailable
  - Configure structured logging and cost circuit breakers for Managed Agents sessions
  - Explain the HERMES.md billing bug and the April 2026 outage — and why single-provider dependency is a production risk
  - Apply the five-step deployment checklist: audit logging, cost cap, permission hardening, failover testing, incident response runbook
- **Key concepts**: OpenRouter/Vercel AI SDK fallback routing, `PreToolUse`/`PostToolUse` hooks, cost circuit breaker, HERMES.md billing bug (HN 1031pts/441 comments), April 2026 Claude outage, multi-provider resilience, ZDR ineligibility, `bypassPermissions` danger
- **Hands-on exercise**: Harden the agent from Chapter 2 with a production hook stack: add audit logging for every file modification, implement a cost circuit breaker that terminates the session at 150% budget, and wire a Vercel AI SDK fallback chain that retries on GPT-4o if Claude returns a 503 — verify the whole stack works by simulating a provider outage

---

### Chapter 7: Capstone — ship a multi-modal research agent in production

- **Duration**: 25 min (guided setup) + 60 min (independent)
- **Prerequisites**: Chapters 1–6
- **Learning objectives**:
  - Orchestrate a multi-tool, multi-modal agent that combines high-res vision, creative MCP connectors, and Managed Agents
  - Deploy behind auto mode with custom block rules, cost caps, and failover
  - Demonstrate recovery from a harness failure and a provider outage in the same session
  - Produce a deployable repo with documentation that another engineer can operate
- **Key concepts**: full-stack agent architecture, managed-agents + auto-mode + MCP + vision + failover integration, production readiness checklist
- **Hands-on exercise**: The capstone project (see below)

---

## Capstone project

**Build a production multi-modal research agent that accepts a research brief (text + image), searches connected data sources via MCP, generates visual assets via creative connectors, and runs behind a full resilience stack.**

Deliverable:
- A repo with Python or TypeScript source
- `agent.py` / `agent.ts`: Managed Agents session creation + SSE streaming with auto-mode integration
- `mcp_config.py` / `mcp_config.ts`: Multi-server MCP wiring (at least one creative connector + one data source)
- `hooks.py` / `hooks.ts`: Audit log + cost circuit breaker + failover routing
- `vision.py` / `vision.ts`: High-res image processing module (accept dashboard screenshots, extract metrics)
- `README.md` with deployment instructions and incident-response runbook

Verification:
- Agent starts a session, processes a high-res image input, and executes at least two MCP tool calls from different connectors
- Harness failure is recovered automatically via session log replay
- Simulated provider outage triggers failover and the agent completes on the backup provider
- Cost circuit breaker terminates the session if simulated token spend exceeds the cap
- Auto mode blocks a simulated scope-escalation action and the agent recovers via deny-and-continue
- Audit log has an entry for every file modification and every cost threshold crossing

Time: 60 min

## Why this beats alternatives

Every Opus 4.7 tutorial will tell you it's better at coding. This course is the only one that treats Opus 4.7 as what it actually is — an agentic substrate. You'll understand the managed-agent architecture that Anthropic's own engineering team built for it, the auto-mode safety layer that makes autonomy viable, the high-resolution vision that unlocks new use cases, and the creative MCP connectors that make Claude the OS for professional tools. You'll also know what can go wrong — billing bugs, outages, and the 17% classifier miss rate — and how to build systems that survive it.

## Sources

[1] Anthropic — Introducing Claude Opus 4.7 — https://www.anthropic.com/news/claude-opus-4-7 · retrieved 2026-04-30
[2] Anthropic Engineering — Scaling Managed Agents: Decoupling the brain from the hands — https://www.anthropic.com/engineering/managed-agents · retrieved 2026-04-30
[3] Anthropic Engineering — Claude Code auto mode: a safer way to skip permissions — https://www.anthropic.com/engineering/claude-code-auto-mode · retrieved 2026-04-30
[4] Anthropic Engineering — April 23 quality postmortem — https://www.anthropic.com/engineering/april-23-postmortem · retrieved 2026-04-30
[5] Anthropic — Claude for Creative Work — https://www.anthropic.com/news/claude-for-creative-work · retrieved 2026-04-30
