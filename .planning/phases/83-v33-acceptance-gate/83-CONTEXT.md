# Phase 83: v3.3 Acceptance Gate - Context

**Gathered:** 2026-05-04T11:22:23+09:00
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 83 closes the v3.3 (RT2 Engine Convergence) milestone by verifying that the core engine convergence (Multica runtime, RT2 event projector, Work lifecycle, wikiLLM/Graphify projection, and Paperclip residue cleanup) meets the acceptance criteria.

This phase is an acceptance/audit gate, not a new product feature phase. It must consume the evidence from Phases 78-82. It will add a new deterministic gate script (`scripts/rt2-v33-acceptance-gate.mjs`) to run focused checks and validate the DevPlan alignment score. It must not introduce new features.
</domain>

<decisions>
## Implementation Decisions

### Gate Topology
- **D-01:** Create `scripts/rt2-v33-acceptance-gate.mjs` as the v3.3 acceptance wrapper.
- **D-02:** The acceptance wrapper runs `rt2-devplan-alignment-gate.mjs` and writes `summary.json` plus `report.md` to `.planning/v33-acceptance-runs/`.
- **D-03:** The Phase 83 owner handles `GATE-01` and `GATE-02` slices. The alignment gate row for `v33-acceptance-gate` should become `complete`.

### Focused Check Coverage
- **D-04:** The gate must cover standard verification (`pnpm typecheck`, `pnpm test`) plus specific tests relevant to the v3.3 phases (e.g. any residue cleanup or alignment checks).
- **D-05:** A failed focused check is a blocker, not accepted debt.

### Score Delta And Truth Semantics
- **D-06:** The generated summary must include `baselineScorePct`, `currentScorePct`, and `scoreDeltaPct`. A non-positive delta is a blocker, ensuring that v3.3 has improved upon v3.2.
</decisions>
