# Navigation, profile, and announcements — agent access

Product map: [Navigation, profile, and
announcements](../feature-map/navigation-preferences.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `navigation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/projects`.
- `GET /api/companies/{companyId}/resource-memberships/me`.

Agent access: `partial` — Resource APIs plus user-specific stars; browser-local recents.

Policy: Persisted user preferences require board user context; resource reads still
apply company visibility.

Evidence: `source-only` —
[implementation](../../server/src/routes/sidebar-preferences.ts#L8) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Underlying resources have APIs; recents are client-local, and personal starring
needs its own identity policy.

## `preferences`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/sidebar-preferences/me`.
- `PUT /api/sidebar-preferences/me`.

Agent access: `restricted` — Board-user preference API; browser section collapse.

Policy: Persisted user preferences require board user context; resource reads still
apply company visibility.

Evidence: `source-only` —
[implementation](../../server/src/routes/sidebar-preferences.ts#L8) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Catalog metadata says board_or_agent, but requireBoardUserId rejects agents.
Collapse is in-memory; global collapse is disabled.

## `profile`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/users/{userSlug}/profile`.
- `PATCH /api/auth/profile`.

Agent access: `partial` — Agent can read eligible company profile; changing personal
identity requires board user.

Policy: Persisted user preferences require board user context; resource reads still
apply company visibility.

Evidence: `source-only` —
[implementation](../../server/src/routes/sidebar-preferences.ts#L8) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Reading another visible user's profile and editing a person's identity are
distinct permission paths.

## `announcements`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/announcements/current`.
- `POST /api/announcements/{id}/dismiss`.

Agent access: `restricted` — Board-user announcement API.

Policy: Persisted user preferences require board user context; resource reads still
apply company visibility.

Evidence: `source-only` —
[implementation](../../server/src/routes/sidebar-preferences.ts#L8) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: User-specific instance-wide dismissal has no agent delegation path today.

## `fallbacks`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}`.
- `GET /api/projects/{id}`.

Agent access: `partial` — API not-found/access semantics; browser router redirects.

Policy: Persisted user preferences require board user context; resource reads still
apply company visibility.

Evidence: `source-only` —
[implementation](../../server/src/routes/sidebar-preferences.ts#L8) at the reviewed
commit above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: Record lookup exists. Route redirects/fallback presentation do not need a separate
domain API.
