# Workshop — Janis's agent operating system

**Repo:** `github.com/jkrums/workshop` (fork of `paperclipai/paperclip`, MIT)
**Local path:** `/Users/jkrums/workshop`
**Running instance:** `http://localhost:3100` (embedded Postgres + Vite UI)
**Owner:** Janis Krums (`janis.krums@gmail.com`)
**Started:** 2026-04-22

---

## What Workshop is

Workshop is the **control plane** for every business and project Janis runs. It coordinates agents, issues, routines, budgets, and approvals across multiple companies. Tenant #1 is **Lobbi** (the AI-powered financial OS for independent hotels). Future tenants: Lobbi Card, personal projects, whatever comes next.

**Analogy:** Workshop is to Janis what GitHub is to a developer — it manages the work, not the work itself. Lobbi's product code lives in `jkrums/lobbi`. Workshop doesn't contain product code; it contains the org chart, queues, and coordination logic for the agents *doing* the product work.

---

## Relationship to upstream (Paperclip)

- We pull improvements from `upstream` (Cathryn Lavery's `paperclipai/paperclip`) regularly.
- Internal identifiers stay stable on purpose — keeps merges clean. Package names (`@paperclipai/*`), env vars (`PAPERCLIP_API_KEY`), file paths (`~/.paperclip/`), DB tables all remain "paperclip".
- Only **user-visible strings** (UI branding, our docs, skills we write) are being rebranded to "Workshop". This is a conscious "shallow rebrand" — we get the ownership benefits of the fork without paying the merge-conflict tax.
- If we diverge enough (3+ months of custom work, personas, adapters), we'll revisit deep rebrand.

**Merge upstream:** `git fetch upstream && git merge upstream/master` (on master branch, not feature branches).

---

## What's already done (Hour 1 — 2026-04-22)

- Forked `paperclipai/paperclip` → `jkrums/workshop` via `gh repo fork` (clone in-place).
- `pnpm install` completed (1066 packages, embedded Postgres for darwin-arm64).
- `pnpm dev` boots the server cleanly at `http://localhost:3100`.
- **Lobbi company** created in the UI (UUID: `5f8e4374-e127-4173-95cc-1125a73b5e6d`).
- **Hermes agent** created (UUID: `5a115338-72dd-4b7b-b1bf-b996937d1325`) — Chief of Staff, Claude Code adapter.
- **Smoke test issue LOB-1** passed — full loop working: create → assign → adapter checkout → agent work → authenticated close.
- Env file at `~/.paperclip/instances/default/.env` holds `PAPERCLIP_AGENT_JWT_SECRET` and `BETTER_AUTH_SECRET` (same 128-char hex secret for both — that's intentional, the code accepts either).
- Paperclip API key issued to Hermes, saved to 1Password as "Paperclip Workshop — Hermes API Key".
- MCP server built locally (`packages/mcp-server/dist/stdio.js`) and wired to Claude Code at **user scope** via `claude mcp add -s user paperclip ...`. Every Claude Code session on this machine has access to `paperclipMe`, `paperclipListIssues`, `paperclipCheckoutIssue`, etc.

See `brain/ops/hour-1-log.md` for the timestamped sequence and every decision made.

---

## Architecture

### The two skill directories

Paperclip ships two skill systems — don't confuse them:

1. **`.claude/skills/`** — skills for Claude Code sessions working **on** the Workshop codebase. Add skills here when we want Claude Code (in a Conductor workspace on this repo) to behave a certain way when editing Workshop's code. Example seeds from upstream: `company-creator`, `design-guide`, `paperclip`.

2. **`skills/`** (top level) — skills that Workshop distributes to the **agents it manages inside companies**. These are what Hermes/Atlas/Iris/etc. read when they pick up a task. Example seeds from upstream: `paperclip-create-agent`, `paperclip-create-plugin`, `para-memory-files`.

Our persona roster (Hermes, Atlas, Minerva, Booker, Porter, Scout, Forge, Vault, Rory, Iris, Hunter, Ledger) gets seeded into `skills/` because they operate inside companies.

### Key code locations

| Path | What it is |
|------|------------|
| `server/src/` | Express 5 API + heartbeat service + adapter registry |
| `server/src/routes/` | REST endpoints (`issues.ts`, `agents.ts`, `access.ts`, `heartbeat.ts`, `adapters.ts`) |
| `packages/db/src/schema/` | Drizzle schemas — `issues.ts`, `agents.ts`, `routines.ts`, `heartbeat_runs.ts` are the primitives |
| `packages/mcp-server/` | The MCP wrapper Claude Code talks to |
| `ui/src/pages/` | React 19 pages — `Agents.tsx`, `Issues.tsx`, `Routines.tsx`, `OrgChart.tsx`, `Approvals.tsx` |
| `ui/src/components/OnboardingWizard.tsx` | First-run wizard (company + agent + task) |
| `cli/` | `paperclipai` CLI (onboarding, worktree management) |
| `scripts/dev-runner.ts` | Supervisor for `pnpm dev` |

### Core primitives

- **Company** — tenant. Holds agents + issues + goals + projects + routines.
- **Agent** — worker. Has an adapter (Claude Code, OpenClaw, etc.), a budget, a reportsTo chain, a heartbeat schedule.
- **Issue** — unit of work. Human-readable ID (e.g., `LOB-1`). Gets checked out atomically via `checkoutRunId` so no two agents race it.
- **Run** — one attempt by an agent to complete an issue. Has `heartbeat_runs` (receipts of progress) and a final status.
- **Routine** — recurring work. Has `routine_runs` on a schedule. Where our daily briefing / weekly review / monthly audit will live as first-class Paperclip objects, not external crons.
- **Approval** — human-in-the-loop gate. Agents can request confirmation via `paperclipRequestConfirmation` MCP tool.

---

## Collaboration model

### Conductor workspaces

- **This repo (`jkrums/workshop`)** is where we edit Workshop code. Open a Conductor workspace on it when doing Workshop dev (rebrand, adapters, UI).
- **`jkrums/lobbi`** and other product repos stay their own Conductor workspaces. Those are unchanged.
- Never copy product code into Workshop. Companies are logical tenants inside the running Paperclip instance, not code-level nesting.

### Running server ≠ working tree

The running Paperclip at `localhost:3100` is independent of whichever branch you're editing. You can switch branches in `/Users/jkrums/workshop` freely — the server needs a restart (`pnpm dev:stop && pnpm dev`) to pick up code changes, but the DB at `~/.paperclip/instances/default/db` persists across restarts.

### Branch convention

- `master` — tracks upstream `paperclipai/paperclip` plus merged Workshop changes.
- `feat/*` — feature branches for Workshop edits (rebranding, personas, adapter removals).
- `sync/upstream-YYYY-MM-DD` — branches for merging upstream releases.

Standard workflow: feature branch → PR → merge to master → running server restarts if code changed.

---

## Communication style (how to write for Janis)

**Janis is a non-technical founder.** For infrastructure or code builds he watches in real time, explain every step in four beats:
1. **WHAT** — one sentence
2. **WHY** — the purpose, business terms where possible
3. **HOW** — mechanism in plain English, analogies OK
4. **WHAT YOU'LL SEE** — on-screen output, file changes, logs

Exceptions: when he says "just do it" or "don't explain, ship," override back to terse style. Also for routine coding he isn't watching (bug fix, test addition), the normal terse style applies. This rule is for work he's watching or approving live, especially when introducing new tools/concepts.

See `brain/concepts/communication-style.md` for the full framework.

---

## Security

- **Never commit** anything under `~/.paperclip/` — that's local runtime state, includes the JWT secret.
- **Never commit** the Hermes API key or any MCP tokens. They live in 1Password + `~/.claude.json` (chmod 600, user-only).
- **`.env` files** stay gitignored. The `.gitignore` already excludes `.claude/settings.local.json` and `.claude/worktrees/`.
- Agents writing code go through Paperclip's approval flow for anything touching auth, payments, production DB, or external-party comms (Gmail, Slack).
- The Green/Yellow/Red authority framework (see `brain/concepts/operating-principles.md`) governs what agents do without asking vs. what requires human approval.

---

## The roadmap

- **Hour 2** (next session in a Workshop Conductor workspace)
  - Shallow rebrand of user-visible strings ("Paperclip" -> "Workshop" in UI, banner, our docs)
  - Strip unused upstream adapters (`openclaw-gateway`, `gemini`, `opencode`, `pi`, `cursor`) — keep `claude_local`
  - Seed persona skills in `skills/` for Hermes, Atlas, Iris, Rory
  - Write `operating-principles` skill (Green/Yellow/Red)
  - First routine: daily briefing fires through Paperclip instead of external cron

- **Hour 3+**
  - Deploy to Fly.io (control plane) + Fly Machines (ephemeral workers)
  - Twilio SMS notifications (reuse existing Stella number `+1 650-866-1985`)
  - Second company: scaffolding for Lobbi Card or personal projects
  - CrabTrap security gateway for write-action agents (Brex open-source LLM-as-judge)

- **Eventually**
  - Always-on operating system — night-shift orchestrator -> workers -> approval queue -> morning review
  - Full 12-persona roster operating across tenants

---

## When you're a future Claude Code session reading this

1. Read `brain/README.md` for the knowledge-base index.
2. Read `brain/ops/hour-1-log.md` if you need the history of how Workshop got set up.
3. Read `brain/concepts/persona-roster.md` before creating or editing any agent.
4. Read `brain/concepts/operating-principles.md` before approving or auto-executing any non-trivial action.
5. If you're about to suggest changing env var names or package names, stop — that is the deep rebrand we are deferring. Check with Janis first.
6. If an issue comes in from Paperclip MCP tools, treat it as a real work assignment — check it out (`paperclipCheckoutIssue`), do the work, add comments for progress, close it when done.
