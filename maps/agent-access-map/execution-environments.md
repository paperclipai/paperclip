# Local, SSH, and sandbox environments — agent access

Product map: [Local, SSH, and sandbox
environments](../feature-map/execution-environments.md).

Feature ID: `execution-environments`.

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

Capability ID: `execution-environments/configuration`.

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

Capability ID: `execution-environments/capabilities`.

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

Capability ID: `execution-environments/probe`.

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

Managed Cloud images do not require saved qualification for runner discovery
or execution. The server checks company access before applying this policy.
Execution uses the platform-selected image and keeps runtime startup checks.
Self-hosted environments and active captured custom images keep qualification.
This exception does not grant access to the probe endpoints.
The active Cloud provisioner configuration must cover the provider; a leftover
metadata marker is insufficient. Discovery does not resolve provider secrets.

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

Capability ID: `execution-environments/assignment`.

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

Scoped plugin execution update: `paperclip_runner` supports a saved plugin
environment through the server-selected lease and the SDK `environmentTask` RPC.
This is an execution path, not a new agent-callable management endpoint. Host
company/project checks and native PRP authorization remain required; declaring a
plugin capability does not authorize the agent to change its environment.
The [integration fixture](../../server/src/__tests__/plugin-runner-task.integration.test.ts)
exercises the host and SDK with synthetic tasks and a mocked WebSocket.
The task API does not transfer files or reveal guest filesystem paths.
Controller replacement preserves the original task lease and run identity.
Current company, agent, workspace, and lease checks still gate state reads and
connection acquisition. Reconnection adds no agent management permission or
replacement task submission. The integration covers this with synthetic tasks;
it does not establish deployed plugin recovery.
This source update does not qualify live agent access, warm retention, or a provider.
See the [execution contract](../../doc/plugins/PLUGIN_RUNNER_EXECUTION.md).

Same-run checkpoint recovery also uses the saved lease path after a turn omits
its completion result. It requires verified prior termination, retained session
state, and matching company, agent, workspace, and complete Runner identity.
The [executor regression](../../server/src/services/native-runtime/native-session-executor.test.ts)
checks checkpoint retrieval and identity/termination denials. The
[lease authority fixture](../../server/src/__tests__/environment-task-authority.integration.test.ts)
checks the same-run read through the database-backed task API. These are
controlled regressions; live provider acceptance remains separate.

## `images`

Capability ID: `execution-environments/images`.

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

The task-only setup path uses a Core-issued expiring probe identity and a real,
read-only Runner hello. The plugin checks project authentication before provider startup.
[Setup probe coverage](../../server/src/services/native-runtime/plugin-runner-probe.test.ts)
uses the real Runner and a synthetic Codex provider through loopback PRP; TLS
termination is replaced by the fixture. It does not qualify a live plugin provider.

The plugin prepares execution-host resources and the provider descriptor. Core validates the result, then supplies task identity and PRP launch limits.

Managed account transfer requires `projectAuthCheckVersion: 1` and a successful
`check_project_auth` result for the exact prepared configuration, provider, and
project set. New preparation removes old validation. Core checks the saved
validation again in the dispatch update.
