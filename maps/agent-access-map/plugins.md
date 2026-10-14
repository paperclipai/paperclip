# Plugins and contributed product surfaces — agent access

Product map: [Plugins and contributed product surfaces](../feature-map/plugins.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `installation`

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

## `contributions`

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
