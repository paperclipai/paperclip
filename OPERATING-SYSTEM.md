# OPERATING-SYSTEM.md — ValAdrien Dev Operating System

The single map of how work flows from idea → shipped → observed → back to idea,
which tool fires at each stage, and how it runs identically whether **you** are at
the keyboard or an **agent** is running it in the cloud.

> This file is the **map** (human-facing). The **contract** for building any one
> product is that repo's committed `CLAUDE.md` (see `templates/CLAUDE.template.md`).
> This map is defined once here and mirrored into the valadrien-os repo so cloud
> agents read the same words. Keep the two copies identical.

---

## 0. First principle — git is the only shared substrate

Work happens across three surfaces whose filesystems **do not overlap**:

| Surface | Reads | Executes |
|---|---|---|
| **A. Local (Claude Desktop)** | `~/.claude` (memory, hooks, skills) + repo | Claude Code local → git push → Vercel |
| **B. Via ValAdrien OS** | agent instruction bundle on the Railway volume + repo | cloud agent (Railway) checks out repo |
| **C. On valadrien-os itself** | whichever of A/B applies | — |

`~/.claude` is local-only. The Railway volume is cloud-only. **The only thing all
three touch is the git repo.** Therefore:

> **Anything that must hold across surfaces lives as a committed file in the repo.**
> That file is `CLAUDE.md`. Memory and local hooks are conveniences layered on top
> for surface A — never the source of truth.

Cloud agent bundles carry one thin line: *"When working in a product repo, that
repo's `CLAUDE.md` / `AGENTS.md` are authoritative — read and obey them."* Substance
stays in git; the bundle is a pointer.

---

## 1. The golden path (the loop)

```text
  Linear issue ──▶ Traycer (PLAN, Claude) ──▶ phases
       ▲                                        │
       │                              Claude Code (EXECUTE, native)
     reopen                                     │
       │                            Traycer verify-vs-plan + /verify
       │                                        │
       │                              PR ──▶ NON-CLAUDE review
       │                                 (CodeRabbit + optional Codex)
       │                                        │
       │                                /ship + Vercel + Supabase
       │                                        │
  Sentry / Braintrust ◀── OBSERVE ◀── /qa + canary
       └──── errors + eval regressions auto-file back to Linear ────┘
```

### The model-diversity rule (non-negotiable)
- **Plan + Build = Claude-native.** All conventions live in `CLAUDE.md` + memory,
  which only Claude Code reads — so execution stays where context is load-bearing.
- **Review = non-Claude.** A reviewer only needs the diff, not your conventions —
  so put the different-model check exactly where it costs nothing to lose context.
- **Never let the same model build and clear its own work.** If Claude built it,
  a non-Claude reviewer (CodeRabbit) must pass it before merge.

> Korije (OS QA agent) is Claude Sonnet → it is **integration, not diversity**.
> CodeRabbit is the real diversity reviewer. Keep it live on every repo.

---

## 2. Stack by loop stage (with wiring status)

Legend: ✅ wired · ⚠️ partial / CLI-only · ❌ not connected

| Stage | Tool(s) | Role | Surface A (local) | Surface B (OS) |
|---|---|---|---|---|
| **Plan / Capture** | Linear, auto-memory, `/spec` | Issues, decisions, context | ✅ Linear MCP · ✅ memory | ⚠️ agents read bundle, not memory |
| **Plan → phases** | **Traycer** (planner: Claude) | Issue → phased plan | ⚠️ editor-side (VS Code) | ❌ editor-bound, not in fleet |
| **Build** | Claude Code, GitHub, Context7, gstack | Code + live library docs | ⚠️ `gh` CLI · ❌ Context7 MCP | agent worker + repo |
| **Verify-vs-plan** | Traycer, `/verify`, `/qa` | Diff matches plan | ✅ skills | ✅ skills |
| **Review** | **CodeRabbit** (gate), Korije (advisory), `/code-review` | Bug-catch pre-merge (diversity) | ✅ CodeRabbit = GitHub app (live) | ✅ CodeRabbit live · Korije auto-review retired (`.coderabbit.yaml`) |
| **Ship** | Vercel, Supabase, `/ship` `/land-and-deploy` | Deploy + migrations | ✅ Vercel MCP · ⚠️ Supabase CLI | worker deploy creds needed |
| **Observe** | Sentry, Braintrust, Vercel Analytics | Errors, LLM evals, perf | ❌ Sentry · ❌ Braintrust | ❌ |
| **AI substrate** | gbrain + VoyageAI (`voyage-code-3`) | Semantic search over code + memory | ✅ live (embedding backfill rate-limited) | n/a |
| **Orchestrate** | ValAdrien OS fleet | Run stages autonomously | ✅ Railway (Ti Claude/Sol/Bati/Veye/Korije) | ✅ |

### Known gaps (Phase-1 targets)
1. **Context7, Sentry, Braintrust** not connected in Claude Code → agents build
   blind to current library APIs, prod errors, and eval regressions.
2. ~~**CodeRabbit** must be confirmed installed~~ **DONE** — CodeRabbit is installed
   and active on `ValDola-stack/valadrien-os` (confirmed via live PR reviews). It is
   the required, blocking non-Claude review gate per `CONTRIBUTING.md`; Korije's
   internal auto-review is retired (`.coderabbit.yaml`).
3. **Two issue trackers** — Linear (human/planning) + ValAdrien OS issues (VAL-*).
   Source-of-truth split **locked**; the one-way `Sentry/Braintrust → Linear → OS`
   bridge is implemented (Vercel cron). See §4.

---

## 3. Automation mechanisms (each trigger → how it runs)

| Trigger | What fires | Mechanism |
|---|---|---|
| **Event** | PR opened → CodeRabbit review (blocking gate) | CodeRabbit GitHub app (live). Korije auto-review retired; webhook reviewer is spec-only (`docs/pr-reviewer-spec.md`) |
| **Event** | Sentry error → Linear issue + ping Veye | Sentry alert rule → webhook *(to build)* |
| **Event** | Session start → project picker | Claude Code hook (`project-picker.sh`, live) |
| **On-demand** | `/spec` `/ship` `/code-review` `/stack` | slash commands |
| **Scheduled** | eng-overseer audit, `/retro`, Braintrust eval run, dep-freshness | `/schedule` routines (cron) |
| **Agent heartbeat** | Veye SRE (15 min), Ti Claude (CEO) | ValAdrien OS |

---

## 4. Open decisions (resolve before full wiring)

- **Issue source of truth.** **LOCKED:** **Linear = human/planning layer**,
  **ValAdrien OS = agent-execution layer**, with a one-way bridge
  `Sentry/Braintrust → Linear → OS`. Implemented as a Vercel cron in
  `valadrien-os-server` (see `dotfiles/bridges/sentry-braintrust-to-linear-to-os.md`).
- **Codex as second (review-only) reviewer** — optional non-Claude reviewer #2
  alongside CodeRabbit (now confirmed live). Currently active on some PRs
  (`chatgpt-codex-connector`); keep as advisory, not a required gate.

---

## 5. Tooling roles (the "when do I use what" cheat-sheet)

- **Traycer** — you-at-the-keyboard planning + phase-driving + verify. Drives
  Claude Code. Editor-bound → surface A only; the fleet plans via `/spec` +
  `valadrien-os-converting-plans-to-tasks`.
- **Context7** — live, version-correct library docs during Build. (MCP, to add.)
- **CodeRabbit** — automatic non-Claude PR review. (GitHub app.)
- **Sentry** — production error capture → feeds Observe → Linear. (MCP, to add.)
- **Braintrust** — LLM eval/observability; regressions feed Observe → Linear. (MCP, to add.)
- **gbrain + VoyageAI** — semantic search over code + curated memory. Prefer over
  Grep for "where is X handled?" / past-decision questions.
- **Linear** — issues, projects, planning (human layer).
- **ValAdrien OS** — autonomous execution of the loop by the agent fleet.

---
_Last structured: 2026-07-01. Update this map whenever a stage's tool or wiring
status changes; mirror the change into the valadrien-os shared copy._
