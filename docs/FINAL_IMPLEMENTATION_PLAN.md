# Final implementation plan — Koenig AI Academy + learnova-academy company

Captures every decision made through 2026-04-29 evening. This is the source-of-truth for V1 / V2 / V3. Cross-checked against the master plan at `~/.claude/plans/...` and the spec at `docs/companies/companies-spec.md`.

---

## TL;DR

We are building **two coordinated repos**:

1. **`learnovaBeast/learnova-academy`** — the AI-learning product. New 5th portal in the existing `learnovaBeast` monorepo. Branch `academy/redesign-v1`. Direction-5 design (teal `#0d8a6b` + blue `#1d4ed8` + cyan `#0891b2` link + amber `#d97706` streak). Anonymous-by-default; opt-in Convex email-OTP for progress.

2. **`koenig-ai-org/companies/learnova-academy`** — the Paperclip company that runs the product 24/7. 18 agents, hybrid hub-and-spoke + per-stream pipelines, 5-gate publish (G0→G1→G2→G3→G4). Total ~$680/mo cap.

The product's frontend = Next.js 16 + Convex + Tailwind v4. The agency = forked Paperclip + custom adapters + Obsidian vault. The two repos talk over a bearer-auth Convex HTTP action.

---

## State on disk (verified 2026-04-29)

✅ **Paperclip running** on `http://127.0.0.1:3100` (embedded Postgres on `:54329`, Agent JWT configured, heartbeat enabled, secrets adapter ready).

✅ **`koenig-ai-org`** — fork of paperclipai/paperclip with our customisations:
- `vault/` Obsidian vault (research/courses/decisions/retrospectives/people)
- `companies/learnova-academy/` — `COMPANY.md` ✓ `README.md` ✓ `LICENSE` ✓ `.paperclip.yaml` ✓ `CLAUDE.md` ✓
- `adapters/` skeletons for openrouter / browser-use / kokoro-tts / etc.
- `shared-skills/` skeletons for vendor-watcher / course-author / etc.
- `watchdog/watchdog.mjs` (loop + cost circuit breaker)
- `observability/docker-compose.yml` (Langfuse, deferred)
- `infra/launchd/` plists (caffeinate keepalive, watchdog)
- `scripts/` upstream-rebase, seed-company, backup-paperclip-db, task
- `docs/` architecture, runbook, ADRs 0001-0003, paperclip-best-practices, this plan

✅ **`learnovaBeast/learnova-academy`** scaffolded as 5th portal:
- `package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`
- `src/app/academy.css` — D5 unified tokens (~330 lines)
- `src/app/layout.tsx`, `src/app/page.tsx` (placeholder)
- `src/lib/cn.ts`, `src/lib/fixtures.ts` (TypeScript port of v3 data.js, all 12 courses + news + skill tree + lesson, ~349 lines)
- `src/components/_shared/icons.tsx` (47 Lucide-style icons, ~353 lines)
- `src/components/_shared/chrome.tsx` (TopBar, NovaAvatar, Logo, DarkToggle, VendorMark, TypeChip, StreakHud, ~295 lines)

✅ **Memory** — 12 entries in `~/.claude/projects/-Users-vardaankoenig-Documents-Paperclip/memory/` capturing user profile, feedback (no ElevenLabs, CLI-first, Obsidian, inexpensive-not-cheap), project state, references.

✅ **CLI tooling** — Claude Code, Codex, Gemini, OpenCode, Aider, browser-use, gh, Docker, pnpm, uv all installed and working. OpenCode authenticated against OpenRouter (`~/.local/share/opencode/auth.json`). User has Kilo Code via Vercel AI Gateway (separate path).

⏸ **Deferred for V1**:
- Convex agent HTTP API (`learnova-tc/convex/agentApi.ts`) — Phase 1.4
- Langfuse self-host (Keeper-less ClickHouse migration issue) — use Langfuse Cloud free tier in V2
- Kilo Code adapter — community adapter at `github.com/xzessmedia/paperclip-kilocode-adapter` exists; add in V2 if we need a 3rd engineering agent

---

## Decided architecture

### The 18-agent company

```
CEO (Opus 4.7) — delegates only, never executes
│
├── Chief Research → 4 Researchers (Grok 4.1 Fast) + Research Editor (Sonnet 4.6)
├── Chief Content  → Author (Gemini 2.5 Flash) + Reviewer (Sonnet 4.6) + Slide+Audio + Voice
├── Chief Engineering (Sonnet 4.6) → Planner-Executor (Opus 4.7 plan-mode) + Code Reviewer (Codex/GPT-5) + QA Verifier (Haiku 4.5)
└── Chief Marketing/SEO → SEO Optimizer
```

Hybrid: hub-and-spoke at the top (CEO routes by ticket type), pipeline within each chief's stream (gates ensure quality).

### 5-gate publish pipeline

| Gate | Owner | What |
|---|---|---|
| **G0** Content review | Content Reviewer (different agent from Author) | Accuracy, brand voice, citations, structure |
| **G_code** Code review | Code Reviewer (Codex with reviewer prompt) | Diff audit, lint, security, test coverage |
| **G2** QA verification | QA Verifier (Haiku 4.5 + browser-use) | Tests pass, browser walkthrough, fact-check vs research sources |
| **G3** CEO alignment | CEO | Original ticket alignment, budget vs allotted, rollup |
| **G4** Human approval | Vardaan | Email magic-link + Slack/Teams button + Paperclip UI queue |

### Workflow patterns by ticket type

| Ticket | Agents in path |
|---|---|
| Daily blog | Researchers ‖ → Editor → CEO triage → Author → Reviewer (G0) → CEO (G3) → Human (G4) → publish |
| New course | Editor → CEO → Author + Slide+Audio + Voice (parallel) → Reviewer (G0) → CEO (G3) → Human (G4) → publish |
| Course delta | Editor → CEO → Author (small) → Reviewer (G0) → CEO (G3) → Human (G4) → patch |
| Bug / UI | Vardaan or QA → CEO → Chief Eng → Planner-Executor → Code Reviewer (G_code) → QA (G2) → CEO (G3) → Human (G4) → merge |
| SEO | SEO Optimizer → CEO (G3) → Human (G4) → publish |

### Engineering harness pattern

Anthropic's April 2026 "Harness Engineering" architecture (Planner → Generator → Evaluator with structured handoffs + context resets). Our mapping:
- **Planner-Executor** uses Claude Code with `--permission-mode plan` for the planning phase, then exits plan mode and executes the same context. Emits structured plan to `vault/decisions/`.
- **Code Reviewer** is a separate Codex agent with reviewer-prompt: same knowledge base, "audit don't propose; demand evidence" lens. G_code gate.
- **QA Verifier** runs tests + browser-use end-to-end + cross-checks content against research sources. G2 gate.

15+ iterations possible per ticket; not one-shot. Worktree isolation prevents two engineers from colliding (`learnovaBeast-fe-agent/`, `learnovaBeast-be-agent/`).

### Self-improvement (V1)

After every task, the agent's manager writes a 3-line after-action review to `vault/retrospectives/<agent-slug>/<date>-<task-id>.md`:
1. What worked
2. What to fix
3. SOUL update proposed (yes/no — exact line if yes)

Weekly Mon 09:00 IST: each chief reads their team's retros and writes a 1-page weekly summary. CEO batches proposed SOUL changes for Vardaan G4 approval. Continuous + low-overhead. No DSPy / Self-Refine Trainer in V1 — those layer in V3 with real eval data.

### Cost discipline

| Tier | Monthly cap |
|---|---|
| CEO | $80 |
| Chiefs (5) | $40–120 each |
| Researchers (4) + Editor | $100 |
| Content team (4) | $90 |
| Engineering team (3) | $110 |
| QA + SEO | $40 |
| **Total ceiling** | **~$680** |

Paperclip enforces 80% soft + 100% hard auto-pause natively. Watchdog adds: pause on 5 consecutive heartbeats with no status delta, pause on 2× rolling-avg tokens-per-task. Per-task hard caps prevent single-task runaway.

### Secrets layout

| Secret | Where | Why |
|---|---|---|
| OpenRouter key | `~/.local/share/opencode/auth.json` (already done) | OpenCode primary auth; never in env |
| Vercel AI Gateway key | OpenCode provider config (alternative) | User has both available; OpenCode picks |
| `XAI_API_KEY` | Paperclip Secrets store (encrypted) | Grok x_search direct (community researcher) |
| `TAVILY_API_KEY` | Paperclip Secrets store | Free-tier search for all researchers |
| `RESEND_API_KEY` | Paperclip Secrets store | EOD digest + G4 magic-link emails |
| `GH_TOKEN` | Paperclip Secrets store | Engineering agents open PRs |
| `ACADEMY_AGENT_API_KEY` | Paperclip Secrets store | Bearer for Convex agentApi.ts (Phase 1.4) |
| `CLOUDFLARE_R2_*` | Paperclip Secrets store | Media uploads (Phase 1.4) |

Per Paperclip's secrets adapter docs: encrypted at rest in `~/.paperclip/instances/default/secrets/`. We never put secrets in `.env` or check them into git.

### Adapter strategy + Kilo Code

Built-in Paperclip adapters used:
- `claude_local` — Claude Code CLI for CEO, all Chiefs, Reviewer, Slide+Audio, Voice, Planner-Executor, QA
- `codex_local` — Codex CLI for Code Reviewer (reviewer prompt)
- `opencode_local` — OpenCode → OpenRouter (or Vercel AI Gateway) for the 4 Researchers + Content Author

**Kilo Code (V2 option):** the user has Kilo Code configured via Vercel AI Gateway. Community adapter `github.com/xzessmedia/paperclip-kilocode-adapter` exists. We register it in V2 when we have a clear use case — most likely as an alternate Backend Dev for bulk refactoring tasks where Kilo's Agent Manager (visual side-by-side multi-model comparison) shines. Not in V1 — keeps the surface area smaller.

---

## Phases — V1 / V2 / V3 (refined)

### V1 — ship in 2-4 weeks

**Stream A: Frontend (learnovaBeast/learnova-academy)**
- ✅ Portal scaffold + tokens.css + foundation (icons, chrome, fixtures)
- ⏳ Foundation: `_shared/content.tsx`, `_shared/TutorRail.tsx`, `_shared/CommandPalette.tsx`
- ⏳ 6 pages: Home (02), Catalog (03), Lesson Interactive (04 hero), Lesson PDF (05), Lesson Video (06), Tutor Q&A (07 dark-mode)
- ⏳ Strip WorkOS via `AUTH_MODE=anonymous` middleware no-op
- ⏳ SEO + GEO: schema.org JSON-LD (Course/FAQ/HowTo/VideoObject), `/llms.txt`, `/llms-full.txt`, sitemap.xml, OG images

**Stream B: Convex backend (learnova-tc/convex)**
- ⏳ Schema additions: `courses.content_type`, `vendor_tag`, `learning_objectives`, `whats_new`, `is_blog`, `agentRuns` table
- ⏳ `convex/agentApi.ts` — bearer-auth HTTP action for course/blog publishing (Zod-validated)
- ⏳ Convex vector index over lessons for AI tutor RAG
- ⏳ Optional Convex email-OTP path via Resend for progress tracking

**Stream C: Paperclip company (koenig-ai-org/companies/learnova-academy)**
- ✅ COMPANY.md + .paperclip.yaml + README + LICENSE
- ⏳ 4 `TEAM.md` files (Research, Content, Engineering, Marketing)
- ⏳ 18 `AGENTS.md` files (one per agent)
- ⏳ 7+ `SKILL.md` files (vendor-watcher, course-author, content-reviewer, plan-and-execute, code-review, qa-checker, seo-optimizer)
- ⏳ Import via `paperclipai company import --from companies/learnova-academy`
- ⏳ Add secrets via Paperclip UI Secrets store
- ⏳ Hire each agent in UI; wire adapters
- ⏳ Smoke-test each agent (one trivial task; verify model + budget + audit log)

**V1 exit gate**: A complete daily cycle runs end-to-end with no human intervention except the G4 approval. Output: at least one course delta or blog created from that day's research, all 5 gates passed, `vault/research/_daily/<date>.md` written, EOD digest email sent.

### V2 — layer in (after 4-8 weeks of V1)

- **PostHog** product analytics + GrowthBook A/B testing
- **Optimizer agent** (#19) reads metrics, proposes hypotheses, runs A/B tests
- **Documenter agent** (#20) auto-syncs Fern docs + IcePanel architecture diagrams
- **Kilo Code adapter** if we hit a refactor that warrants a 3rd engineering agent
- **Langfuse Cloud** free tier for full-fidelity agent traces + evals
- **First multi-product clone** — `seed-company.sh` to spin up `companies/marketing/`

### V3 — self-tuning (after 8-12 weeks of V2 data)

- **DSPy v2** weekly cron over agent SOULs against past-week outputs + outcomes
- **Self-Refine** wrapper around content-producing agents
- **Self-Refine Trainer agent** (#21) proposes SOUL updates → CEO → G4
- **Teams huddle** (Recall.ai bot joins, posts EOD update with TTS)
- **Cloudflare Tunnel** + Cloudflare Access for Paperclip UI external access

---

## Smoke-test plan (V1 exit gate)

After import + adapter wiring + secrets, run **one trivial task per agent** and verify:

| Agent | Smoke task | Expected response |
|---|---|---|
| CEO | "Summarise this research note in 50 words" (paste sample) | Concise summary, no fabrication |
| Chief Research | "How would you delegate today's vendor scan?" | Plan citing 4 researchers + editor |
| Researcher · Anthropic | "Find Anthropic news from yesterday" | Returns 1-3 cited items |
| Research Editor | "Synthesise these 4 notes" (paste samples) | Cross-linked daily brief |
| Chief Content | "Outline a 5-chapter course on Claude tools" | Module + lesson titles |
| Content Author | "Write the first 200 words of chapter 1" | Draft prose, no hallucinated APIs |
| Content Reviewer | "Review this draft" (paste) | ✅ or ✏️ with line-level feedback |
| Slide+Audio Producer | "Plan a slide deck for chapter 1" | List of 5-8 slides |
| Voice Producer | "Generate voiceover script for slide 3" | 30-50 sec script |
| Chief Engineering | "Plan a fix for issue X" (paste) | Sketch of approach + agents involved |
| Planner-Executor | "Plan the fix in plan mode" | Structured plan, no code |
| Code Reviewer | "Review this PR diff" (paste) | Concrete issues, demands evidence |
| QA Verifier | "Walk through this UI flow" | browser-use plan + checks |
| Chief Marketing/SEO | "Suggest SEO improvements for /catalog" | 3-5 specific changes |
| SEO Optimizer | "Generate JSON-LD for course X" | Valid schema.org Course |

A green run on all 18 = company is healthy → proceed to first scheduled cycle.

---

## Self-review (third-party lens)

Looking at this plan from outside, the things that worry me:

1. **Plan-mode toggle mid-session** in the Planner-Executor. The Anthropic harness pattern uses **separate context resets** between Planner and Generator. Our "same agent, plan-then-execute" might not give clean handoffs. **Mitigation**: keep Planner-Executor as one agent for V1 (simpler), but if we see drift, split into two agents (one always in plan mode, one always in execute) in V1.5.

2. **Researcher quality on Grok 4.1 Fast.** Cheap and fast, but for synthesis-heavy work we might need Sonnet. **Mitigation**: V1 keeps Grok for raw scrape + citation; Sonnet on Editor for synthesis. If quality lacks, upgrade community researcher first (it does the most synthesis-like work via x_search).

3. **18 agents from day 1** is on the high end of the spec's "lean" advice. **Mitigation**: enable agents in waves — week 1 = CEO + Researchers + Editor only (research stream). Week 2 add Content stream. Week 3 add Engineering. Week 4 add Marketing. This catches problems with one stream before stacking.

4. **Convex schema changes touch the master `learnova-tc`.** Risk of breaking other Learnova portals. **Mitigation**: schema changes go through the same 5-gate engineering loop; QA tests all 4 portals (not just Academy).

5. **Anonymous-by-default + opt-in OTP** for the Academy may create messy session-merging when a user signs in mid-session. **Mitigation**: Convex `users.anonymousMerge` mutation that backfills the OTP user with the anonymous-session's progress on first sign-in.

6. **5-gate pipeline could add latency.** A simple blog post takes 5 hops before publishing. **Mitigation**: G0 + G1 + G2 + G3 are all AI-paced (seconds-to-minutes). G4 is the human bottleneck — defaulted to "auto-publish small content updates after 24h with no human response" can be added in V1.5 if backlog grows.

7. **`vault/` writes are not transactional with Convex writes.** An agent could write to vault then crash before pushing to Convex. **Mitigation**: vault is the narrative source-of-truth; Convex is the structured published surface. Vault written first; Convex push is an explicit `learnova-publish` adapter call after G4. If Convex push fails, retry from vault content.

8. **Costs may spike on cold start.** First few cycles, agents over-research because their SOULs are conservative. **Mitigation**: tight per-task caps + watchdog + manual review of week-1 token spend.

---

## What's next (immediate)

1. Continue writing the company package: 4 TEAM.md, 18 AGENTS.md, 7+ SKILL.md (this turn + 1-2 more)
2. After the package is complete, run `pnpm paperclipai company import --from companies/learnova-academy`
3. Add secrets via Paperclip UI
4. Wire adapters; hire all 18 agents
5. Run smoke tests per the table above
6. Enable Researchers (week 1 cohort) and run the first 06:00 IST cycle
7. Resume Frontend implementation (`_shared/content.tsx`, TutorRail, CommandPalette, 6 pages) — possibly in parallel with company creation

If anything in the self-review section (above) bothers you, surface it now and we adjust before we run live cycles.
