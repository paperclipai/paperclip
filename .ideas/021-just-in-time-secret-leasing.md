# 021 — Just-in-Time Secret Leasing

## Suggestion

Secret access today is a **standing grant**: `agent-secret-bindings.ts` binds a secret to an
agent, and the agent can resolve it on any run, indefinitely, until a human unbinds it. For
autonomous agents that run 24/7, that's a wide and permanent blast radius — every run of a
bound agent is a potential point of exposure for a credential it may only need occasionally.
The standard mitigation in human infra is **just-in-time, time-boxed access** — and Paperclip
already has the exact pattern elsewhere: `environmentLeases` lease environments with statuses,
TTLs, and cleanup. Secrets should work the same way.

Add **just-in-time secret leasing**: an agent acquires a secret for the duration of a specific
run (or a short TTL), the lease auto-expires and is cleaned up, and every acquisition is
individually audited — turning a permanent grant into a series of short, accountable check-outs.

## How it could be achieved

1. **Lease model for secrets.** Mirror `environmentLeases`: a `secret_leases` concept keyed by
   `{ agentId, secretId, runId, status, expiresAt }`. A binding becomes "this agent *may
   lease* this secret," not "this agent *holds* this secret."
2. **Acquire at point of need.** When a run resolves a secret, issue a lease with a TTL tied to
   the run lifetime; on run completion/failure (the same hook watchdogs use), release it. Reuse
   the lease-cleanup machinery already built for environments.
3. **Scoped exposure.** A secret value is only materialized into a run's environment while its
   lease is active, shrinking the window in which it exists in process memory/env.
4. **Per-acquisition audit.** Log each lease (who, which secret, which run, when, why) to
   `activity-log.ts`. This gives operators a real access trail — "this key was used by 3 runs
   this week" — instead of a static binding list, and feeds least-privilege review.
5. **Anomaly hooks.** Flag a secret leased far more often than usual, or by a run whose issue
   doesn't plausibly need it — a cheap signal of misuse or a confused agent.

## Perceived complexity

**Medium.** The leasing pattern, TTL, and cleanup all have a working in-repo precedent
(`environmentLeases`), so this is adapting a proven mechanism to secrets rather than inventing
one. The careful parts are the acquire/release lifecycle around run boundaries (a leaked lease
must expire by TTL even if a run crashes) and preserving adapter compatibility — agents that
expect a secret present for the whole session need the lease scoped to the session, not a single
tool call. Backward-compatible: existing bindings can map to "always-leasable" until operators
opt into tighter TTLs.
