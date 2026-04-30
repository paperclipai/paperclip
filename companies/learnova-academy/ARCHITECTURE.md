---
schema: agentcompanies/v1
kind: doc
slug: architecture
name: Koenig AI Academy — Architecture
description: Engineer-facing architecture reference for the learnova-academy agent company. Read before modifying any agent, adapter, schedule, secret, or pipeline gate. Pairs with COMPANY.md (org chart) and CULTURE.md (norms).
---

# Koenig AI Academy — Architecture

> Audience: an engineer who will modify this company. If you only need the org chart, read `COMPANY.md`. If you only need norms, read `CULTURE.md`. This doc is for changing things.

## 1. Architectural overview

The Academy is a **hybrid hub-and-spoke + per-stream pipeline** organization. CEO at the hub routes by ticket type. Each Chief owns a vertical pipeline within their domain. Cross-domain coordination flows through CEO; within-domain coordination flows through the Chief.

```
                                ┌───────────────────────────────────────┐
                                │                                       │
                                │       CEO (Sonnet 4.6 default,        │
                                │       Opus 4.7 for weekly retro)      │
                                │       triage · G3 · EOD digest        │
                                │                                       │
                                └───────────┬───────────────────────────┘
                                            │ ticket triage
        ┌────────────────────┬──────────────┼──────────────┬────────────────────┐
        ▼                    ▼              ▼              ▼                    ▼
┌──────────────┐    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Chief        │    │ Chief        │  │ Chief        │  │ Chief        │  │ Vault        │
│ Research     │    │ Content      │  │ Engineering  │  │ Marketing    │  │ Historian    │
│ (Sonnet 4.6) │    │ (Sonnet 4.6) │  │ (Sonnet 4.6) │  │ (Sonnet 4.6) │  │ (specialist) │
└──────┬───────┘    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────────────┘
       │                   │                 │                 │
   ┌───┴────┐         ┌────┴─────┐      ┌────┴─────┐      ┌────┴────┐
   │ 4×     │         │ blog-    │      │ planner  │      │ seo-geo │
   │ Resear-│         │ author   │      │ (Opus    │      │ optimi- │
   │ chers  │         │ (Gemini) │      │  4.7)    │      │ zer     │
   │ (Grok  │         │ course-  │      │ executor │      │ (Sonnet │
   │ 4.1    │         │ author   │      │ (Opus    │      │  4.6)   │
   │ Fast)  │         │ (Gemini) │      │  4.7)    │      └─────────┘
   └───┬────┘         │ content- │      │ code-rev │
       │              │ reviewer │      │ (GPT-5)  │
   ┌───┴────┐         │ (Sonnet) │      │ qa-verif │
   │research│         │ slide-   │      │ (Haiku   │
   │-editor │         │ audio    │      │  4.5)    │
   │(Sonnet)│         │ (Sonnet) │      └────┬─────┘
   └───┬────┘         │ voice    │           │
       │              │ (Haiku)  │           │
       ▼              └────┬─────┘           ▼
                           ▼          PR → academy/redesign-v1
                vault/blogs, vault/courses
                           │                 │
                           └──────┬──────────┘
                                  ▼
                           CEO G3 alignment
                                  │
                                  ▼
                           G4 — Vardaan
                  (email · Slack/Teams · Paperclip UI)
                                  │
                                  ▼
                       publish to academy.kspl.tech
                                  │
                                  ▼
                  ┌── publish-verifier (G5, Haiku 4.5)
                  │   every 15 min during work hours UTC
                  └── PASS → log in EOD digest
                      BLOCK → escalate to chief-engineering same-heartbeat
```

**Why hybrid not pure pipeline.** Pure pipeline is too rigid: research, content, engineering, and SEO progress in parallel every day, each on their own cadence. Pure hub-and-spoke loses the gates that make AI-authored content trustworthy. Hybrid gives a hub at top (CEO routes; coordination cheap) and a pipeline within each chief's domain (gates catch AI failure modes — hallucinated facts, broken code, vague descriptions, content drift).

---

## 2. Agent reporting structure

**21 agents = CEO + 4 Chiefs + 14 workers + 2 specialists.**

```
ceo
├── chief-research
│   ├── researcher-anthropic
│   ├── researcher-openai
│   ├── researcher-google
│   ├── researcher-community
│   └── research-editor
├── chief-content
│   ├── blog-author
│   ├── course-author
│   ├── content-reviewer            (G0 gate)
│   ├── slide-audio-producer
│   └── voice-producer
├── chief-engineering
│   ├── planner
│   ├── executor
│   ├── code-reviewer               (G_code gate)
│   └── qa-verifier                 (G2 gate)
└── chief-marketing
    └── seo-geo-optimizer

specialists (cross-cutting, report to CEO directly):
├── publish-verifier                (G5 gate)
└── vault-historian
```

Reporting cadence:

| Edge | Cadence | Mechanism |
|---|---|---|
| Worker → Chief | Every heartbeat (per-ticket) | Paperclip task comment + status flip |
| Chief → CEO | EOD digest + ad-hoc escalations | Paperclip task tag |
| CEO → Vardaan | EOD digest (email via Resend) + G4 approvals | Email + Slack/Teams + Paperclip UI |
| Specialist → CEO | publish-verifier reports PASS in EOD digest, BLOCK same-heartbeat. vault-historian feeds weekly retro. | Paperclip task tag |
| Manager → Worker (retro) | After every completed task | 3-line after-action review at `vault/retrospectives/<agent-slug>/<date>-<task-id>.md` |
| Chief → CEO (weekly) | Mon 09:00 IST | 1-page weekly summary in `vault/retrospectives/_weekly/<week>.md` |

---

## 3. Data flow: research → publish → verify

A single full daily cycle, end-to-end:

```
06:00 IST   researcher-anthropic ─┐
06:00 IST   researcher-openai    ─┤   (parallel, daily-research cron)
06:00 IST   researcher-google    ─┤
06:00 IST   researcher-community ─┘
            │
            │ each writes vault/research/<vendor>/_daily/<date>.md
            ▼
06:30 IST   research-editor reads 4 daily notes
            │
            │ writes vault/research/_daily/<date>.md (synthesis)
            ▼
07:00 IST   ceo daily-triage
            │
            │ reads synthesis, decides:
            │   - blog opportunity?  → ticket to chief-content (blog-author path)
            │   - course delta?      → ticket to chief-content (course-author path)
            │   - new course?        → ticket to chief-content (course-author + slide-audio + voice parallel)
            │   - bug/UI/UX?         → ticket to chief-engineering
            │   - SEO/GEO?           → ticket to chief-marketing
            ▼
hourly      chief-* dispatch workers (hourly-worker-dispatch cron)
            │
            ▼
            workers execute → produce drafts
            │
            ▼
G0          content-reviewer audits → PASS/BLOCK
            │
            ▼
G_code      code-reviewer audits PRs → PASS/BLOCK     (engineering tickets only)
            │
            ▼
G2          qa-verifier runs tests + browser walk     (engineering tickets only)
            │
            ▼
G3          ceo aligns vs original ticket → PASS/BLOCK
            │
            ▼
G4          Vardaan approves                          (3 channels: email/Slack/UI)
            │
            ▼
            publish to academy.kspl.tech via learnova-publish adapter
            │     (Convex agentApi.ts HTTP action, bearer-auth)
            ▼
G5          publish-verifier (every 15 min during work hours UTC)
            │   - live HTML fetch
            │   - schema.org JSON-LD validates
            │   - sitemap entry exists
            │   - cited URLs resolve
            │   - Core Web Vitals not regressed
            │
            ▼ PASS → log in EOD digest
              BLOCK → escalate to chief-engineering same-heartbeat
            │
            ▼
18:00 IST   ceo eod-digest
            │
            │ writes vault/retrospectives/_daily/<date>.md
            │ emails Vardaan via Resend
            ▼
            done. next cycle 06:00 IST.

Mon 09:00   weekly-retrospective: ceo + 4 chiefs each write retro
            │
            ▼ writes vault/retrospectives/_weekly/<week>.md
            │ ceo batches proposed SOUL changes for Vardaan G4 approval
            ▼

Mon 10:00   vault-historian-weekly: rebuild indices, monthly health audit
```

---

## 4. Vault folder ownership

**Cross-folder writes are forbidden.** Per-agent path discipline is enforced via SOUL/skill instructions, not hard ACLs at the MCP layer (per `.paperclip.yaml` comments). Violations show up as drift in retros.

| Folder | Owner agent(s) | What goes there |
|---|---|---|
| `vault/research/anthropic/_daily/<date>.md` | `researcher-anthropic` | Anthropic vendor watch — releases, docs, blog, citations |
| `vault/research/openai/_daily/<date>.md` | `researcher-openai` | OpenAI vendor watch |
| `vault/research/google/_daily/<date>.md` | `researcher-google` | Google AI vendor watch (Gemini, Vertex) |
| `vault/research/community/_daily/<date>.md` | `researcher-community` | Reddit (r/LocalLLaMA, r/ClaudeAI), HN, X |
| `vault/research/_daily/<date>.md` | `research-editor` | Synthesis of the 4 vendor notes — what CEO reads |
| `vault/research/_drafts/` | researchers (transient) | Pre-publish staging |
| `vault/blogs/_drafts/<slug>.md` | `blog-author` | Pre-G0 staging |
| `vault/blogs/<date>-<slug>.md` | `blog-author` (after G0 only) | Approved blog ready for publish |
| `vault/courses/<course-slug>/_outline.md` | `course-author` | Course spine (must be approved before chapters) |
| `vault/courses/<course-slug>/<chapter>.md` | `course-author` | One file per chapter |
| `vault/courses/<course-slug>/_artifacts/` | `slide-audio-producer` | Slide decks, audio files, flashcards (NotebookLM output) |
| `vault/courses/<course-slug>/_voiceovers/` | `voice-producer` | Kokoro TTS chapter intros + outros |
| `vault/decisions/<date>-<topic>.md` | `ceo` (final), `planner` (proposals) | ADR-style decision records, planner emit-points |
| `vault/retrospectives/<agent-slug>/<date>-<task-id>.md` | each agent's manager (Chief or CEO for Chiefs) | 3-line after-action review per task |
| `vault/retrospectives/_daily/<date>.md` | `ceo` | EOD digest |
| `vault/retrospectives/_weekly/<week>.md` | `ceo` (rolls up Chief retros) | Mon 09:00 weekly retro |
| `vault/people/<person>.md` | `ceo` (only) | Profile of recurring named entities (vendors, prominent researchers) |
| `vault/_indices/by-date.md`, `by-author.md`, `by-tag.md` | `vault-historian` | Pre-built indices (1000× cheaper than scanning the whole vault) |
| `vault/_archive/` | `vault-historian` | Archived (never deleted) historical files |

The filesystem MCP server's allowlist (in `.mcp.json`) grants the entire `vault/`. Per-folder discipline lives in each agent's SOUL.

---

## 5. Per-agent state tables

### C-suite

| Agent | Model | Adapter | Monthly | Per-task | Cron | Depends on | Escalates to |
|---|---|---|---|---|---|---|---|
| `ceo` | claude-sonnet-4-6 (Opus 4.7 weekly only) | `claude_local` | $80 | $2 | daily-triage 07:00, eod-digest 18:00, weekly-retro Mon 09:00 | research-editor synthesis | Vardaan (G4) |
| `chief-research` | claude-sonnet-4-6 | `claude_local` | $40 | $1 | weekly-retrospective Mon 09:00 | researchers, research-editor | ceo |
| `chief-content` | claude-sonnet-4-6 | `claude_local` | $80 | $2 | hourly-worker-dispatch | content team | ceo |
| `chief-engineering` | claude-sonnet-4-6 | `claude_local` | $120 | $4 | hourly-worker-dispatch | planner, executor, code-reviewer, qa-verifier | ceo |
| `chief-marketing` | claude-sonnet-4-6 | `claude_local` | $40 | $1 | hourly-worker-dispatch | seo-geo-optimizer | ceo |

### Research

| Agent | Model | Adapter | Monthly | Per-task | Cron | Secrets | Escalates to |
|---|---|---|---|---|---|---|---|
| `researcher-anthropic` | grok-4.1-fast | `opencode_local` (OpenRouter) | $20 | $0.50 | daily-research 06:00 | TAVILY_API_KEY (req), XAI_API_KEY (opt) | chief-research |
| `researcher-openai` | grok-4.1-fast | `opencode_local` | $20 | $0.50 | daily-research 06:00 | TAVILY_API_KEY | chief-research |
| `researcher-google` | grok-4.1-fast | `opencode_local` | $20 | $0.50 | daily-research 06:00 | TAVILY_API_KEY | chief-research |
| `researcher-community` | grok-4.1-fast | `opencode_local` | $20 | $0.50 | daily-research 06:00 | TAVILY_API_KEY, XAI_API_KEY (req — Grok x_search) | chief-research |
| `research-editor` | claude-sonnet-4-6 | `claude_local` | $20 | $0.50 | daily-synthesis 06:30 | — | chief-research |

### Content

| Agent | Model | Adapter | Monthly | Per-task | Cron | Secrets | Escalates to |
|---|---|---|---|---|---|---|---|
| `blog-author` | gemini-3-flash-preview | `opencode_local` | $20 | $0.50 | dispatched | ACADEMY_AGENT_API_KEY, TAVILY_API_KEY (opt) | chief-content |
| `course-author` | gemini-3-flash-preview | `opencode_local` | $20 | $0.50 | dispatched | ACADEMY_AGENT_API_KEY | chief-content |
| `content-reviewer` | claude-sonnet-4-6 | `claude_local` | $20 | $0.50 | dispatched (G0 trigger) | — | chief-content |
| `slide-audio-producer` | claude-sonnet-4-6 | `claude_local` | $20 | $1 | dispatched | — | chief-content |
| `voice-producer` | claude-haiku-4-5 | `claude_local` | $10 | $0.50 | dispatched | — | chief-content |

### Engineering

| Agent | Model | Adapter | Monthly | Per-task | Cron | Secrets | Escalates to |
|---|---|---|---|---|---|---|---|
| `planner` | claude-opus-4-7 (`--permission-mode plan`) | `claude_local` | $30 | $1 | dispatched | GH_TOKEN | chief-engineering |
| `executor` | claude-opus-4-7 | `claude_local` | $30 | $1 | dispatched | GH_TOKEN | chief-engineering |
| `code-reviewer` | gpt-5 | `codex_local` | $30 | $0.75 | dispatched (G_code trigger) | GH_TOKEN | chief-engineering |
| `qa-verifier` | claude-haiku-4-5 | `claude_local` | $20 | $0.50 | dispatched (G2 trigger) | — | chief-engineering |

### Marketing / SEO

| Agent | Model | Adapter | Monthly | Per-task | Cron | Secrets | Escalates to |
|---|---|---|---|---|---|---|---|
| `seo-geo-optimizer` | claude-sonnet-4-6 | `claude_local` | $20 | $0.50 | dispatched + weekly Search Console pull | — | chief-marketing |

### Specialists

| Agent | Model | Adapter | Monthly | Per-task | Cron | Secrets | Escalates to |
|---|---|---|---|---|---|---|---|
| `publish-verifier` | claude-haiku-4-5 | `claude_local` | $20 | $0.20 | publish-verifier-poll every 15 min `*/15 0-13 * * *` | — | chief-engineering (BLOCK), ceo (PASS in EOD digest) |
| `vault-historian` | claude-sonnet-4-6 | `claude_local` | $30 | $1 | vault-historian-daily 08:00, vault-historian-weekly Mon 10:00 | — | ceo |

Numbers are authoritative against `companies/learnova-academy/.paperclip.yaml` as of 2026-04-29. When you change a budget, change both this table and the YAML in the same commit.

---

## 6. Cron schedules

From `.paperclip.yaml` `schedules:` block. Cron expressions in UTC; IST conversions in comments.

| Schedule | Cron (UTC) | IST | Agents | Parallel? |
|---|---|---|---|---|
| `daily-research` | `0 0 * * *` | 06:00 (next day's CEO triage uses these notes) | researcher-anthropic, researcher-openai, researcher-google, researcher-community | yes |
| `daily-synthesis` | `30 0 * * *` | 06:30 | research-editor | n/a (single) |
| `daily-triage` | `30 1 * * *` | 07:00 | ceo | n/a |
| `vault-historian-daily` | `30 2 * * *` | 08:00 (after CEO triage) | vault-historian | n/a |
| `hourly-worker-dispatch` | `0 2-12 * * *` | hourly across IST work day | chief-content, chief-engineering, chief-marketing | yes |
| `eod-digest` | `30 12 * * *` | 18:00 | ceo | n/a |
| `weekly-retrospective` | `30 3 * * 1` | Mon 09:00 | ceo, chief-research, chief-content, chief-engineering, chief-marketing | yes |
| `vault-historian-weekly` | `30 4 * * 1` | Mon 10:00 (after weekly retro) | vault-historian | n/a |
| `publish-verifier-poll` | `*/15 0-13 * * *` | every 15 min during work hours UTC (covers IST work day) | publish-verifier | n/a |

To change a schedule: edit `.paperclip.yaml` `schedules:`, restart Paperclip control plane (`pnpm dev`), confirm in Paperclip dashboard → Schedules tab.

---

## 7. MCP server inventory

Two parallel MCP configs, one per adapter family:

### `.mcp.json` (Claude Code agents — all `claude_local` adapter)

```json
{
  "mcpServers": {
    "filesystem": "@modelcontextprotocol/server-filesystem on vault/, companies/, docs/, learnovaBeast",
    "github":     "@modelcontextprotocol/server-github with GH_TOKEN",
    "tavily":     "@mcptools/mcp-tavily with TAVILY_API_KEY",
    "fetch":      "uvx mcp-server-fetch (no args)"
  }
}
```

### `opencode.json` (OpenCode agents — all `opencode_local` adapter)

Wires the same four servers for the 4 researchers + blog-author + course-author. Without this, OpenCode-driven Grok and Gemini agents lack the filesystem and Tavily tools.

### Why these four

| Server | Why we need it | Used by |
|---|---|---|
| `filesystem` | Vault writes, company config reads, learnovaBeast PR diffs | every agent |
| `github` | PR creation + review, issue references | engineering team, code-reviewer |
| `tavily` | Web search for research and fact-checking | 4 researchers, content-reviewer (citation rot check), publish-verifier |
| `fetch` | Direct URL fetches (no API key); used for source rot detection and live HTML in G5 | publish-verifier, content-reviewer |

**Things NOT in MCP** (deliberate):
- `playwright` / `browser-use` — not MCP. The qa-verifier shells to `browser-use` CLI directly.
- `obsidian` — we treat the vault as plain markdown via filesystem MCP. No Obsidian app integration.
- Convex — the Academy product API is reached via the `learnova-publish` adapter (HTTPS to `agentApi.ts`), not MCP.

Per-agent path discipline (which vault folder each agent writes to) is enforced via SOUL/skill instructions, not at the MCP layer. See `.paperclip.yaml` header comment.

---

## 8. Secrets inventory

Per `.paperclip.yaml` `inputs.env:` blocks, plus Paperclip's encrypted secrets store at `~/.paperclip/instances/default/secrets/`. **Never put secrets in `.env` checked into git** — `CLAUDE.md` cardinal rule. The local `.env` is for development only and is gitignored.

| Secret | Required by | Why | Source |
|---|---|---|---|
| `OPENROUTER_API_KEY` | All `opencode_local` agents (4 researchers, blog-author, course-author) | LLM routing for Grok 4.1 Fast + Gemini 3 Flash Preview | `~/.local/share/opencode/auth.json` (OpenCode auth, NOT env) |
| `XAI_API_KEY` | `researcher-community` (req); other researchers (opt) | Grok `x_search` for X/Twitter signal — community researcher uses heavily | Paperclip Secrets store |
| `TAVILY_API_KEY` | All 4 researchers (req); blog-author (opt) | Free-tier web search | Paperclip Secrets store |
| `RESEND_API_KEY` | `ceo` (req for EOD digest + G4 magic-link emails) | Email delivery | Paperclip Secrets store |
| `GH_TOKEN` | `chief-engineering` (req), `planner` (req), `executor` (req), `code-reviewer` (req); `ceo` (opt) | PR creation + review on `learnovaBeast` | Paperclip Secrets store |
| `ACADEMY_AGENT_API_KEY` | `blog-author` (req), `course-author` (req — once Phase 1.4 lands) | Bearer token for Convex `agentApi.ts` HTTP action | Paperclip Secrets store + `learnovaBeast/.env` (must match) |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_BUCKET`, `CLOUDFLARE_R2_ENDPOINT` | `slide-audio-producer`, `voice-producer` (Phase 1.4) | Media uploads (slides, audio) | Paperclip Secrets store |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | All agents (V2) | Trace upload | Paperclip Secrets store (V2) |
| `WATCHDOG_ALERT_SLACK_WEBHOOK`, `WATCHDOG_ALERT_EMAIL_TO` | watchdog (V2) | Alerting on circuit-breaker trips | `.env` (operational, not agent-facing) |

**Sync flow:**

1. Edit `.env` (gitignored) on a fresh machine.
2. Run `./scripts/sync-secrets.sh` (wraps `scripts/sync_secrets.py`) — reads `.env`, writes to Paperclip's encrypted secrets store.
3. Restart Paperclip control plane (`pnpm dev`) so the secrets adapter picks up new entries.
4. Confirm in Paperclip dashboard → Settings → Secrets.

Detailed checklist: `docs/SECRETS_CHECKLIST.md`.

---

## 9. The 5-gate pipeline expanded

Each gate is a binary state-flip on the Paperclip task. The agent comments PASS or BLOCK with a structured payload.

### G0 — Content review (blog/course/SEO content)

**Owner:** `content-reviewer` (Sonnet 4.6).

**Inputs:** draft markdown at `vault/blogs/_drafts/<slug>.md` or `vault/courses/<course-slug>/<chapter>.md`. Original ticket reference. Cited research notes.

**Checks:**
- Every factual claim has a URL.
- All cited URLs return HTTP 200 (no rot).
- Brand voice: confident, friendly, source-citing, never hype-y.
- No AI tells ("In conclusion", "Furthermore", "Let's dive in").
- Answer-first headings.
- Internal linking to related vault content (`[[wikilinks]]`).
- 800-1500 words for blog (strike zone); chapter-appropriate for course.

**State flip:**

```yaml
# example PASS
gate: G0
status: PASS
reviewer: content-reviewer
ticket: KOE-123
artifact: vault/blogs/_drafts/2026-04-29-claude-vs-gpt5-coding.md
notes: |
  - 7 citations, all 200 OK
  - voice: ✓
  - funnel into [[courses/claude-coding-101]]: present, line 47
flip_to: G3
```

```yaml
# example BLOCK
gate: G0
status: BLOCK
reviewer: content-reviewer
ticket: KOE-123
issues:
  - line: 23
    issue: "claim 'Anthropic released Opus 4.8 today' — research note says 4.7, no 4.8 announcement found"
    fix: "remove claim or cite source"
  - line: 91
    issue: "URL https://example.com/foo returns 404"
    fix: "swap source or use archive.org"
flip_to: blog-author (rework)
```

### G_code — Code review (engineering tickets only)

**Owner:** `code-reviewer` (Codex / GPT-5). "Audit don't propose; demand evidence" lens.

**Inputs:** PR diff on `learnovaBeast` branch `academy/redesign-v1` or `academy/main`. Planner's plan from `vault/decisions/<date>-<topic>.md`.

**Checks:**
- Diff matches the plan steps (no scope creep).
- Lint passes.
- Security: no secrets in code, no obvious injection vectors.
- Test coverage on touched paths.
- TypeScript compile clean.

**State flip:** PASS → flow to G2; BLOCK → back to executor with line-level feedback.

### G2 — QA verification

**Owner:** `qa-verifier` (Haiku 4.5 + browser-use CLI).

**Inputs:** PR or content artifact post-G0/G_code.

**Checks:**
- Unit + integration tests pass on the PR branch.
- `browser-use` end-to-end walkthrough on a preview deployment (or staging).
- For content: sample 3 cited URLs and confirm they support the surrounding claim (LLM judge).

**State flip:** PASS → flow to G3; BLOCK → back to relevant author or engineer.

### G3 — CEO alignment

**Owner:** `ceo` (Sonnet 4.6).

**Inputs:** original ticket, all gate outcomes (G0/G_code/G2), budget consumed.

**Checks:**
- Original ticket scope matches what was produced.
- Budget vs allotted (per-task cap not breached more than once).
- Summary suitable for G4 email.

**State flip:** PASS → queue for G4 (email + Slack/Teams + UI surfaces); BLOCK → back to chief or kill ticket.

### G4 — Human approval

**Owner:** Vardaan (the only human gate).

**Three approval channels (all surfaced):**
1. **Email magic-link** via Resend — Vardaan clicks one URL, ticket flips to APPROVED.
2. **Slack/Teams button** — same effect via webhook.
3. **Paperclip UI queue** at http://localhost:3100 — for backlog review.

**SLA target:** <24h backlog (per `COMPANY.md` goals).

**State flip:** APPROVED → publish via `learnova-publish` adapter; REJECTED → CEO writes a retro and either re-queues with notes or kills.

### G5 — Publish verifier (post-publish sentinel)

**Owner:** `publish-verifier` (Haiku 4.5).

**Trigger:** every 15 min during work hours UTC (`*/15 0-13 * * *`). Polls recently-published artifacts (last 24h) plus a sample of older content.

**Checks:**
- Live HTML fetch from `academy.kspl.tech` returns 200.
- schema.org JSON-LD parses and validates against `Course` / `FAQPage` / `HowTo` / `VideoObject` shapes.
- Sitemap entry exists for the URL.
- All cited URLs in the live page still resolve.
- Core Web Vitals not regressed (LCP <2.5s, INP <200ms).

**State flip:**
- PASS → log in EOD digest.
- BLOCK → escalate same-heartbeat. Routing depends on issue:
  - Schema/render issue → `chief-engineering`
  - Source rot → `content-reviewer` (re-G0 with source swap)
  - Mismatch with research notes → flag as "G0 should have caught this" → triggers content-reviewer skill update via weekly retro

---

## 10. Decision rationale

These decisions are baked into the company structure. If you're tempted to undo one, read first.

### Why `blog-author` and `course-author` are split

Different DOD, different success metric, different voice.

- **blog-author:** 800-1500 words. Lead with falsifiable claim. Stratechery × Latent Space × Pragmatic Engineer voice. Funnels into courses. Success = traffic + citations.
- **course-author:** multi-chapter. Outline first; chapters are complete units; runnable exercises per chapter. Great-O'Reilly-book voice. Success = learner finishes and can do the thing.

Merging them would force one set of skills and one voice, and would either water down the blogs (too patient) or miss the course outcome (too breezy). They are explicitly told to never compete: blog handles breadth + traffic, course handles depth + outcomes.

### Why `content-reviewer` is its own gate (G0)

Two-agent content chain is a cardinal rule (`CLAUDE.md` rule 6). If the same agent writes and reviews, hallucinations get rationalized in the review pass instead of caught. Different model + different prompt = independent failure modes. Sonnet 4.6 reviewer catches Gemini-flavored AI tells; Gemini author catches Sonnet-flavored verbosity.

### Why `publish-verifier` exists at G5

G4 (human approval) cannot catch deploy-time regressions: schema breaking on the live build, sitemap not regenerating, source URL going dark in the 30 minutes between draft and publish. G5 is a **post-deploy sentinel**, not a pre-publish gate. It runs every 15 min and routes BLOCKs to the right party (don't punt to CEO when the issue belongs to chief-engineering).

Cost: $20/mo cap, $0.20 per task, Haiku 4.5 model. Cheapest tier because it does many cheap fetches, not deep synthesis.

### Why `planner` and `executor` are the same model + same context but different agents

Anthropic's April 2026 "Harness Engineering" pattern: Planner → Generator → Evaluator with structured handoffs and context resets. Our mapping:
- `planner` runs Claude Code with `--permission-mode plan`. Emits structured plan to `vault/decisions/`. Cannot write code or run tools.
- `executor` runs Claude Code without plan-mode. Same context (Opus 4.7). Picks up where planner left off, executes the plan.

Splitting them gives **clean audit logs** (planner-only entries are the reasoning trace; executor-only entries are the action trace) without paying for context-reload. They share a worktree (`learnovaBeast-fe-agent/` or `learnovaBeast-be-agent/`) so cwd state is preserved.

### Why CEO defaulted from Opus 4.7 → Sonnet 4.6 (cost optimization 2026-04-30)

Opus cost $4.36 across 4 runs in one cycle (auto-triggers from issue assignment). Sonnet 4.6 has comparable orchestration quality at ~3x lower cost. Reserve Opus 4.7 for weekly-retrospective only, where deep synthesis pays off. See `.paperclip.yaml` `ceo:` block comment.

### Why `voice-producer` is Haiku 4.5 not Sonnet

Lightweight: it orchestrates Kokoro CLI via Bash. No deep generation. Haiku 4.5 is sufficient. Using Sonnet would burn $30/mo for no quality gain.

### Why no ElevenLabs (ever)

Cardinal rule. Use Kokoro / OmniVoice / Cartesia / Chatterbox. See `~/.claude/projects/.../memory/feedback_no_elevenlabs.md`. The rationale: cost discipline + open-source preference + ElevenLabs lock-in concerns. This is non-negotiable.

### Why Gemini 3 Flash Preview (and never Gemini 2.5 Flash)

User explicitly excluded Gemini 2.5 Flash on 2026-04-29 (`.paperclip.yaml` `content-author:` comment, `~/.claude/projects/.../memory/feedback_model_choices.md`). Gemini 3 Flash Preview or 3.1 Flash Light Preview only. Verified slug at `/api/companies/.../adapters/opencode_local/models` on 2026-04-30.

### Why `vault-historian` exists separately

Without an explicit librarian, the vault becomes a graveyard. Pre-built indices (`by-date.md`, `by-author.md`, `by-tag.md`) are 1000× cheaper than scanning the whole vault on each query. The historian also runs a monthly health audit and archives (never deletes — history is data, loss is failure). Silent infrastructure: most days you don't notice it working. That's the point.

### Why hub-and-spoke + per-stream pipeline (not pure pipeline)

Pure pipeline is too rigid. Research, content, engineering, and SEO progress in **parallel** every day, each on their own cadence. Hub-and-spoke at top (CEO routes by ticket type) keeps coordination cheap. Pipeline within each chief's domain keeps gates intact. See `COMPANY.md` "Why hybrid not pure pipeline".

---

## 11. Common modifications

### Swap a model

Edit `.paperclip.yaml` for the agent's `adapter.config.model:` and update the comment with the rationale (cost / quality / availability). Restart Paperclip. Smoke-test with `./scripts/task.sh <agent> "<trivial prompt>"`. If quality regresses, roll back same-day.

```yaml
content-author:
  adapter:
    type: opencode_local
    config:
      model: openrouter/google/gemini-3-flash-preview  # was gemini-2.5-flash; user excluded 2026-04-29
      cwd: /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org
```

### Change a cron schedule

Edit `.paperclip.yaml` `schedules:` block. Convert IST to UTC (-5:30). Restart Paperclip. Verify in Paperclip dashboard → Schedules tab. The launchd plists in `infra/launchd/` are for OS-level keepalive, not agent crons; agent crons are entirely Paperclip-managed.

### Add a worker to an existing chief

1. `cp -r companies/_template/agents/_template companies/learnova-academy/agents/<new-role>` (or hand-author).
2. Author tight `SOUL.md` (lane, DOD, what they never do, escalation, voice).
3. Author `AGENTS.md` (operational, read every heartbeat).
4. Edit `config.json` (model, adapter, MCPs, tools).
5. Add to `.paperclip.yaml` under `agents:`, `budgets:`, and possibly `schedules:`.
6. Update the chief's SOUL/AGENTS to include the new direct report.
7. Smoke-test: `./scripts/task.sh <new-role> "<trivial prompt>"`.
8. Add to a schedule only after smoke passes.

### Add a new gate

Don't, lightly. Each gate is a tax on cycle time. If you genuinely need one:
1. Document the failure mode that motivated it in `vault/decisions/<date>-new-gate.md`.
2. Author the gating agent (or assign to an existing one).
3. Add a state-flip step in this doc's section 9.
4. Wire the trigger in `chief-*` SOUL.
5. Update CULTURE.md rule 9 (gates list).

### Change a budget

1. Edit `.paperclip.yaml` `budgets:`.
2. Update the table in section 5 of this doc in the same commit.
3. Restart Paperclip.

### Add a secret

1. Add to `.env.example` with no value, but a comment explaining what it's for.
2. Add to `.env` (gitignored) with the actual value.
3. Add to `.paperclip.yaml` per-agent `inputs.env:` blocks where required.
4. Run `./scripts/sync-secrets.sh`.
5. Update section 8 of this doc.

---

## 12. Things NOT to touch

| Path / surface | Why |
|---|---|
| Upstream Paperclip directories: `cli/`, `server/`, `ui/`, `packages/`, `evals/`, `tests/`, `releases/`, `report/`, `patches/`, `docker/`, `doc/`, upstream `docs/` | Modifying breaks upstream rebase. Customize via our directories instead. |
| `.mcp.json` MCP server core entries (filesystem/github/tavily/fetch) | These are the four wired servers every agent depends on. Removing one breaks dozens of agents. Add new servers, don't remove existing ones. |
| `~/.paperclip` directory | Holds embedded Postgres data + Paperclip's own state. Not in this repo. Back up via `scripts/backup-paperclip-db.sh` before any risky operation. |
| `~/.paperclip/adapter-plugins.json` | Registers our adapters by absolute path. Don't symlink into upstream `packages/` — breaks on rebase. |
| Per-agent `cwd` in `.paperclip.yaml` (`/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org`) | Set deliberately so agents inherit `.mcp.json` and `opencode.json` from the repo root. Changing breaks MCP wiring. |
| `vault/` schema (frontmatter + tags + `[[wikilinks]]`) | Obsidian compatibility depends on it. Markdown-with-frontmatter is contract. |
| Cardinal rules in `CLAUDE.md` and `CULTURE.md` | These are organizational constants. Changing any of them is a Vardaan-G4 decision, not an engineering decision. |
| The 5-gate pipeline structure | Adding gates is heavy (see "Add a new gate" above). Removing one is a CULTURE.md change — needs G4. |
| Vendor scope (Anthropic + OpenAI + Google + community) | Hard rule. No new vendor researchers without explicit user instruction. See `~/.claude/projects/.../memory/project_vendor_scope.md`. |
| ElevenLabs as a TTS option | Forbidden. Use Kokoro / OmniVoice / Cartesia / Chatterbox. |
| Gemini 2.5 Flash model | Excluded by user 2026-04-29. Use Gemini 3 Flash Preview or 3.1 Flash Light Preview instead. |
| `.gitignore.koenig` mappings (vault content tracking) | Carefully crafted. Vault content is tracked; secrets and ephemeral files are not. |
| Worktree structure for engineering (`learnovaBeast-fe-agent/`, `learnovaBeast-be-agent/`) | Provides isolation between planner/executor + code-reviewer + qa-verifier. Collapsing them causes cross-pollution. |

---

## 13. Cross-references

| Doc | Path | When to read |
|---|---|---|
| Repo-wide overview | `../../README.md` | Start here |
| Repo-wide Claude Code context | `../../CLAUDE.md` | Cardinal rules |
| Master plan | `../../docs/FINAL_IMPLEMENTATION_PLAN.md` | V1/V2/V3 decisions |
| Paperclip best practices | `../../docs/paperclip-best-practices.md` | Orchestrator idioms |
| Architecture (repo-wide) | `../../docs/architecture.md` | Upstream + customization split |
| Runbook | `../../docs/runbook.md` | Day-to-day operations |
| Secrets checklist | `../../docs/SECRETS_CHECKLIST.md` | New-machine setup, deploys |
| ADR 0001 | `../../docs/ADR/0001-three-repo-split.md` | Why agency/product/upstream are separate repos |
| ADR 0002 | `../../docs/ADR/0002-paperclip-fork-vs-dep.md` | Why we forked instead of npm-installing |
| ADR 0003 | `../../docs/ADR/0003-no-workos-anonymous-academy.md` | Why anonymous-by-default |
| V2 producer expansion | `../../docs/V2_PRODUCER_EXPANSION.md` | NotebookLM / open-notebook drivers |
| Per-company COMPANY.md | `./COMPANY.md` | Org chart + workflow patterns |
| Per-company CULTURE.md | `./CULTURE.md` | Norms — read by every SOUL |
| Per-company .paperclip.yaml | `./.paperclip.yaml` | Runtime overrides (per-agent adapter, model, budget, schedule, env) |
| Per-company Claude Code context | `./CLAUDE.md` | Read when an agent's `cwd` is the company folder |
| Agent SOULs | `./agents/<role>/SOUL.md` | Per-agent identity (read every heartbeat) |
| Agent operational | `./agents/<role>/AGENTS.md` | Per-agent DOD + reporting format |
| Shared skills | `../../shared-skills/` | Reusable how-tos referenced from SOULs |

---

## 14. Open questions / future work

Tracked here so they don't get lost between repos.

- **Vault MCP wiring is incomplete** as of 2026-04-29 smoke tests. Filesystem MCP is up; per-agent path discipline is SOUL-enforced not ACL-enforced. Tighten in V2 if drift appears.
- **Langfuse self-host deferred.** Use Langfuse Cloud free tier in V2. Self-host blocked by Keeper-less ClickHouse migration. See `observability/clickhouse-data/`.
- **Convex `agentApi.ts`** (Phase 1.4) — bearer-auth HTTP action for course/blog publishing. `ACADEMY_AGENT_API_KEY` is the bearer.
- **Kilo Code adapter** (V2 option) — community adapter at `github.com/xzessmedia/paperclip-kilocode-adapter` exists. Add when we have a clear use case (likely bulk refactor work where Kilo's Agent Manager shines).
- **`Self-Refine Trainer agent`** (V3) — DSPy v2 weekly cron over agent SOULs against past-week outputs + outcomes. Layered in only after we have V1 + V2 eval data.
- **Recall.ai Teams huddle bot** (V3) — joins Teams call, posts EOD update with TTS.
- **Cloudflare Tunnel + Cloudflare Access** for Paperclip UI external access (V3).

---

*Last updated: 2026-04-29. When you change a number, schedule, or secret, update this doc in the same commit.*
