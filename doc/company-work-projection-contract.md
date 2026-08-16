# Company Work Projection v1

Status: Accepted implementation contract

API version: `paperclip.company-work-projection/v1`

Schema version: `1`

## Purpose and authority

Paperclip remains authoritative for work identity, ownership, project, priority,
and planning lifecycle. This contract gives a machine client a bounded,
company-scoped projection of that authority. It does not add an orchestration
service, executor, recovery mechanism, UI, or write path.

The only machine read route is:

`GET /api/v1/companies/:companyId/work-projection`

`HEAD` is not part of the contract and is denied. The route requires a
dedicated `pcwp_v1_` credential stored only in
`company_work_projection_credentials`. It is not an agent API key or JWT scope,
has no agent identity, and is bound to the company recorded at creation. Later
membership, role, or permission changes cannot expand it. Global middleware
rejects this credential on every other path and on every non-GET method.

Only active company owners/admins with the dedicated
`work_projection_credentials:manage` permission can create, list, or revoke
these credentials through the company-scoped
`/api/v1/companies/:companyId/work-projection-credentials` routes. Missing and
inaccessible companies both return the same `404` on every lifecycle route.
For create and revoke, the active owner/admin membership and dedicated grant
are locked and re-read inside the same database transaction as the credential
mutation and required activity row. Concurrent demotion or grant removal
therefore serializes before or after that whole transaction; it cannot commit
between authorization and credential commit. Credential rows carry a required
creation-activity reference, and
an active credential cannot exist without that audit row. Revocation is
lock-serialized and idempotent, with exactly one revocation activity reference.
Plaintext is returned once at creation. Older Paperclip binaries query
only `agent_api_keys`, so they cannot discover or reinterpret these hashes. The
amended unreleased migration also revokes any residue from the earlier
agent-scope candidate. Malformed and unknown token versions stay inside the
reserved `pcwp_` family and fail closed without falling through to another auth
mechanism.

Authenticating or reading through this scope does not update
credential metadata, insert activity or denial records, repair recovery state,
initialize schema, or persist any other observation. Projection credentials
are rejected before the live-events WebSocket performs any key-table update,
upgrade, subscription, or event delivery. The read service also starts its
database transaction with PostgreSQL
`READ ONLY`, so an accidental write fails at the database boundary.

## Bounded response

Every `200` body is runtime-validated by the strict shared Zod schema
`companyWorkProjectionResponseSchema`; the same schema feeds TypeScript and the
generated OpenAPI document. Objects reject unknown properties.

An item contains only:

- issue UUID and bounded identifier;
- a closed owner union: `agent`, `user`, or `unassigned`;
- nullable project UUID;
- one of four priorities and one of the seven Paperclip planning states;
- timezone-aware created, updated, started, completed, and cancelled instants;
- the item revision and a SHA-256 digest of the safe fields.

Digests are SHA-256 over the UTF-8 bytes of RFC 8785 JSON Canonicalization
Scheme output. Object keys are lexicographically sorted, arrays preserve order,
and only JSON strings, finite numbers, booleans, null, arrays, and objects are
accepted. Official RFC number, escaping, Unicode, and property-order vectors
are regression-tested, and lone Unicode surrogates are rejected. Source fields
are first parsed by the closed response-field schema; only those parsed values
are hashed. Empty or whitespace-padded identity evidence is incompatible rather
than silently normalized. This makes evidence and ETag values reproducible
across languages.

It never contains titles, descriptions, prompts, comments, adapter or execution
configuration, credentials, workspaces or local paths, recovery internals, raw
payloads, or private metadata. An issue with an ambiguous owner, unknown state,
unknown priority, oversized identifier, or malformed timestamp makes the
snapshot incompatible; the server fails closed instead of dropping or guessing
the value. A project, agent owner, or user owner that does not belong to the
issue company, or is no longer eligible because the project is archived, the
agent is pending/terminated, or the user membership is inactive, also fails
closed rather than leaking the reference. Those validity facts are stored in
each history row. Project, agent, and membership lifecycle changes append new
issue projection versions, so a signed historical snapshot never joins mutable
current reference state and replays byte-identically.

## Snapshot and pagination semantics

Migration `0218_company_work_projection` takes `SHARE ROW EXCLUSIVE` locks on
`public.companies`, `public.issues`, `public.projects`, `public.agents`, and
`public.company_memberships` for its full transaction. This blocks every write
that can affect collection membership or reference validity while counters and
source witnesses are seeded, capture triggers are installed, and existing work
is backfilled. The lock is held for the duration of the schema work plus an
O(visible issue count) backfill, head construction, full verification, and
statistics refresh; operators must estimate that count and use a maintenance
window for large tables.

Every existing company receives an explicit revision-zero counter, an
independent source-integrity witness with the same random token; an `AFTER
INSERT` company trigger creates both plus a revision-zero verification receipt
for future companies. The issue
trigger records each visible insert, update, hide, unhide, harness toggle,
plugin-visibility toggle, company move, and delete in the same transaction as
the source mutation. Each eligible source change advances the independent
witness and materialized counter to a new random integrity token and appends a
matching immutable source event plus safe history row. Normal work-list
semantics apply: hidden, harness, and plugin-operation issues are excluded.
Deletions and removals are tombstones. Revisions are contiguous within a
company; reverse referential integrity and append-only guards prevent a runtime
history gap.

The first page fixes a high-water revision. A bounded
`company_work_projection_issue_heads` table stores one routing row per issue
lifetime. Pages walk its `(company, first revision, issue UUID)` index in that
order, at most `pageSize + 1` head rows at a time, and perform one indexed lateral history
lookup per head to select the latest version at or below the high-water mark.
Tombstones consume a cursor slot but are omitted from `items`, so a partial page
may contain fewer items than its requested size while still making deterministic
progress. Accumulated history is never reconstructed per request. The cursor
binds company, API/schema version, high-water revision, position, page size,
issue time, and expiry. It is HMAC-signed with an instance- and company-derived
key. No process-local cursor state is required, so replay and restart are
deterministic until expiry.

Reads require the counter, independent source witness, current source event,
current history row, database epoch, and post-recovery verification receipt to
agree on revision, token, and retained history/event counts before serving any
snapshot. These readiness checks are primary-key/index lookups rather than a
full-history scan. Separate 100,000-revision PostgreSQL query-plan regressions
cover actual first, middle, and final page execution, require indexed head and
history scans, bound materialization rows to the page limit, and enforce the
API's 250 ms latency ceiling. Missing, behind, ahead, gapped, unverified, or
partially restored state is incompatible; it is never interpreted as empty or
complete.

Snapshots expire after five minutes. Replaying a cursor returns the same page;
clients may safely deduplicate by item ID and revision. A concurrent issue
mutation advances the live collection but cannot alter an existing snapshot.
A fresh first page observes the new revision. If the server detects an expired
cursor, a high-water revision ahead of current storage, a revision gap, a
tampered cursor, or an incompatible version, it returns an explicit error and
never marks the result complete.

A cursor presented to a different company is reported as malformed. The
endpoint does not provide an authorization oracle about whether that cursor is
valid for another company.

Page size defaults to 100 and is capped at 500. `hasMore=true` always pairs with
`completeness="partial"` and a cursor. A terminal page, including an empty
collection, uses `hasMore=false`, `nextCursor=null`, and
`completeness="complete"`.

Cursor signing is an endpoint-readiness requirement: missing signing material
returns `503` even for empty or one-page collections. Every page has a strong
`ETag`. `If-None-Match` follows HTTP weak comparison for GET, including tag
lists, weak tags, and `*`; a match returns `304`. The response also sets API
version, schema version, and snapshot revision headers.

New cursors use `PAPERCLIP_WORK_PROJECTION_CURSOR_SECRET` when configured,
falling back to the existing instance signing material. During rotation, one
`PAPERCLIP_WORK_PROJECTION_CURSOR_PREVIOUS_SECRET` may validate already-issued
cursors. Cursor lifetime is structurally capped at five minutes, so operators
retain the previous key for at least five minutes after switching the current
key and then remove it. No cursor is emitted with the previous key.

Admission is enforced by four PostgreSQL transaction-scoped advisory-lock slots
per credential. This limit is shared by every API process connected to the same
primary PostgreSQL database, persists no operational read data, and fails with
`429` when all slots are occupied. Supported multi-process deployments must
route every process to that same primary database. This is a concurrency bound,
not distributed requests-per-second enforcement: the deployment edge must also
enforce a sustained limit of 20 requests/second per credential and return `429`
with `Retry-After`. Multi-primary or independently sharded database topologies
are unsupported for this v1 contract.

## Result states

| HTTP | Meaning | Stable code |
|---:|---|---|
| 200 | Valid partial or complete page | body completeness |
| 304 | Matching page ETag | no body |
| 400 | Malformed query, cursor, signature, or position | `WORK_PROJECTION_MALFORMED` |
| 401 | Missing authentication | `WORK_PROJECTION_UNAUTHORIZED` |
| 403 | Wrong scope, credential type, route, method, or company | `WORK_PROJECTION_FORBIDDEN` |
| 409 | Unknown version/source value or damaged revision sequence | `WORK_PROJECTION_INCOMPATIBLE` |
| 410 | Expired or storage-stale snapshot | `WORK_PROJECTION_SNAPSHOT_EXPIRED` or `WORK_PROJECTION_SNAPSHOT_STALE` |
| 429 | Per-credential concurrent-read limit reached | `WORK_PROJECTION_RATE_LIMITED` |
| 503 | Database or signing key unavailable | `WORK_PROJECTION_UNAVAILABLE` |

There is no “healthy zero” fallback. Empty-complete, partial, incompatible,
expired, rate-limited, and unavailable remain distinct machine states.

## Upgrade, recovery, and rollback

The migration backfills one deterministic safe version per currently visible
normal-list issue while writes are locked and capture triggers are already
installed. Existing issue APIs and rows are unchanged. Deployments must apply
the migration before enabling clients.

If revision integrity fails, disable the route and preserve the independent
`company_work_projection_source_witnesses` table. Before disabling append-only
guards or starting any restore, call
`invalidate_company_work_projection_verification(company_id)` and commit that
invalidation while the route remains disabled. During the maintenance window,
restore/rebuild `company_work_projection_revisions`,
`issue_work_projection_versions`, `company_work_projection_source_events`, and
`company_work_projection_issue_heads`. Then call
`verify_company_work_projection_recovery(company_id)`. The offline verifier
holds the counter/witness rows, scans full history and source-event counts and
min/max continuity, verifies every revision/token pair, verifies one exact head
per retained issue with correct first/current bounds, and writes a receipt only
when all checks pass. Commit that receipt before re-enabling reads. A false
result leaves the receipt absent and the endpoint returns `409`.

This procedure is the protection boundary for privileged restore tooling:
ordinary source writes extend a current receipt transactionally, but a restore
that bypasses database guards must invalidate it first. Restoring only
projection tables cannot manufacture a current receipt. A full-database
point-in-time restore can reset issues, witness, epoch, and receipt together;
that is outside the partial-table guarantee and must be treated as a new
database epoch with the route disabled, all projection credentials revoked,
cursor/signing material rotated, all old cursors allowed to expire, and the
offline verifier run successfully before clients restart. Never reset a counter
while clients may hold cursors.

For that full-database case, after receipt invalidation and while the route is
still disabled, set `company_work_projection_source_witnesses.database_epoch`
to a new random UUID for each restored company. The old receipt then fails the
online epoch check. Run the same offline verifier to issue the first receipt for
the new epoch; tests prove the endpoint remains `409` between rotation and that
successful verification.

Rollback rehearsal is two-version and fail closed: first disable the route,
wait five minutes for cursors to expire, retain the dedicated credential table,
then roll back the application binary. Older binaries query only
`agent_api_keys`, so `pcwp_v1_` hashes remain undiscoverable and unusable. Do
not copy those hashes into `agent_api_keys`. Forward recovery reapplies this
migration/contract, establishes a fresh epoch for a full-database restore, runs
the offline verifier, verifies credential audit foreign keys, rotates the
cursor key, and only then re-enables the route.

The append-only tables have no automatic pruning in v1. A later retention policy
must preserve every unexpired high-water snapshot and requires a separate
reviewed storage decision.
