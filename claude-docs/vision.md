# Vision — Hive as a 24-Hour Autonomous Company

> CTO vision for the platform: one operator, departments of agents, a company
> that never sleeps but never surprises you. Written 2026-06-12. Companion to
> `product-roadmap.md` (execution phases).

## Operating thesis

A company is three loops at different speeds:

| Loop | Cadence | Owner |
|---|---|---|
| **Build** (R&D) | days | CTO dept — plan → gate → PR → merge |
| **Reach** (Marketing & ads) | hours | CMO dept — content → review → publish → measure |
| **Keep alive** (Ops) | minutes | Routines — monitors, digests, budgets, retries |

Today the operator *is* all three loops. The vision: the operator owns only
the **decision moments**; everything between decisions runs itself. Paperclip
has the right skeleton (issues, org tree, heartbeats, budgets, attention);
the work is making each loop complete its circuit without the operator as
connective tissue.

## The six platform layers

### 1. Org layer — departments, not agents
A department = an `agentcompanies/v1` team package with its own gate profile,
budget envelope, skill set, cadence. R&D dept installed (`.agents/dev-team/`).
Marketing dept = port the eco-system TransVibe marketing team (CMO →
growth/brand/content/storytelling) the same way — its "no content ships
without CMO approval" gate is structurally identical to plan-approval.
**Code review and content review are the same primitive.** Deepest leverage
in the design: one gate machinery serves every department.

### 2. Work layer — every output is an issue with a gate trail
R&D output = PR. Marketing output = post/campaign/creative. Ops output =
report/action. All flow issue → plan → gates → artifact → done. One board,
one attention model, one audit trail. The attention verbs are
department-agnostic by construction.

### 3. Time layer — the 24-hour engine (biggest gap)
- **Routines** as first-class cron-shaped objects: nightly digest, weekly
  content calendar, daily ad-spend check, dependency scan, metric pulls.
- **Monitors**: "watch this external thing, wake on change" (campaign CTR
  drop, CI failure). `external_owner_action` attention reason anticipates this.
- **Escalation windows**: a 3am-blocked agent parks in the inbox, siblings
  retry, the morning digest opens with the decision queue. The company runs
  all night; **decisions batch to operator hours.**

### 4. Trust layer — autonomy earned per department, per action class
Every action class (merge PR, publish post, spend ad budget, hire agent) has
a trust dial: `propose → gated → auto-with-undo → auto`. R&D merge stays
`gated` long after the nightly digest hits `auto`. Ad spend likely never
leaves `gated` — money out is the irreversible class. Budgets + kill-switch
are the floor; trust dials are the ceiling.

### 5. Memory layer — the company learns or it just repeats
Calibration (est vs actual per agent), post-mortems written back into skills,
marketing performance written back into the brand book. Vendored skills are
the company's training material; the drift-check becomes a continuous-learning
pipeline: outcomes → skill edits → re-vendor → smarter next run.

### 6. Token-economics layer — burn is the company's COGS
At 24/7 scale, tokens are the dominant operating cost. Optimization is a
platform layer, not an afterthought. Where agent tokens die, by share:

| Burn source | Share (typical) | Fix |
|---|---|---|
| Raw tool output (test/build/lint dumps) | biggest | failures-only wrappers |
| Re-exploring the repo every run | big | prebuilt index, not grep sweeps |
| Instruction/skill bloat per heartbeat | medium | skill diet + lazy references |
| Wrong model for mechanical work | medium | model tiering per stage |
| Prose padding in inter-agent traffic | small, constant | caveman protocol |

See Track E in `product-roadmap.md` for the feature list.

## Exists vs missing

| Need | Status |
|---|---|
| Org tree, budgets, kill-switch, attention, gates (planned) | ✅ |
| Dev dept | ✅ installed, unpiloted |
| Marketing dept | 📦 in eco-system — port repeats the dev-team build |
| Worktree→PR pipeline | 🔜 Phase A |
| Routines/cron + monitors | ❌ the 24-hr engine |
| Trust dials per action class | ❌ generalization of hard-block |
| Publish connectors (social/ads/email) | ❌ marketing's PR-pipeline equivalent |
| Learning loop | ❌ calibration + drift-check grown up |
| Token-economics layer | ❌ Track E |

## Tracks beyond the current roadmap phases

- **Track M (Marketing):** port marketing team → reuse gate machinery →
  publish connectors. Content gates through CMO the way PRs gate through
  reviewers.
- **Track T (Time):** routines + monitors + escalation windows. What turns a
  good task runner into a company.
- **Track E (Tokens):** lean runners, caveman protocol, skill diet, model
  tiering, repo index, run hygiene, burn observability.

## The one-line bet

Don't build three systems for three departments — build **one
gate-trail-budget-attention spine** and make every department a package that
plugs into it. The spine is ~60% built already.
