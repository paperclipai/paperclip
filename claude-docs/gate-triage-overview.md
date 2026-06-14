# Gate Triage — right-size the dev-team gates (shipped) Overview

> Written 2026-06-14. Covers fix-backlog **#6** (fixed-max gate set) and **#3**
> (done-gate dead-end), shipped together. Background, solution, and the
> end-to-end flow. Source plan: `triage-gate-plan.md`. Commit: `444297cf`.

---

## Background — why this work exists

The dev-team factory ran the **full 5-role gate** for *every* task:

```
plan-approval (architect)
  + code-review (code-reviewer)  ── per leaf
  + wiring-review (wiring-expert) ── per leaf
```

Two failures surfaced in the B1 pilot:

1. **Fixed-max cost (#6).** HIV-12 — "add one line to `CHANGELOG.md`" — paid the
   entire multi-agent gate cost (architect plan approval + two reviewers) for a
   trivial docs change. The gate set is fixed at maximum by construction; there
   was no knob to ask for less.
2. **Done-gate dead-end (#3).** HIV-13 could never close. The `done` gate
   required an **open PR** + both review gates approved. A shared-branch task
   never produced a PR (PRs come from the worktree git-ops route), so an **agent
   actor could never satisfy the gate** — every close needed an operator
   override.

Root cause for both: `PlanGateProfile` was a hardcoded binary
(`"none" | "dev_team"`), and `buildGateApprovalsForActivation` always emitted the
full set. No tier, no right-sizing.

---

## Solution — three layers

### Layer 0 — server-side hard-rule floor (`gate-triage.ts`, pure)

The safety floor must not depend on model obedience. A pure function classifies
the **minimum** review strength a plan's declared scope is allowed:

```
forceFullIf(scope):
  any touched path matches auth|authz|login|session|token|secret|credential  → full
  any path matches migration|schema|.sql                                      → full
  any path matches payment|billing|invoice|charge|stripe                      → full
  any path under routes/ or openapi (public API surface)                      → full
  fileCount > 5                                                               → full
  else → no floor

resolveEffectiveGateProfile(requested, scope):
  forceFullIf(scope) ? "dev_team" : (requested ?? "none")
```

The CTO's request is an **input**; the floor is the **ceiling on downgrade**. The
platform can raise review strength (`solo` → `dev_team` when auth is touched) but
never lower it below the floor. Applied at plan-create.

### Layer 1 — tier as a first-class profile

`PlanGateProfile = "none" | "solo" | "light" | "dev_team"`. `gateProfile` is a
`text` column, so the new values need **no migration**. `dev_team` stays exactly
`full` for back-compat.

### Layer 2 — profile → gate set + done-readiness

| Profile | Gates emitted | Done-gate requires |
|---|---|---|
| **none** | none | nothing |
| **solo** | none | nothing — **no PR, no gates** (the #3 fix) |
| **light** | 1 code-review gate / leaf | that gate approved — **no PR** |
| **dev_team** | plan-approval + code-review + wiring / leaf | open PR + both gates (original) |

`buildGateApprovalsForActivation(profile)` emits the sized set;
`evaluateDevTeamDoneReadiness(profile)` branches the close requirements. `light`
uses **code-review only** (highest-value single gate: correctness + security) —
diff-based reviewer selection is deferred because per-leaf diffs aren't available
at activation.

---

## Flow — create → activate → done

```
plan create (requested profile, touchedPaths)
  → resolveEffectiveGateProfile(requested, scope)
       ── high-risk path / >5 files ──► force "dev_team"
       ── else ───────────────────────► requested
  → persist gateProfile ▼

plan activate
  → gateProfile != "none"?
       ── yes ──► createActivationGates(profile)
                    → buildGateApprovalsForActivation(profile):
                         solo     → []                      (no agents gated)
                         light    → [code-review × leaf]    (implementor + 1 reviewer)
                         dev_team → [plan + code + wiring]   (architect + 2 reviewers)
                  + arm runaway budget policy (any gated profile burns tokens) ▼

issue → done transition
  → evaluateDevTeamDoneGate (caller allows light + dev_team through)
       → evaluateDevTeamDoneReadiness(profile):
            none / solo → ready (never gated)        ◄── HIV-13 dead-end gone
            light       → ready iff its gate approved (no PR)
            dev_team    → ready iff PR open + both gates approved
       → agent actor: blocked with truthful reasons · user actor: override logged
```

**The single property:** *the amount of review a task pays for now matches the
risk of the task* — trivial/solo work ships through the implementor alone and
closes without a PR it can't produce; risky work (auth, payments, migrations) is
forced to full review by a server-side rule the model cannot talk its way past.

---

## What this does NOT fix (companion work)

Triage cuts *how many* agents gate a task. It does not make those agents
*competent* — a gate routed to an Architect with an empty instruction bundle is
still a rubber-stamp. That is **#4 factory instructions** (provision the gate
agents' instructions at activation). And triage doesn't touch *per-wake cost*
(that's the wake-cost leg: W1/W2/W3, shipped) or the *hard ceiling* (burn-guard,
shipped; G3 per-run kill still open as #7).

---

## Verification

- `server/src/__tests__/gate-triage.test.ts` — floor patterns, precedence
  (`solo + auth → dev_team`, `light + clean → light`, no-paths → requested),
  profile-sized gate counts (0 / 1 / 5).
- `server/src/__tests__/dev-team-done-gate.test.ts` (extended) — solo never
  gated, light requires gate but not PR.
- `plan-gate-activation.test.ts` (existing, green) — proves `dev_team` is
  unchanged.

No DB migration; `gateProfile` is a text column.
