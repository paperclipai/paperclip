# Plugins and contributed product surfaces — agent access

Product map: [Plugins and contributed product surfaces](../feature-map/plugins.md).

Feature ID: `plugins`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `installation`

Capability ID: `plugins/installation`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/plugins/install`.

Agent access: `restricted` — Instance-admin REST / CLI plugin.

Policy: Instance plugin management requires board/admin; declared tools and scoped APIs
apply their own company/agent policy.

Evidence: `source-only` — [implementation](../../server/src/routes/plugins.ts#L965) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: No ordinary agent install path; installing executable plugin code is an explicit
authority decision.

## `configuration`

Capability ID: `plugins/configuration`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/plugins/{pluginId}/config`.
- `POST /api/plugins/{pluginId}/config`.

Agent access: `restricted` — Board read/admin write; CLI plugin.

Policy: Instance plugin management requires board/admin; declared tools and scoped APIs
apply their own company/agent policy.

Evidence: `source-only` — [implementation](../../server/src/routes/plugins.ts#L965) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Company-scoped configuration value does not turn the instance management route
into an agent route.

Runtime synchronization is a host-to-plugin contract. An opt-in `agent_runtime`
subscriber receives committed changes through `onResourceLifecycle`. The runtime
reader requires `agents.lifecycle.manage`, the invocation company, and selection
as that agent's owning lifecycle plugin. Disabled and unrelated plugins cannot
read its instance secrets. See [contract](../../doc/plugins/AGENT_RUNTIME_SYNC.md)
and [database regressions](../../server/src/__tests__/agent-runtime-hooks.test.ts).
This does not add an ordinary agent API.

## `contributions`

Capability ID: `plugins/contributions`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/plugins/tools`.
- `POST /api/plugins/tools/execute`.

Agent access: `partial` — Agent REST plus assigned native/gateway plugin tools and
scoped plugin APIs.

Policy: Instance plugin management requires board/admin; declared tools and scoped APIs
apply their own company/agent policy.

Evidence: `source-only` — [implementation](../../server/src/routes/plugins.ts#L965) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Actual plugin tool use exists; a contributed UI route alone does not prove that
plugin's API/tool coverage.

## `lifecycle`

Capability ID: `plugins/lifecycle`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/plugins/{pluginId}/enable`.
- `POST /api/plugins/{pluginId}/disable`.

Agent access: `restricted` — Instance-admin REST / CLI plugin; dev watcher for reload.

Policy: Instance plugin management requires board/admin; declared tools and scoped APIs
apply their own company/agent policy.

Evidence: `source-only` — [implementation](../../server/src/routes/plugins.ts#L965) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Disable/remove and development reload are management workflows with no default
company agent access.

## Project Git authorization

Project workspace writers can use `PUT /api/projects/{id}/git-authorization` to
consent to their own eligible personal GitHub Connector grant. This route is
board-only; agent requests cannot establish standing consent. `GET` requires
project read access and returns no token. SDK `projects.resolveGitCredential`
requires `projects.git-credentials` and a matching host-issued project operation.
Background work uses the selected project grant. Foreground preparation uses the
active run identity and trust boundary. UI/data/tool invocations have no export
authority. No task identity is retained for maintenance.
Background export rechecks the consenting user's project read access and project
trust policy. Repository access follows the selected connection, including later
project additions; no separate project repository approval list is stored.
Archived projects allow only host-issued workspace inspection and removal using
existing consent; they cannot acquire credentials for provisioning.

Evidence: owned embedded-database grant/route fixtures in
`server/src/__tests__/project-git-authorization.test.ts`, worker invocation
fixtures in `server/src/__tests__/plugin-worker-manager.test.ts`, and capability
and scope denials in `packages/plugins/sdk/tests/host-client-factory.test.ts`.
These are automated fixture checks, not live provider qualification.
