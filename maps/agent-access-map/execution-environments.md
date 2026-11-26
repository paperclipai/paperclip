# Local, SSH, and sandbox environments — agent access

Product map: [Local, SSH, and sandbox
environments](../feature-map/execution-environments.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Scoped immutable-platform source review: 2026-10-12 at
`d16eccf109b524778ceb896f79ccb3881bc61a9b`, limited to saved sandbox probing,
server-owned qualification metadata and read/invalidation behavior. The original
baseline commit and review depth remain for unrelated operations; no live agent
or provider qualification is claimed by this update.

## `configuration`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/environments`.
- `POST /api/companies/{companyId}/environments`.

Agent access: `restricted` — Board read/admin management REST / CLI environment.

Policy: Environment management is instance administrator/board; permitted assignment
uses agent/project policy.

Evidence: `source-only` — [implementation](../../server/src/routes/environments.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: API exists; an agent cannot use instance environment management as an ordinary
company actor.

Scoped source review: [environment routes](../../server/src/routes/environments.ts)
require board organization access for reads and local-implicit board or instance
administrator for management. Create/PATCH reject client-supplied platform-proof
metadata; [service updates](../../server/src/services/environments.ts) discard
supplied proof, preserve current server proof atomically for metadata-only edits,
and invalidate it when the target configuration or driver changes. Public row
responses hide the private record. This is source-only at the scoped commit.
Verify forged metadata rejection, concurrent probe/update preservation, target
invalidation and restricted-reader redaction; actual agent-denial proof remains
not run. Company/team packages do not import or export environment rows, so those
packages do not transfer platform qualification.

## `capabilities`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/environments/capabilities`.

Agent access: `partial` — Board environment capabilities endpoint; native run gets
server-selected runtime context.

Policy: Environment management is instance administrator/board; permitted assignment
uses agent/project policy.

Evidence: `source-only` — [implementation](../../server/src/routes/environments.ts#L353)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Endpoint discovery and already-bound run capabilities differ; decide whether a
safe agent-readable capability listing is desired.

## `probe`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/environments/{id}/probe`.
- `POST /api/companies/{companyId}/environments/probe-config`.

Agent access: `restricted` — Board/admin probes / CLI environment.

Policy: Environment management is instance administrator/board; permitted assignment
uses agent/project policy.

Both probe endpoints require a board actor that is local-implicit or an instance
administrator; ordinary agent identity and company membership alone are denied.
The saved sandbox probe also resolves company/environment and secret access
before allocating a fresh lease. Its measurement is company-bound to an immutable
image digest or verified Daytona snapshot ID, effective provider configuration
and active custom-image identity;
only confirmed cleanup permits recording it. A draft probe does not record saved
qualification. Reading stored qualification does not lease/provision a target and
does not grant an agent permission to probe or manage that target.

Evidence: `source-only` — [implementation](../../server/src/routes/environments.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Reachability probes are not granted by an agent's right to execute assigned work.

Scoped Evidence: `source-only` — [probe authorization](../../server/src/routes/environments.ts),
[immutable binding, measurement and read](../../server/src/services/environment-probe.ts),
[private metadata writes](../../server/src/services/environments.ts) and
[custom-image binding](../../server/src/services/environment-custom-image-runtime.ts)
at the scoped commit. A connection-only success or a fixture cannot certify
native compatibility, account authentication or agent access.

Scoped Verification: `not-run` — on one authorized owned target, compare pinned
image and provider snapshot-ID proof with mutable-image, unverified-snapshot
and changed-config/account controls; require independent
cleanup evidence before recording proof. Assert agent/non-admin board denial,
secret-context denial where the actor lacks access and forged-proof rejection.
Verify API reads hide the private record and metadata-only updates cannot overwrite it. Then use
[runtime validation](./runs-adapters.md#validation) for account/model/native startup.

There is no new delegated agent probe binding or client proof-write API. Any
human-action request/result handoff requires its own admitted path and verification;
an accepted interaction does not turn the caller into a board administrator.

## `assignment`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/agents/{id}`.
- `PATCH /api/projects/{id}`.

Agent access: `partial` — Permitted agent/project REST / native fallback, subject to
protected configuration policy.

Policy: Environment management is instance administrator/board; permitted assignment
uses agent/project policy.

Evidence: `source-only` — [implementation](../../server/src/routes/environments.ts#L353)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Choosing among permitted targets differs from creating/configuring host targets;
test authorized and denied selection.

## `images`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/environments/{environmentId}/custom-image-setup-sessions`.

Agent access: `restricted` — Board/admin image APIs and existing terminal protocol.

Policy: Environment management is instance administrator/board; permitted assignment
uses agent/project policy.

Evidence: `source-only` — [implementation](../../server/src/routes/environments.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: No default agent custom-image administration/terminal path; this is a policy
decision before adding a tool.
