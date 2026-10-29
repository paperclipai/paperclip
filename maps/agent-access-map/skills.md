# Skill discovery, authoring, and policy — agent access

Product map: [Skill discovery, authoring, and policy](../feature-map/skills.md).

Feature ID: `skills`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Cold Git package recovery rechecks the original source's current setup identity,
company membership, policy and repository grant. It never borrows another company's
credentials or substitutes a moving branch for the saved commit. A missing/revoked
source fails with a reconnect error and persisted retry backoff. Warm access still
uses the ordinary skill/project permission check.

External package storage changes persistence, not agent authority. Runtime selection
still checks current company/project access before consulting immutable package caches;
no storage key is exposed as an agent capability. Public selected rows are constrained
to `access_source_id IS NULL` at their final read. Warm package and native asset caches
hold file metadata, never authorization decisions. The
[concurrency regression](../../server/src/__tests__/company-skills-runtime-concurrency.test.ts)
covers separate actors and revoked project access; the
[package regression](../../server/src/__tests__/skill-package-store.test.ts) covers
company isolation and warm-cache behavior. This does not claim live agent qualification.

## `discovery`

Capability ID: `skills/discovery`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/skills`.
- `POST /api/companies/{companyId}/skills/import`.

Agent access: `available` — REST / native call_api / CLI skills and sources. Queue
and HTTP/2 sandbox callbacks also admit company skill detail and file reads;
file paths travel in the existing `path` query parameter. Skill mutations stay
subject to the existing bridge restrictions.

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

Capability ID: `skills/authoring`.

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

Version lists and current/test-run version summaries contain file names and kinds.
Use `GET /api/companies/{companyId}/skills/{skillId}/versions/{versionId}` for the
selected version's file contents. Authorization remains company/skill scoped; support
inspection reads only stored bytes for the requested version and does not recover Git.


Capability ID: `skills/versions`.

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

Runtime disk-cache expiration does not delete version records or change access. Normal
execution rematerializes saved bytes after existing skill authorization; cleanup is an
internal company-scoped maintenance operation, with no new agent endpoint. Verify pinned
restoration and active-run protection with `server/src/__tests__/skill-version-cache.test.ts`
and the assembled heartbeat runtime-skill tests; live acceptance remains separate.

Native runs with an empty effective or saved selection do not read skill files
or wait for the company cache lock. Explicit references still require the existing
skill authorization. Selected skills and legacy operational skills retain cache
exclusion and immutable version pinning. This changes no agent endpoint or grant;
the [configuration tests](../../server/src/__tests__/heartbeat-execution-configuration.test.ts)
cover the held-lock boundary with real PostgreSQL.

Concurrent preparations share only in-flight inventory reconciliation. After
that work, each actor's visible skill rows are read again under the company cache
lock. Snapshot delivery and durable run pins complete before the lock is released.
No permission result is shared or kept between requests. The
[concurrency tests](../../server/src/__tests__/company-skills-runtime-concurrency.test.ts)
cover separate actors and project-access revocation; this adds no agent API.

## `policy`

Capability ID: `skills/policy`.

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

The configuration-gated `GET /api/agents/{id}/skills` reads repository cache
locations without materializing versions or validating their support files.
Assignment mutations and run preparation retain their existing authorization.
The [database-backed cache tests](../../server/src/__tests__/skill-version-cache.test.ts)
cover latest/pinned reads and full validation during execution; they do not prove
live agent access.
Both skill-list and skill-sync responses preserve stored version pins rather than
returning a resolved runtime version as a pin. Latest remains unpinned across an
assignment round trip.

## `testing`

Capability ID: `skills/testing`.

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
and update/connection preferences. `trackingRef` accepts a branch or explicit ref;
`"HEAD"` keeps default-branch tracking. GET `/api/companies/{companyId}/skill-sources/{sourceId}/branches`
returns a bounded branch list and the default branch, with optional `connectionId` for
connection repair. It requires source access and `skills.edit`, and reads only through
the caller's authorized GitHub grant. Saving validates the requested ref before changing
an independent source; active project bindings must be edited through their
project configuration. Responses identify branch, connection, or retry repair and distinguish
queued imports from imports under an active worker lease. Native API discovery uses the OpenAPI registration.

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

Repository import, preview, and refresh share the bounded dependency-package fallback.
Missing-reference warnings do not deny an otherwise authorized import. Recovered
files come only from the same immutable, authorized Git tree and pass the existing
content audit; no host paths or additional credentials are consulted. Source tests
cover transitive files, limits, retained versions, and legacy dependency-error recovery.

Agent repository setup preserves the active run's selected GitHub connection/grant
IDs. Missing selections require human repair; the worker never searches the
responsible person's other grants for an agent-created source.

Initial automatic imports reserve company work credits before provider reads.
Failures retain the reservation; completed jobs cannot replenish the queue's
work allowance. Jobs remain durable and resume as company credits refill.


Plugin runtime synchronization uses the agent's current skill access and immutable
version resolver. A change to an installed skill invalidates its referencing
agents. Private-source access changes also request reconciliation. This is a
host-to-plugin hook, not a new agent-facing endpoint. See
[contract](../../doc/plugins/AGENT_RUNTIME_SYNC.md#skills) and
[database coverage](../../server/src/__tests__/agent-runtime-skills.test.ts).
