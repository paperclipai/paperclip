# Combo 07 — Self-Staffing & Self-Organizing Workforce

**Combines:** 048 Competency-Gated Job Postings (Test-to-Hire) · 047 Role-Based Skill
Auto-Provisioning · 025 Capability-Based Auto-Assignment · 009 Agent Probation & Trust Ramp ·
052 Org Restructuring Simulator · (consumes 044 reliability, 063 capacity forecast)

## The unified idea

Paperclip hires blind (any agent gets full autonomy instantly, with no proof it can do the job),
equips manually (you forgot to add the skill), assigns manually (work lands on the wrong or
overloaded agent), and reorganizes blind (move an agent, hope nothing breaks). Five ideas, taken
together, make the org **staff, equip, assign, ramp, and restructure itself** — a closed
desired-state loop where the role is authoritative and agents converge to it.

- **Test-to-hire, not hire-and-hope (048).** A first-class job posting = `{ role, requiredSkills,
  acceptanceTest, budget, reportsTo, status }` that *stays open until a candidate proves it can do
  the work*. The acceptance test is an eval suite (combo 06 / idea 011) run in the shared `planOnly`
  shadow mode — the eval *is* the interview.
- **Equip by role, automatically (047).** Role → skill bundle as source of truth (seeded from
  `recommendedForRoles` + teams-catalog `requiredSkills`). On hire/role-change, auto-install + bind
  required skills idempotently (`installedHash`); a reconciler keeps every agent in a role in sync as
  the bundle evolves. A near-fit candidate gets equipped with missing skills, then re-tested (closes
  with 048).
- **Assign by fit × reality (025).** Score eligible agents (capability text + issue content) weighted
  by current load (heatmap, combo 03), trust stage, and cost-effectiveness (combo 04) — suggest first,
  then auto-assign the unowned long tail so nothing rots. Learn from completion/approval/rework rates.
- **Earn autonomy over time (009).** New hires start at `probation` (low concurrency, mandatory
  review, tight spend) and *graduate* on a clean track record, or get demoted on rejected reviews /
  budget trips. The test (048) proves baseline competence; the ramp proves sustained performance.
- **Reorganize with eyes open (052).** Edit a *draft* org, preview the full impact (reassignments,
  rerouted approvals, changed escalation chains, orphaned work), warn on risky outcomes, then apply
  atomically + audited with one-click revert.

The loop self-heals: an agent that fails reliability SLOs (044) or a reorg that leaves a role
unstaffed (052) **auto-reopens a job posting** (048); capacity forecasting (063) tells you *which*
postings to open to hit the goal on time.

## Why combining wins

This is one staffing lifecycle, not five features: a posting (048) needs the skill model (047), the
test harness (combo 06), and probationary onboarding (009); auto-assignment (025) and reorg (052)
both read the org/assignability model and feed back into postings. The cross-references in the source
ideas are explicit and circular — building them apart would create four overlapping half-models of
"what a role requires and who fills it." Build one role/competency model and the workforce becomes
self-organizing.

## Phasing

1. Probation/trust ramp (009) — pure policy over existing trust machinery; immediate safety value.
2. Role→skill bundles + provision-on-hire + reconciler (047); capability-based *suggestions* (025).
3. Job-posting object + manual "test this candidate against this posting" (048).
4. Auto-assignment for the unowned tail, org restructuring simulator (052), auto-backfill loop.

## Ratings

- **Difficulty:** High — introduces a new domain object (job posting) and a hiring state machine, plus
  the reorg impact-diff must enumerate *all* consequence types accurately or the preview isn't
  trusted; depends on the shared shadow/eval contract.
- **Estimated time to complete:** ~6–9 engineer-weeks.
- **Importance:** 7/10 — the payoff (an org that staffs and organizes itself) is large but advanced;
  it matters most for bigger, longer-running companies and layers on the core safety/economics work.
