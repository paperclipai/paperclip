# Secrets, personal credentials, and proposals — agent access

Product map: [Secrets, personal credentials, and proposals](../feature-map/secrets.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `company-secrets`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/secrets/catalog`.
- `POST /api/companies/{companyId}/secrets`.

Agent access: `partial` — Agent REST / native `call_api` metadata catalog and secret
proposals; company secret administration remains board-only.

Policy: Board secret administration, active-run/self/report proposal policy, and scoped
secret broker bindings; personal secret values belong to their user.

Evidence: `source-only` — [implementation](../../server/src/routes/secrets.ts#L194) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Native transport preserves board-only administration. Bound value retrieval
is a separate scoped operation described under runtime-delivery.

## `user-secrets`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/me/user-secrets`.
- `POST /api/companies/{companyId}/me/user-secrets`.

Agent access: `restricted` — Current board user's personal-secret API; agent receives
only authorized run binding.

Policy: Board secret administration, active-run/self/report proposal policy, and scoped
secret broker bindings; personal secret values belong to their user.

Evidence: `source-only` — [implementation](../../server/src/routes/secrets.ts#L194) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Agent cannot edit a person's private credential value through their ordinary agent
key.

## `proposals`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/me/secret-proposals`.
- `GET /api/agents/me/secret-proposals`.

Agent access: `partial` — Active-run agent REST / native `call_api` with redaction;
approval/rejection remains board-only.

Policy: Board secret administration, active-run/self/report proposal policy, and scoped
secret broker bindings; personal secret values belong to their user.

Evidence: `source-only` — [implementation](../../server/src/routes/secrets.ts#L194) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production proposal tool is required for the REST path.
Native calls retain active-run, scope and skill-test JWT restrictions.

## `vault-import`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/secrets/remote-import/preview`.
- `POST /api/companies/{companyId}/secrets/remote-import`.

Agent access: `restricted` — Board authorized vault import API / CLI provider
operations.

Policy: Board secret administration, active-run/self/report proposal policy, and scoped
secret broker bindings; personal secret values belong to their user.

Evidence: `source-only` — [implementation](../../server/src/routes/secrets.ts#L194) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Vault import is not implied by having a secret binding or the ability to propose a
secret.

## `runtime-delivery`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/agents/me/secrets`.
- `POST /api/agents/me/secrets/{key}/value`.

Agent access: `available` — Authorized environment/broker delivery and scoped agent
REST / native `call_api` value retrieval.

Policy: Board secret administration, active-run/self/report proposal policy, and scoped
secret broker bindings; personal secret values belong to their user.

Evidence: `source-only` — [implementation](../../server/src/routes/secrets.ts#L194) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Server-only instance secrets are excluded from this path. They belong to the
company, owning agent, and installed lifecycle plugin. The existing local lifecycle
callback can save them through the native secret service; there is no agent API
for their values. Source: [native secret coordinator](../../server/src/services/agent-instance-secrets.ts)
and [scope/denial tests](../../server/src/__tests__/agent-instance-secrets.test.ts).
No live agent execution is claimed for this exclusion.

Gaps: Values remain restricted to the bound agent and active run. Credential
responses stay inline and use encrypted mutation receipts; they are not saved as
plaintext response assets. Dedicated scenario read_secret_value remains unbound.
