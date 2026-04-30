# Paperclip operational best practices (April 2026)

Captured from research 2026-04-29. Source-of-truth for how we configure, run, and operate the agency.

## Built-in adapters (in this fork)

`packages/adapters/`:
- `claude-local` — Claude Code CLI (Anthropic auth via `claude` login)
- `codex-local` — Codex CLI (OpenAI auth)
- `cursor-local` — Cursor CLI
- `gemini-local` — Gemini CLI (Google account)
- `opencode-local` — OpenCode CLI (any provider via OpenCode's auth — including OpenRouter)
- `openclaw-gateway` — generic HTTP/protocol gateway (use for NVIDIA NIM, custom HTTP, etc.)
- `pi-local` — Pi

External adapters are first-class — `registerServerAdapter(adapter)` makes any non-empty string an accepted `adapterType`. We don't need to fork core to add adapters.

## Recommended adapter strategy

| Agent role | Adapter | Auth path |
|---|---|---|
| CEO / PM, Chiefs, Reviewer | `claude-local` | `claude` login (already done) |
| Backend Dev (when coding) | `codex-local` | OpenAI auth (`codex login` or `OPENAI_API_KEY`) |
| Researchers, Author, Verifier, Voice/Slide producers | `opencode-local` → OpenRouter | `opencode auth login openrouter` (one-time) |
| Custom HTTP integrations (Grok direct, NVIDIA NIM, etc.) | `openclaw-gateway` | per-integration |

**Why OpenCode → OpenRouter:** the OpenRouter key lives in `~/.opencode/auth.json` only. Paperclip env stays clean. Per-agent model picking is just `--model openrouter/anthropic/claude-sonnet-4-6` etc.

## SOUL.md structure (battle-tested template)

```markdown
# Soul: <Role Name>

**Lane:** <one sentence on the agent's responsibility>

**Definition of Done:**
- <concrete, testable bullet>
- <concrete, testable bullet>
- ...

**Never Do:**
- <hard prohibition>
- <hard prohibition>

**Reporting Format:**
Daily: <what they report end-of-day>
Weekly: <what they report end-of-week>

**Escalation triggers:**
- <when to ping CEO>
- <when to ping human via G4>
```

Keep ≤120 lines. Re-read on every heartbeat — concise wins.

## config.json (per-agent runtime)

```json
{
  "name": "Researcher · Anthropic",
  "role": "researcher",
  "title": "Anthropic news researcher",
  "icon": "🔍",
  "reportsTo": "chief-research",
  "adapter": "opencode-local",
  "model": "openrouter/x-ai/grok-4-1-fast",
  "monthlyBudgetUSD": 20,
  "perTaskBudgetUSD": 0.5,
  "capabilities": ["web-research", "citation-extraction"],
  "skills": ["vendor-watcher", "obsidian-vault-write"],
  "mcpServers": ["tavily", "firecrawl-or-crawl4ai"],
  "env": {
    "VENDOR_NAME": "anthropic",
    "VAULT_OUTPUT": "vault/research/anthropic"
  },
  "workingDirectory": "/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org"
}
```

**Secrets pattern:** never plaintext. Use `secret_ref:<uuid>` so rotation doesn't require redeployment, and audit logs capture access.

## GitHub integration (for engineer agents)

Two parts:
1. **Plugin**: `paperclip-plugin-github-issues` — bidirectional Issues sync; agents search issues, link PRs, track CI.
2. **Coding adapter** uses Claude Code's `--worktree` flag for isolated coding, so multiple engineer agents never collide.

Webhook to register: `POST https://<paperclip-host>/api/plugins/paperclip-plugin-github-issues/webhooks/github-events` with a fine-grained PAT (repo scope).

For us: the Frontend Dev + Backend Dev agents will both be `claude-local` or `codex-local` agents that operate inside `learnovaBeast` worktrees on the `academy/redesign-v1` branch. CEO orchestrates merges.

## MCP servers we'll wire (V1 + V2)

| Server | When | Purpose |
|---|---|---|
| Tavily | V1 | Free-tier search for researchers |
| Crawl4AI (self-host) | V1 | Cheap web scraping, no rate limits |
| Firecrawl | only if Crawl4AI fails | Fallback scraper |
| Postgres | V1 | Convex-via-jdbc for QA fact-check |
| Filesystem | V1 | Vault read/write |
| GitHub Issues plugin | V2 | Engineering chief and devs |
| Slack | V2 | G4 approvals + alerts |
| Outlook/Gmail | V2 | Email-based approvals + briefing inbox |
| Recall.ai | V3 | Teams huddle |

## 5-gate approval flow (G0 → G4)

Implementation pattern (from research):

```
Agent finishes work
  → POSTs to Paperclip /api/approvals with G0..G4 stage
  → Slack plugin posts: ✅ approve / ❌ reject buttons
  → Email magic-link as parallel surface
  → Paperclip UI shows pending queue
  → Any one channel approves → publish action fires
  → Audit log entry on Convex + agentRuns row
```

Skill pack `approval-gate` (we'll write) wraps the API call so individual agents don't reinvent this.

## REST API endpoints (server side)

Base: `http://localhost:3100/api`. Auth via bearer token.

- `POST /api/companies/{companyId}/agents` — hire
- `GET  /api/companies/{companyId}/tasks` — list tickets
- `POST /api/approvals` — open approval request
- `POST /api/companies/{companyId}/heartbeats` — manually trigger a heartbeat (mostly cron-driven)
- `GET  /api/costs/summary` — token spend by agent (watchdog reads this)
- `POST /api/agents/:id/pause` — watchdog pauses on circuit-breaker

`X-Paperclip-Run-Id` on mutations during a heartbeat run links audit entries to the originating run.

## Public companies to crib from

`paperclipai/companies` ships 16 production-ready templates including:

- **Fullstack Forge** (49 agents, 66 skills) — full SDLC; great `github-pr-flow` patterns
- **Product Compass Consulting** (48 agents) — product/UX decision flows
- **Trail of Bits Security** (28 agents) — multi-agent security audit
- **Donchitos Game Studio** (48 agents) — asset creation + deploy

Each has `COMPANY.md`, `agents/` configs, `skills/` markdown packs. We'll borrow the `github-pr-flow`, `qa-checker`, and `daily-research` shapes.

## Skill marketplace

- **Clipmart** (`paperclipai/clipmart`) — official, in development, not yet launched.
- **ClipMarts.com** (third-party) — 247+ company templates, SOUL packs, MCP bundles. Browse for inspiration; cross-check before adopting.
- **awesome-paperclip** (gsxdsm/awesome-paperclip) — curated index.

## Documented community plugins worth pulling

- `mvanhorn/paperclip-plugin-github-issues`
- `mvanhorn/paperclip-plugin-slack`
- `mvanhorn/paperclip-plugin-discord`
- `Wizarck/paperclip-mcp` — exposes Paperclip's REST API as MCP tools (so other agents can drive Paperclip)
- `talhamahmood666/paperclip-adapter-openrouter` — backup if we ever want a Paperclip-native OpenRouter adapter (we're using OpenCode instead)

## Operational caveats

1. **Loop / cost runaway** — Issue #390 still open. Watchdog (this repo: `watchdog/watchdog.mjs`) pauses agents at 5 consecutive no-status-delta heartbeats or 2× rolling-avg tokens-per-task.
2. **Worktree isolation for code** — multiple engineer agents must use `claude code --worktree` to avoid file collisions on shared branches.
3. **Heartbeat = fresh context** — agents do NOT keep working memory between cycles. The vault and `agentTaskSessions` table are persistence. Design SOULs to expect fresh-context every wakeup.
4. **Secret refs over plaintext** — for any GitHub PAT, OpenAI key, etc. Plaintext in config.json is a deployment-time leak risk.
5. **`claude-local` adapter respects `claude` CLI's login state** — so Vardaan's existing Claude Code login powers all `claude-local` agents at no per-agent auth cost.

## Sources

- https://github.com/paperclipai/paperclip
- https://docs.paperclip.ing
- https://github.com/paperclipai/companies
- https://github.com/mvanhorn/paperclip-plugin-github-issues
- https://github.com/mvanhorn/paperclip-plugin-slack
- https://github.com/Wizarck/paperclip-mcp
- https://github.com/gsxdsm/awesome-paperclip
- https://www.paperclipskills.com/
- https://www.clipmarts.com/
- https://github.com/paperclipai/paperclip/discussions/839
