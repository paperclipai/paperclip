# SON-3707 execution-reconciler hotfix — PROVENANCE

## What this is
Patched copy of `server/dist/services/execution-reconciler.js` exactly as deployed in the live
control-plane image (registry 192.168.1.148:5000/paperclip@sha256:2438b1f7b009fb3b0118ff86687ecd5cb9429a2cab256e29aa6a3d42d17e353b,
base layers from bake "son-1976 bake2" lineage + hotfix layer bb5452b7).

This module has NO upstream source: it does not exist on origin/master, fork/master, or the
son-1975-monitored-resting-state-recovery lineage branch (verified 2026-09-23). It reached the
deployed image via the heartbeat/reconciler hotfix layer, so the fix is carried as a vendored
patch here until the module is upstreamed.

## The bug (gate item 2 of the SON-3707 review verdict 2c7c040b, run 305035d0)
`buildVerificationPolicy(verifierAgentId)` stamped issue executionPolicy stages that fail the
strict input schema:
- stage `id` was the literal slug `"reconciler-verify"` (schema requires a GUID)
- participant was `{ id: <uuid>, agentId: <uuid> }` with NO `type` field (schema requires the
  discriminated `type: "agent" | "user"`)

Any issue that received this policy rejects ALL writes with 422 "Invalid execution policy"
(fieldErrors.stages: Invalid GUID / Invalid option: expected one of agent|user). Evidence:
SON-31, SON-3698, SON-3703, SON-3761, SON-3775, SON-3833, SON-3846, routine-minted firing cards.

## The fix
- stage `id`: `randomUUID()` (node:crypto) instead of the slug
- participant: `{ id: verifierAgentId, type: "agent", agentId: verifierAgentId }`

Exactly 2 line-level changes + 1 added import; verified `node --check` clean.

## Deployment
Included as an overlay layer in image tag `paperclip:son-3707-policy-fix` (2026-09-23), together
with the compiled hydrator/repair fix from commit 8bf067b386 (cherry-pick of 9cc08cb428,
suite 77/77) for `server/dist/services/issue-execution-policy.js`.

## Companion fix
Commit 8bf067b386 (this branch) adds `hydrateStoredIssueExecutionPolicy` /
`repairStoredIssueExecutionPolicy` so stored legacy corrupt policies are repaired instead of
422ing every write, and `executionPolicy: null` can clear them.
