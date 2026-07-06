---
title: Pre-Flight — Simulate Before Commit
type: concept
status: reviewed
sources: [004, 043, 052, 064, 015, 011, xcombo-10, xcombo-06, xcombo-01, research-sources]
updated: 2026-06-24
---

# Pre-Flight — Simulate Before Commit

One universal **`simulate(change) → ImpactReport`** seam that every high-consequence mutation passes
through before it commits — instead of each feature inventing its own preview.

## The unified seam (xcombo-10)

Generalize idea 004's `planOnly`/dry-run into one contract with call sites: launch a company (004), reorg
(052, see [[agent-quality-and-staffing]]), activate a policy (043, see [[security-governance]]), import
data (064), restore (015, see [[resilience-recovery]]), deploy config (011), move capital (see
[[economics-and-finance|Capital Allocator]]), cross-company action (see [[multi-company-and-ecosystem]]).

`ImpactReport` = creates/updates/deletes (Change-Impact-Analysis over the dependency graph) + risks +
projected cost + **counterfactual** ("would have blocked N past actions" — shares the engine with
[[security-governance|Provenance & Replay]]) + confidence.

## The graduation ladder

shadow → dry-run-with-approval → auto-commit, mapped to [[runtime-control-and-safety|the Autonomy Dial]].
Pre-flight is the **on-ramp to autonomy**, not just a gate — a capability earns auto-commit by proving its
simulations match reality.

## Grounding

Digital-twin pre-deployment validation + counterfactual frameworks (arXiv 2504.09461, 2604.01325,
2604.06610) supply the simulate-and-impact half; the agent **shadow→dry-run→commit** maturity ladder
supplies the deployment half. Critical caveat: "kill switches don't work if the agent writes the policy" →
the pre-flight seam and the definition of "consequential" must be **human-owned and agent-immutable**
(matters for [[software-building-and-self-hosting|self-hosting]]).

## Provenance

- Ideas `004,011,015,043,052,064`; combos `xcombo-10`, `xcombo-06`.
- `raw/research-sources.md` → `[digital-twin]`.

## Open questions for human review

- Faithful simulation is the crux — a wrong preview is worse than none. Per-call-site fidelity bar?
- Make the seam genuinely agent-immutable given self-modifying agents.
