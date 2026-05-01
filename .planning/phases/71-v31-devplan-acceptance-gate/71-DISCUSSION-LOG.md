# Phase 71: v3.1 DevPlan Acceptance Gate - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01T16:05:00+09:00
**Phase:** 71-v31-devplan-acceptance-gate
**Areas discussed:** Gate topology, Focused check coverage, Score delta semantics, Planning artifact closure, Dirty evidence guard

---

## Gate Topology

| Option | Description | Selected |
|--------|-------------|----------|
| Extend only `rt2-devplan-alignment-gate` | Put command execution, score delta, debt reporting, and acceptance evidence into the existing matrix gate. | |
| Add v3.1 acceptance wrapper | Keep alignment matrix as canonical score source and add a wrapper that runs/checks focused commands plus writes final acceptance evidence. | yes |
| Report-only docs closure | Only update planning docs and rely on existing alignment report. | |

**User's choice:** `[auto]` selected v3.1 acceptance wrapper.
**Notes:** This keeps the score matrix simple and avoids turning the alignment gate into a command runner.

---

## Focused Check Coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Focused plus standard verification | Cover DevPlan, identity, daily, runtime, wiki, graph, economy, `pnpm typecheck`, and `pnpm test`; keep e2e separate. | yes |
| Full e2e acceptance | Add `pnpm test:e2e` to the default gate. | |
| Alignment-only acceptance | Trust the matrix rows without running representative focused checks. | |

**User's choice:** `[auto]` selected focused plus standard verification.
**Notes:** Matches AGENTS.md and prior phase policy: `pnpm test:e2e` is separate.

---

## Score Delta Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit score delta and blocker buckets | Report baseline/current/delta and separate blockers, accepted debt, and future scope. | yes |
| Score only | Report only current score. | |
| Narrative audit only | Use prose without machine-readable summary fields. | |

**User's choice:** `[auto]` selected explicit score delta and blocker buckets.
**Notes:** This directly satisfies `GATE-02` and prevents overstated completion claims.

---

## Planning Artifact Closure

| Option | Description | Selected |
|--------|-------------|----------|
| Close docs after gate passes | Update requirements, roadmap, state, project, and milestone docs only after generated acceptance evidence exists. | yes |
| Close docs before verification | Mark requirements complete first, then run checks. | |
| Leave docs unchanged | Keep evidence isolated to generated run output. | |

**User's choice:** `[auto]` selected close docs after gate passes.
**Notes:** Planning docs should reflect evidence, not substitute for it.

---

## Dirty Evidence Guard

| Option | Description | Selected |
|--------|-------------|----------|
| Report dirty/missing evidence anchors | Surface missing/dirty required evidence paths and block final acceptance unless intentionally classified as unresolved handoff debt. | yes |
| Ignore git/worktree state | Treat all existing files as accepted evidence regardless of dirty/untracked state. | |
| Require fully clean tree for every run | Block on any dirty file, even unrelated local logs/debug scripts. | |

**User's choice:** `[auto]` selected report dirty/missing evidence anchors.
**Notes:** Current worktree includes Phase 69 graph/corpus dirty/untracked paths, so Phase 71 must not silently close v3.1 without acknowledging that state.

---

## the agent's Discretion

- Exact script names and report wording.
- Exact focused command list, as long as every v3.1 requirement family is represented.
- Exact accepted debt/future scope formatting.

## Deferred Ideas

- Public/open marketplace launch.
- Real billing, payroll export, and external payment settlement.
- Autonomous Jarvis direct apply.
- Cross-company federation full apply.
- Native credential/public store operational evidence.
