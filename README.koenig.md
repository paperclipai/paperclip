# koenig-ai-org

A 24/7 AI agent organization — fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — running the **Koenig AI Academy** at https://academy.kspl.tech.

> **What this is:** 21 specialized agents (CEO + 4 Chiefs + workers) writing blogs, designing courses, reviewing each other's work, deploying code, and verifying live pages — autonomously, on a 24/7 cron schedule, under human approval at G4. As of 2026-04-30 the org has shipped 1 blog end-to-end through all 5 gates ($0.89 cash spend that day, ~13 heartbeats; the rest absorbed by Claude Max 20x subscription).

## Quick links

| | |
|---|---|
| **Live site** | https://academy.kspl.tech |
| Paperclip dashboard (local) | http://localhost:3100 |
| Upstream | [paperclipai/paperclip](https://github.com/paperclipai/paperclip) |
| Companion repo (frontend) | [Koenig-Solutions-Private-Limited/learnovaBeast](https://github.com/Koenig-Solutions-Private-Limited/learnovaBeast) — `learnova-academy/` portal |
| Vault (Obsidian) | `~/Documents/Paperclip/koenig-ai-org/vault/` |
| Open-Notebook | http://localhost:8502 (Docker) |
| Master plan | `~/.claude/plans/https-github-com-koenig-solutions-privat-sunny-waffle.md` |

## The org chart — 21 agents

```
                              CEO (Sonnet 4.6)
                              │
       ┌────────────┬─────────┼──────────┬──────────────┐
       │            │         │          │              │
  Chief Research  Chief    Chief        Chief        (cross-team)
       │         Content  Engineering  Marketing       │
       │            │         │          │              │
   ┌───┼────┐   ┌───┼───┐   ┌─┼─┐    SEO Optimizer  Vault Historian
   │   │    │   │   │   │   │ │ │      (+ claude-seo  Publish Verifier
  R-A R-O R-G  Author Reviewer Plan          24 sub-skills)
       │    R-C  /Course Slide-Audio Exec
   Research-Editor (G0)  Voice    G_code (Codex/GPT-5)
                                  G2 (Haiku QA)
```

### Researchers (5)
- `researcher-anthropic` `researcher-openai` `researcher-google` `researcher-community` — Grok 4.1 Fast via OpenCode→OpenRouter, 06:00 IST daily; vault notes per vendor
- `research-editor` (Sonnet 4.6) — synthesizes 4 vendor notes into the daily brief at 06:30 IST

### Content (5)
- `blog-author` (Sonnet 4.6) — 800-1500 word blog posts, traffic + AI-citation focus, contrarian angle required
- `course-author` (Sonnet 4.6) — outline-first multi-chapter courses, 2,000-5,000 words/chapter, hands-on exercises required
- `content-author` (Gemini 3 Flash Preview) — legacy fallback; new work goes to blog/course-author
- `content-reviewer` (Sonnet 4.6) — **G0 gate**, 5-dimension review, blocks decisively
- `slide-audio-producer` (Sonnet 4.6) — drives notebooklm-py for slide decks + audio overviews + flashcards
- `voice-producer` (Haiku 4.5) — Kokoro TTS, Nova brand voice, short-form intros/outros

### Engineering (4) — Anthropic Harness pattern
- `planner` (Opus 4.7 with `--permission-mode plan`) — designs the work
- `executor` (Opus 4.7, no plan mode) — same model + context, different role; opens real PRs
- `code-reviewer` (Codex CLI / GPT-5) — **G_code gate**, different model = different lens
- `qa-verifier` (Haiku 4.5) — **G2 gate**, runs tests + browser walkthroughs via browser-use

### Marketing/SEO (2)
- `chief-marketing` (Sonnet 4.6) — dispatches SEO work, runs llms.txt audit
- `seo-optimizer` (Sonnet 4.6) — wields 13 of the 24 claude-seo sub-skills (audit, schema, geo, backlinks, etc.) + our `seo-optimize` / `geo-optimize` / `aeo-optimize` skills

### Curation + verification (2 — added 2026-04-30 evening)
- `vault-historian` (Sonnet 4.6) — daily curates `vault/_index/` (by-date, by-agent, per-person profiles), weekly timeline, monthly health audit
- `publish-verifier` (Haiku 4.5) — **G5 gate** (post-publish): fetches live URL, validates schema/citations/og:image/sitemap presence, routes regressions to the right team

## The 5-gate publish pipeline

Every piece of content flows through:

| Gate | Owner | What | If blocked → routes to |
|---|---|---|---|
| **G0** | content-reviewer | Editorial: accuracy, brand voice, structure, completeness, spam-brain | Author for revision |
| **G_code** | code-reviewer | (Engineering only) plan adherence + bugs + tests | Executor or Planner |
| **G2** | qa-verifier | Tests pass + browser walkthrough + content fact-check | Executor (via Code Reviewer) |
| **G3** | ceo | Strategic alignment + budget + scope creep check | Relevant chief |
| **G4** | **Vardaan (human)** | Final approval via email magic-link OR Slack/Teams OR Paperclip UI queue | Author |
| **G5** | publish-verifier | Post-publish live-site validation | chief-engineering / chief-content / etc. per issue type |

## 5-minute onboarding (fresh Mac)

```bash
# 1. Clone both repos
gh repo clone Koenig-Solutions-Private-Limited/koenig-ai-org ~/Documents/Paperclip/koenig-ai-org
gh repo clone Koenig-Solutions-Private-Limited/learnovaBeast ~/Documents/Paperclip/learnovaBeast

# 2. Install deps
cd ~/Documents/Paperclip/koenig-ai-org && pnpm install
cd ~/Documents/Paperclip/learnovaBeast/learnova-academy && pnpm install

# 3. Boot Paperclip
cd ~/Documents/Paperclip/koenig-ai-org && pnpm dev   # http://localhost:3100

# 4. Configure secrets (one-time)
cp .env.koenig.example .env.koenig
# Edit .env.koenig with: TAVILY_API_KEY, XAI_API_KEY, RESEND_API_KEY, GH_TOKEN, VERCEL_TOKEN, GOOGLE_SITE_VERIFICATION
./scripts/sync-secrets.sh

# 5. Import the company
pnpm paperclipai company import companies/learnova-academy --yes

# 6. Auth external CLIs (interactive, one-time)
codex auth login
notebooklm login
gh auth login

# 7. Install launchd agents (24/7 ops)
./scripts/load-launchd-agents.sh

# 8. Boot open-notebook (audio fallback)
docker compose -f observability/open-notebook/docker-compose.yml up -d

# 9. Trigger a manual research cycle to verify
curl -X POST http://localhost:3100/api/agents/<researcher-anthropic-id>/heartbeat/invoke
```

## File layout

```
koenig-ai-org/
├── companies/learnova-academy/          # The Academy company package
│   ├── COMPANY.md                       # Org chart + culture
│   ├── CULTURE.md                       # Cross-agent collaboration norms
│   ├── ARCHITECTURE.md                  # Architecture deep-dive
│   ├── .paperclip.yaml                  # Per-agent adapters, models, budgets, schedules
│   ├── agents/<slug>/AGENTS.md          # Operational doc per agent
│   ├── agents/<slug>/SOUL.md            # Identity + collaboration (read every heartbeat)
│   ├── skills/<slug>/SKILL.md           # 38 skill packs
│   └── seed-topics-<date>.yaml          # Content backlog YAML
├── vault/                               # Obsidian vault — agent narrative output
│   ├── research/{anthropic,openai,google,community}/  # daily vendor notes
│   ├── research/_daily/                 # synthesized briefs
│   ├── courses/<slug>/                  # chapter markdown
│   ├── blogs/<date>-<slug>/             # blog drafts
│   ├── decisions/                       # ADR-style decision docs
│   ├── retrospectives/{<agent>,_team,_company}/  # AAR per task
│   ├── _index/                          # vault-historian indices
│   └── _audit/                          # vault-historian health audits
├── adapters/                            # Custom Paperclip adapters
├── docs/                                # AUTONOMOUS_OPS.md, V2_SEEDING.md, ADR/, runbook
├── infra/launchd/                       # macOS 24/7 plists
├── observability/                       # langfuse + open-notebook
├── scripts/                             # bootstrap, sync-secrets, publish-action, etc.
├── .env.koenig                          # secrets (gitignored)
├── .mcp.json                            # Claude Code MCP servers
└── opencode.json                        # OpenCode MCP servers
```

## Cost model

| Bucket | Mechanism | Today's spend |
|---|---|---|
| OpenRouter (Grok + Gemini) | Pay-as-you-go | **$0.89 cash** |
| Anthropic (CEO + Chiefs + Author + Reviewer) | Claude Max 20x subscription | $0 cash, ~13 heartbeats consumed |
| Codex CLI (code-reviewer) | ChatGPT Plus subscription | $0 cash |
| NotebookLM (slide-audio) | Paid NotebookLM account | $0 incremental (existing subscription) |
| Vercel deploys | Free tier | $0 |
| OpenAI/Anthropic if Max quota exhausts | Pay-as-you-go fallback (not yet wired) | — |
| **Per-agent monthly caps** | Enforced by Paperclip | **$680/mo total ceiling** |

Watchdog at `watchdog/watchdog.mjs` enforces per-task caps in real time and pauses agents at 100% monthly.

## Operations basics

### Where logs live
- **Per-agent runs:** Paperclip dashboard at http://localhost:3100/agents/all → click agent → Runs tab
- **Heartbeat history:** `GET /api/companies/<id>/heartbeat-runs?limit=50`
- **Cost summary:** `GET /api/companies/<id>/costs/summary` (real cash) and `/costs/by-agent`
- **launchd logs:** `~/.paperclip/logs/`

### Trigger a heartbeat manually
```bash
AGENT_ID=$(curl -s 'http://localhost:3100/api/companies/<id>/agents' | jq -r '.[] | select(.urlKey=="<slug>") | .id')
curl -X POST "http://localhost:3100/api/agents/$AGENT_ID/heartbeat/invoke" -H "Content-Type: application/json" -d '{}'
```

### Vault writes location
All agent narrative output lands in `vault/`. The `vault-historian` agent maintains indices at `vault/_index/`. Open Obsidian.app → Open another vault → point to `vault/`.

### Common modifications
- **Add a new agent**: see `companies/learnova-academy/ARCHITECTURE.md` § Common Modifications
- **Add a new skill**: write `companies/learnova-academy/skills/<slug>/SKILL.md`, add the slug to the relevant agent's `skills:` list, re-import the company
- **Add a new company**: copy `companies/_template/` → `companies/<new-product>/`, edit COMPANY.md + agents/, run `pnpm paperclipai company import companies/<new-product>`
- **Swap an agent's model**: edit `companies/learnova-academy/.paperclip.yaml` → re-import → `PATCH /api/agents/<id>` with new model

### When something breaks

| Symptom | First thing to check |
|---|---|
| All agents idle, nothing firing | Watchdog status (`launchctl list \| grep koenig`) + Paperclip server up (`curl http://localhost:3100/api/health`) |
| One agent stuck "running" forever | `GET /api/heartbeat-runs/<id>` for stderrExcerpt + errorCode |
| Vault note never landed | Filesystem MCP wired? Check `.mcp.json` + agent's cwd in `.paperclip.yaml` |
| Blog G0-passed but not on academy.kspl.tech | Vercel build + `KOENIG_VAULT_ROOT` env at build time |
| Cost runaway | `curl /api/costs/by-agent` to find the offender; pause via UI or `POST /api/agents/<id>/pause` |
| Agent loops endlessly | Watchdog should auto-pause; if not, check `~/.paperclip/logs/watchdog.log` |

## Cardinal rules (from CLAUDE.md)

1. **Inexpensive, not cheap.** Open-source MIT/Apache → free SaaS → cheap pay-as-you-go → premium only when quality demands.
2. **No ElevenLabs, ever.** Use Kokoro / OmniVoice / Cartesia / Chatterbox.
3. **CLI-maximalist.** Terminal-driven workflows. `browser-use` is the default browser automation.
4. **Newer/innovative > established** when quality is comparable.
5. **Obsidian is the knowledge interface.** All agent narrative output → `vault/` as markdown with frontmatter + tags + wikilinks.
6. **Two-agent content chain.** Author → Reviewer → G3 → G4 → publish. Never single-agent publish.
7. **Anonymous-by-default for the Academy.** Optional Convex email-OTP only.
8. **G4 = three approval channels.** Email magic-link + Slack/Teams + Paperclip UI queue.

## What lives where vs upstream

**Don't touch upstream files** unless absolutely necessary. Our customizations live entirely in: `vault/`, `companies/`, `adapters/`, `shared-skills/`, `watchdog/`, `observability/`, `infra/`, `scripts/`, `docs/`, `README.koenig.md`, `.env.example`. Upstream paths to leave alone: `cli/`, `server/`, `ui/`, `packages/`, `evals/`, `tests/`, `docker/`, `doc/`, the upstream `docs/` (we use `docs/` at the root for our own docs but never the upstream `doc/`).

Weekly cron: `./scripts/upstream-rebase.sh` rebases `main` from `upstream/main`. Conflicts only expected in `adapter-plugins.json`.

## Cross-references

- **Architecture deep-dive:** `companies/learnova-academy/ARCHITECTURE.md`
- **Day-in-the-life:** `docs/AUTONOMOUS_OPS.md`
- **Content seeding strategy:** `docs/V2_SEEDING.md`
- **Master plan:** `~/.claude/plans/https-github-com-koenig-solutions-privat-sunny-waffle.md`
- **ADRs:** `docs/ADR/`
- **Runbook:** `docs/runbook.md` (escalation playbooks per failure class)
- **Vendor watcher / vendor scope:** `companies/learnova-academy/skills/vendor-watcher/SKILL.md`
- **Frontend:** `~/Documents/Paperclip/learnovaBeast/learnova-academy/README.md`
- **CULTURE:** `companies/learnova-academy/CULTURE.md` — the shared norms every agent reads
- **Final implementation plan:** `docs/FINAL_IMPLEMENTATION_PLAN.md`
