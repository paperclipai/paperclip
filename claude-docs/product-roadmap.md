# Paperclip × Eco-System — Product Roadmap

> PM review of features built 2026-06-10 → 2026-06-12, the locked product
> direction, and the feature list to get there. Updated 2026-06-12 after the
> direction Q&A.

## Direction (locked 2026-06-12)

| Axis | Decision |
|---|---|
| End goal | **Personal dev factory** — Hive builds the operator's real projects; fork stays private |
| Work model | **Agents do the work** — Hive Dev Team writes real code via runs; operator runs the board; Claude Code builds Paperclip itself |
| Gates | **Harden to hard-block** — soft/advisory first, flip to enforced once agents prove they follow protocol |
| Runtime budget | **Real runs, real budget** — budgets wired, kill-switch is the guard |
| Workspace model | **Git worktree per issue** — isolated branch per issue run, parallel-safe |
| Code landing | **Branch + GitHub PR per issue** — Implementor pushes to the Moyal17 fork, opens PR; gates review; operator merges |
| First cargo | **Paperclip itself (dogfood)** — Hive agents build Paperclip features; self-hosting loop exposes every gap fastest |

**North star:** an issue assigned to the CTO comes back as a reviewed,
gate-approved GitHub PR on the fork, with cost and audit trail attached, and
the only human action was merge.

## Fit review — what we built vs how the operator works

| Feature | Fit verdict |
|---|---|
| Attention verb mapping + NextActionBanner | **Strong fit.** Born from the HIV-3 frustration. One verb, one button. |
| Reason-aware company reactivate | **Strong fit.** Fixes the real release workflow, respects budget raise flow. |
| Empty-plan guard + task assignee on manual plans | **Good fit.** Removes a dead-end error hit in real use. |
| Dev Team in Hive (`.agents/dev-team/`) | **Right direction, unproven.** No real task has run through it yet. |
| Gate-profile plan (soft, approved not built) | **Correct soft-first call.** Now explicitly Phase 1 of harden-to-hard-block. |
| Fork model, docs reorg, lookup skills | **Fit.** Infrastructure, done. |

**Gap pattern:** every friction moment had the same shape — *the system knew
something, the operator couldn't see it or couldn't act on it in one click*.

## Factory readiness — feature list (phased)

### Phase A — Rails (before any real autonomous run)

**A1. Gate-profile, soft (approved plan — GATE-1→3)**
- Objective: `gateProfile: 'none' | 'dev_team'` on plans; advisory Architect /
  Code-Review / Wiring checkpoints as `gate_*` approvals routed to the
  designated agents; NewPlanDialog toggle.
- Why: gates are the factory's quality system; everything downstream (audit,
  hard-block, PR review) hangs off these rows. Architect-approved, ~1.5–2 SP.

**A2. Issue workspace = worktree per issue**
- Objective: an issue run gets an isolated git worktree + branch
  (`issue/<identifier>-<slug>`) of the target repo; agent env lands in it;
  cleanup on terminal status. Build on Paperclip's issue-workspaces machinery.
- Why: parallel agents on one repo without collisions; per-issue diffs are the
  unit Code Reviewer and Wiring review. Prerequisite for any real code run.

**A3. GitHub PR pipeline per issue**
- Objective: Implementor pushes the issue branch to the Moyal17 fork and opens
  a PR (`gh` CLI in the claude_local env); PR URL linked on the issue; gates
  decided in Paperclip reference the PR diff. Operator merges on GitHub.
- Why: full audit on GitHub, fits the existing fork model (upstream push
  disabled), and merge stays a human act until trust is earned.
- Note: needs env/credential wiring for agents (fork push token, never
  upstream) — secrets via Paperclip env bindings, not baked into AGENTS.md.

**A4. Gate audit trail UI**
- Objective: issue timeline shows the gate ledger — who decided which gate,
  when, note; plan card shows ✓/✗ per gate.
- Why: "no DONE without audit trail" is the dev-roles core rule; without the
  ledger, soft gates are theater and hard-block can't be debugged.

**A5. Per-run cost attribution visible**
- Objective: each run shows tokens/cents on the issue + rolls up to plan
  budget caps (caps + kill-switch already exist); plan card shows burn vs cap.
- Why: "real budget" only works if burn is visible where decisions happen.

### Phase B — First cargo (dogfood loop)

**B1. Pilot run: one small Paperclip issue through the Dev Team**
- Objective: validation milestone, not a feature. Feed CTO one well-scoped
  Paperclip issue (candidate: Action Inbox UI or standup digest); watch
  decompose → plan-gate → worktree → PR → review-gates; log every deviation.
- Why: cheapest information available; reprioritizes everything after it.

**B2. Action Inbox — "Needs you" surface**
- Objective: one panel listing every attention item company-wide, sorted by
  verb + severity, NextActionBanner action inline; board cards get verb badges.
- Why: factory throughput is bounded by operator response latency; per-issue
  discovery stops scaling past ~10 live issues. Backend already done.

**B3. Standup digest**
- Objective: on-demand/cron brief — what moved, what's blocked + verb, budget
  burn, what needs the operator.
- Why: burst-mode operator; 10-line digest replaces 10 minutes of board
  walking. Also proves the attention model end-to-end.

### Phase C — Harden + scale

**C1. Hard-block gates**
- Objective: flip enforcement — agent-driven transitions blocked: no `done`
  without code+wiring approval, no activate without architect approval.
  Board/user override stays one click (operator is always senior to protocol).
- Why: the dev-roles guarantee, earned after Phase B proves agents follow the
  protocol; flipping earlier risks fighting the runtime before the loop works.

**C2. Estimate-vs-actual calibration**
- Objective: optional SP estimate on plan children (1 SP = 1 dev-day); stamp
  actual on done; plan view shows est vs actual per agent.
- Why: mirrors the eco-system `/done` calibration habit; reveals which agent's
  estimates to trust as autonomy scales.

**C3. Vendored-skill drift check**
- Objective: compare `.agents/dev-team/skills/*` against eco-system source;
  flag drift; offer re-vendor + re-import.
- Why: skills are edited at the source; stale vendored instructions are the
  nastiest failure class once agents run unattended.

**C4. Demo/seed mode (deferred)**
- Objective: one button seeding mock issues across every attention state.
- Why: accelerates UI iteration; only worth it after more UI features land.

### Track E — Token economics (cross-cutting; burn is the factory's COGS)

> Full rationale in `vision.md` layer 6. At 24/7 scale tokens dominate
> operating cost; optimize where they actually die.

**E1. Lean runners** — wrapper scripts agents MUST use instead of raw
commands: `vitest --reporter=json` → parser emitting only
`file:line · test name · error message` + pass/fail counts; same for
build/lint/typecheck. Biggest single win, ~0.5 SP.

**E2. Caveman inter-agent protocol** — comments/verdicts/plans between agents
in compact structured form (gate verdicts already JSON); filler banned in
AGENTS.md. The caveman skill formalized as company comms standard.

**E3. Skill diet** — slim every vendored SKILL.md to trigger + pointers; heavy
content in `references/` loaded on demand. Audit the 7 vendored skills.

**E4. Model tiering** — `runtimeConfig.modelProfiles.cheap` already exists in
the agent schema. Wire it: haiku for triage/formatting, sonnet for
implementation, opus only for plans + architecture reviews. Config-only.

**E5. Repo index over exploration** — nightly routine regenerates a lookup
index (lookup-skill-builder repurposed); agents consult the index before any
grep sweep. Kills the most-repeated waste.

**E6. Run hygiene** — per-issue token caps (budget scope `issue` exists),
tuned-down `maxTurnsPerRun`, fresh session per issue + compact handoff
summary instead of dragged context.

**E7. Measure first** — A5 cost attribution is the prerequisite; standup
digest gets a "top 5 token burners this week" line.

**Track E sequence: E7 + E1 immediately, E4 config-only quick win; rest ride
along Phases A/B.**

## Sequence

**A1 → A2 → A3 → A4+A5 → B1 → (B2/B3 fed back into the factory as cargo) → C1 → C2/C3.**
**Track E runs cross-cutting: E7+E1+E4 alongside Phase A; E2/E3/E5/E6 alongside Phase B.**

Tradeoff accepted: rails-first delays the satisfying first autonomous run by
~a week of build, but a pilot without worktrees + PR pipeline + audit would
prove nothing and risk the working repo.
