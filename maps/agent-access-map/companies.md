# Companies and portability — agent access

Product map: [Companies and portability](../feature-map/companies.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `selection`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}`.
- `GET /api/companies`.
- `POST /api/companies`.

Agent access: `partial` — Agent reads its bound company; CLI context chooses it; board
lists/creates companies.

Policy: Same-company CEO or board for identity/import operations; list/create/archive
convenience endpoint is board-gated.

Evidence: `source-only` — [implementation](../../server/src/routes/companies.ts#L1245)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: A worker cannot enumerate/create companies via its company agent key. Browser
selection is local state.

## `identity`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/companies/{companyId}`.
- `PATCH /api/companies/{companyId}/branding`.

Agent access: `available` — Same-company CEO REST / native call_api / CLI company.

Policy: Same-company CEO or board for identity/import operations; list/create/archive
convenience endpoint is board-gated.

Evidence: `source-only` — [implementation](../../server/src/routes/companies.ts#L1245)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: The CEO restriction is a real policy, not a missing API; ordinary employees need
denial evidence.

## `archive`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/archive`.
- `PATCH /api/companies/{companyId}`.

Agent access: `partial` — Board archive endpoint; CEO company PATCH can express status
changes.

Policy: Same-company CEO or board for identity/import operations; list/create/archive
convenience endpoint is board-gated.

Evidence: `source-only` — [implementation](../../server/src/routes/companies.ts#L1245)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Convenience archive and general company PATCH have different authorization. Review
equivalence rather than declaring all archival human-only.

## `portability`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/exports`.
- `POST /api/companies/{companyId}/imports/preview`.
- `POST /api/companies/{companyId}/imports/apply`.

Agent access: `partial` — Same-company CEO REST / native `call_api` / CLI exports
and eligible same-company imports.

Policy: Same-company CEO or board for identity/import operations; list/create/archive
convenience endpoint is board-gated.

Evidence: `source-only` — [implementation](../../server/src/routes/companies.ts#L1245)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Exports use inline credential delivery and encrypted mutation receipts.
New-company/ZIP import flows retain their board and transport constraints.

## `decision-models`

Review: `baseline`.

API: `present` — GET and PUT /api/companies/{companyId}/decision-model;
POST /api/companies/{companyId}/decision-model/test;
GET /api/companies/{companyId}/decision-model/availability;
GET /api/companies/{companyId}/decision-model/history.

Agent access: `partial` — same-company REST and admitted native call_api
availability/history reads where policy allows. Settings and the fixed Test
action require board identity. Native rollout/run gates follow the shared
[transport contract](README.md#native-rest-transport).

Policy: Settings access requires board and company access; non-managers receive
no settings or choices. Configuration and tests additionally require connection
management authority (owner/admin, instance admin, or tools:manage_connections).
History requires company_scope:read and redacts task/run links without issue:read.
Background sponsorship and budget admission remain separate service checks.

Evidence: `source-only` — reviewed on 2026-10-13 at
`60bc0d5fee9a6e48db08fc016521fee3d9f57d67`:
[routes](../../server/src/routes/decision-models.ts),
[service](../../server/src/services/decision-models.ts), and
[connection authority](../../server/src/routes/ai-connections.ts).

Verification: `not-run` — read history with an allowed company actor and an actor
without task access; check link redaction. Reject agent configuration/tests and
board mutations without connection-management permission. Verify settings and
bounded test receipts with an owned simulated provider.

Gaps: No agent settings/test path; permitted history does not delegate management.
Live native and agent-credential reads remain unverified.

## `fast-responses`

Review: `baseline`.

API: `present` — GET and PUT /api/companies/{companyId}/fast-response;
GET /api/companies/{companyId}/fast-response/models;
GET /api/companies/{companyId}/fast-response/availability;
POST /api/companies/{companyId}/fast-response/test;
GET /api/companies/{companyId}/fast-response/history.

Agent access: `partial` — same-company REST and admitted native call_api history
reads where policy allows, subject to the shared
[transport contract](README.md#native-rest-transport).
Settings, model selection, availability and test controls require board identity.

Policy: Board and company access gate configuration surfaces. Updates, models
and tests additionally require connection-management authority. History requires
company_scope:read; task/run links require issue:read. The experiment, provider
account, sponsorship and budget controls still gate actual acknowledgements.

Evidence: `source-only` — reviewed on 2026-10-13 at
`60bc0d5fee9a6e48db08fc016521fee3d9f57d67`:
[routes](../../server/src/routes/fast-responses.ts),
[service](../../server/src/services/fast-responses.ts), and
[connection authority](../../server/src/routes/ai-connections.ts).

Verification: `not-run` — inspect history and redacted task links as an allowed
company actor. Reject agent settings/models/availability/tests and unauthorized
board mutations. Use a simulated provider to inspect a saved configuration,
success receipt, timeout and recorded usage.

Gaps: No agent configuration/test path. An acknowledgement is not completed task
work. Live native, provider and agent access remain unverified.

## `agent-observability`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/observability`.
- `PUT /api/companies/{companyId}/observability`.
- `DELETE /api/companies/{companyId}/observability`.
- `POST /api/companies/{companyId}/observability/test`.

Agent access: `operator-only` — configuration and tests require board context.

Policy: Company access and Manage connections permission; non-managing board readers receive no settings.
Credentials are write-only and stored through company secret bindings.

Evidence: `source-only` — [routes](../../server/src/routes/agent-observability.ts).

Verification: `not-run` — exercise board management, restricted board, agent denial, and cross-company denial.

Gaps: Direct agent management and independent personal harness enrollment are outside v1.
