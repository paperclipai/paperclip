# Gate-Agent Instructions — #4 (shipped) Overview

> Written 2026-06-14. Covers fix-backlog **#4 — factory/gate agents have no
> instructions**. Background, root cause, the fix (option a), flow, and the
> deferred follow-ups. Commit: `cba094b4`. Knowledge map it builds on:
> `agent-instructions-architecture.md`.

---

## Background — why gates were rubber-stamps

dev_team gate agents — Architect (plan-approval), Code Reviewer, Wiring Expert —
are created like any other agent: `POST /companies/:id/agents` (or `/agent-hires`)
→ the platform materializes a **managed instruction bundle** by copying a seed out
of the checked-in template library `server/src/onboarding-assets/{role}/` into the
agent's live per-agent dir. The adapter feeds that bundle's `AGENTS.md` to the model
first, every run — it is the agent's identity.

The template library only had rich content for **`ceo`**; every other role fell to a
single generic `default/AGENTS.md`. So the gate agents booted **competent but
amnesiac**: they had their skills, but no identity doc telling them "you are the
Architect, here is the gate protocol." Gates that don't know they're gates approve
everything → rubber-stamp.

## Root cause — the seed keyed on the wrong field

The seed selector was `resolveDefaultAgentInstructionsBundleRole(agent.role)`, which
knew only `ceo` vs `default`. But gate identity is **not** in `agent.role`:

| Agent | name-derived urlKey | `role` column |
|---|---|---|
| Architect | `architect` | `engineer` |
| Code Reviewer | `code-reviewer` | `qa` |
| Wiring Expert | `wiring-expert` | `engineer` |

Architect and Wiring Expert share `role: "engineer"`, so a role-keyed selector
*cannot* seed them differently. Identity lives in the **urlKey** (`normalizeAgentUrlKey(name)`),
which is also what the gate router (`plan-gates.ts:20-24 GATE_DESIGNATED_URL_KEY`)
already uses to route gates to agents.

## Fix — option (a): make the seed selector identity-aware

Platform-side fix so **any** creator (operator installer, future factory, manual POST)
seeds gate agents correctly — not just one installer.

- Added three checked-in seed bundles:
  `onboarding-assets/{architect,code-reviewer,wiring-expert}/AGENTS.md` — generic
  identity + that role's gate responsibility + the real `agent-decide` mechanic
  (`POST /api/approvals/<id>/agent-decide`). Fork-specific lines (lean-runners,
  COGS framing, hard-coded skill lists) stripped.
- `default-agent-instructions.ts`: added the three bundles to `DEFAULT_AGENT_BUNDLE_FILES`
  and changed the resolver to take an optional `urlKey` and resolve **urlKey → role →
  default**. An `IDENTITY_ROUTABLE_BUNDLE_ROLES` set restricts urlKey-routing to exactly
  the three gate keys, so an agent merely named "Default"/"CEO" can't hijack a bundle.
- `routes/agents.ts`: the one materialize closure now passes
  `normalizeAgentUrlKey(agent.name)` into the resolver. Both create entrypoints
  (`/agents`, `/agent-hires`) flow through this closure, so both are covered with no
  call-site churn.

This also belts-and-braces with the W1 readiness gate: a non-empty seed means
`isManagedBundleEmpty()` is false, so a freshly-seeded gate agent is never paused.

## Flow

```
POST /companies/:id/agents  (or /agent-hires)
  → svc.create
  → materializeDefaultInstructionsBundleForNewAgent(agent)         routes/agents.ts:1169
       (no explicit bundle on adapterConfig)
       → resolveDefaultAgentInstructionsBundleRole(
             agent.role, normalizeAgentUrlKey(agent.name))          default-agent-instructions.ts:44
             urlKey ∈ {architect,code-reviewer,wiring-expert} ?  → that bundle
             else role === "ceo"                                  → ceo
             else                                                 → default
       → loadDefaultAgentInstructionsBundle(seedRole)              reads onboarding-assets/{seedRole}/AGENTS.md
       → materializeManagedBundle → writes live per-agent dir, mode="managed"
  → next wake: isManagedBundleEmpty() = false → W1 never pauses
             → adapter feeds the role AGENTS.md to the model = real identity
```

## Verification

- `default-agent-instructions.test.ts` (7, pure): resolver routes each gate urlKey
  despite engineer/qa role; derives the key from the name the create path uses; keeps
  ceo role-only (no urlKey hijack); falls back to default for ordinary/missing/`default`/`ceo`
  urlKeys; each gate bundle loads a non-empty `AGENTS.md` (W1-safe by construction).
- Regression: 28 adjacent suites green (agent-instructions service + routes, wake-readiness/W1).
- `tsc --noEmit` clean. Build already ships the new dirs (`cp -R src/onboarding-assets/.`).
- No DB migration.

## Deferred (out of scope, follow-ups)

- **Backfill / re-materialize** agents already created with the generic seed — the seed
  copy runs only at create. Existing dev-team gate agents need their live `AGENTS.md`
  refreshed (re-materialize endpoint or one-shot) to pick up the new identity. **This is
  the immediate next step to make the *current* company's gates real.**
- **Auto-provision gate agents** at company setup (no factory creates them today).
- **Skill auto-assignment** (`paperclipSkillSync.desiredSkills` only populates on request).
