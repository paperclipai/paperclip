# Skill discovery, authoring, and policy — agent access

Product map: [Skill discovery, authoring, and policy](../feature-map/skills.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `discovery`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/skills`.
- `POST /api/companies/{companyId}/skills/import`.

Agent access: `available` — REST / native call_api / CLI skills and sources.

Policy: Company skill policy by action/resource plus platform invariants; test execution
additionally requires task-assignment authority.

Evidence: `source-only` —
[implementation](../../server/src/routes/company-skills.ts#L208) at the reviewed commit
above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Installation/import is governed by company skill policy, not inferred from an
agent's role name.

## `authoring`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/skills`.
- `PATCH /api/companies/{companyId}/skills/{skillId}/files`.

Agent access: `available` — Native create_skill/update_skill for single-file operations;
REST for other files/metadata.

Policy: Company skill policy by action/resource plus platform invariants; test execution
additionally requires task-assignment authority.

Evidence: `source-only` —
[implementation](../../server/src/routes/company-skills.ts#L208) at the reviewed commit
above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Writable/fork policy and expected version apply. Native helpers intentionally
support a narrower shape than full API.

## `versions`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/skills/{skillId}/versions`.

Agent access: `available` — REST / native call_api / CLI skills.

Policy: Company skill policy by action/resource plus platform invariants; test execution
additionally requires task-assignment authority.

Evidence: `source-only` —
[implementation](../../server/src/routes/company-skills.ts#L208) at the reviewed commit
above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Revision metadata has an API; pinned execution skill versions and installed latest
are distinct.

## `policy`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PUT /api/companies/{companyId}/skill-policy`.
- `POST /api/agents/{id}/skills/sync`.

Agent access: `partial` — REST / native call_api under users:manage_permissions or
target configuration policy.

Policy: Company skill policy by action/resource plus platform invariants; test execution
additionally requires task-assignment authority.

Evidence: `source-only` —
[implementation](../../server/src/routes/company-skills.ts#L208) at the reviewed commit
above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Policy administration has an explicit agent grant branch; assigning agent skills
also checks the target's config authority.

## `testing`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/skills/{skillId}/test-runs`.

Agent access: `available` — Permitted agent REST / native `call_api` creation, control
and history; no dedicated CLI test command found.

Policy: Company skill policy by action/resource plus platform invariants; test execution
additionally requires task-assignment authority.

Evidence: `source-only` —
[implementation](../../server/src/routes/company-skills.ts#L208) at the reviewed commit
above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated native orchestration binding; generic REST calls retain
skills.test policy, task-assignment authorization, responsible-user intersection and
admitted skill-test JWT scope.

Project-source API additions: GET `/api/companies/{companyId}/skill-sources/project-repositories`,
POST `/api/companies/{companyId}/skill-sources/adopt-project` with `workspaceId`, and
PATCH `/api/companies/{companyId}/skill-sources/{sourceId}/settings` with expected revision
and update/connection preferences. Native API discovery uses the OpenAPI registration.

Project-derived read/use permission follows current project authorization, with access
through either originating project. File/version reads, source metadata, mutations,
editable copies, tests and runtime delivery retain that boundary. Unattended refresh
uses the revalidated setup identity and connection, not the requesting agent's token.
These additions need actual permitted/denied agent-run acceptance; service tests alone
are not live credential proof.

Direct GitHub source imports share the project setup-identity boundary. API-key
agents may import permitted public content, but their responsible-user field
does not authorize unattended credential use. They need human connection repair
for automatic refresh. Authenticated agent runs derive the setup person from
the persisted active run. Legacy agent activity without a matching run cannot
recover a refresh person. Route and database tests cover these distinctions;
this addition makes no new live-provider acceptance claim.

Initial project imports check skills.import before provider reads; denied jobs
do not retry automatically. Deferred jobs remain durable behind per-project and
company admission limits. Scheduled refresh compares immutable tree identity and
uses a persistent work allowance; manual refresh still requires its existing
policy/access checks. These limits grant no content or execution access.

Agent repository setup preserves the active run's selected GitHub connection/grant
IDs. Missing selections require human repair; the worker never searches the
responsible person's other grants for an agent-created source.

Initial automatic imports reserve company work credits before provider reads.
Failures retain the reservation; completed jobs cannot replenish the queue's
work allowance. Jobs remain durable and resume as company credits refill.
