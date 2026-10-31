# Login, invitations, and access — agent access

Product map: [Login, invitations, and access](../feature-map/access.md).

Feature ID: `access`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `login`

Capability ID: `access/login`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/auth/get-session`.
- `POST /api/bootstrap/claim`.

Agent access: `restricted` — Agent authenticates with its own issued bearer; board login
uses human/client auth.

Policy: Company access plus action-specific grants; instance administration requires a
board administrator.

Evidence: `source-only` — [implementation](../../server/src/routes/access.ts#L3018) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: An agent identity is not a board login or board claim; explicit delegation is a
product-policy decision.

## `invitations`

Capability ID: `access/invitations`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/invites`.
- `POST /api/invites/{token}/accept`.

Agent access: `partial` — REST / native `call_api` invite creation with the invite
permission; CLI access. Human acceptance and agent onboarding have distinct policies.

Policy: Company access plus action-specific grants; instance administration requires a
board administrator.

Evidence: `source-only` — [implementation](../../server/src/routes/access.ts#L3018) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Invite creation has an agent permission branch. Human joining and agent onboarding
are different operations.

## `membership`

Capability ID: `access/membership`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/members`.
- `PATCH /api/companies/{companyId}/members/{memberId}/permissions`.

Agent access: `restricted` — agents cannot administer agent grants or mutate human
membership through the protected member routes. The action-specific invitation
permission remains a separate capability.

Policy: Company access plus action-specific grants; instance administration requires a
board administrator.

Evidence: `source-only` — [implementation](../../server/src/routes/access.ts#L3018) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Board operators with `users:manage_permissions` can discover agent membership IDs
with `GET /api/companies/{companyId}/members?principalType=agent` and replace their
operational grants through the existing permissions route. Agent targets cannot
receive `users:manage_permissions` or `joins:approve` through that route. Default
human listings, role/self/owner protections and user audit attribution remain.

Gaps: Delegated human-membership mutation is not implemented by this contract.
Instance-admin user operations stay board-only.

## `resources`

Capability ID: `access/resources`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}`.
- `GET /api/projects/{id}`.

Agent access: `available` — REST or scoped task/project tools.

Policy: Company access plus action-specific grants; instance administration requires a
board administrator.

Evidence: `source-only` — [implementation](../../server/src/routes/access.ts#L3018) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Company/resource authorization is implemented; a negative test must cover private
resources and another company.

## `cli-auth`

Capability ID: `access/cli-auth`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/cli-auth/challenges`.
- `POST /api/cli-auth/revoke-current`.

Agent access: `restricted` — Board CLI authorization; agents use issued agent
credentials.

Policy: Company access plus action-specific grants; instance administration requires a
board administrator.

Evidence: `source-only` — [implementation](../../server/src/routes/access.ts#L3018) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: CLI board login/revocation cannot be counted as agent self-authentication.
