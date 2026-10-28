# Navigation, profile, and announcements — agent access

Product map: [Navigation, profile, and
announcements](../feature-map/navigation-preferences.md).

Feature ID: `navigation-preferences`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `navigation`

Capability ID: `navigation-preferences/navigation`.

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

Capability ID: `navigation-preferences/preferences`.

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

Capability ID: `navigation-preferences/profile`.

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

Capability ID: `navigation-preferences/announcements`.

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

Capability ID: `navigation-preferences/fallbacks`.

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

## `command-palette`

Capability ID: `navigation-preferences/command-palette`.

Review: `baseline`.

API: `present` — GET /api/companies/{companyId}/issues for quick task matches; GET /api/companies/{companyId}/projects, GET /api/companies/{companyId}/agents, and GET /api/companies/{companyId}/labels for context; GET /api/companies/{companyId}/search for full search. Opening the palette or handling a keyboard shortcut is browser presentation, not a new mutation API.

Agent access: `partial` — actual resource/search reads use REST or admitted native `search_tasks`/`call_api` with their actor-specific fields and scope. Palette open state, focus, and key chords are browser-only; they do not require an agent keyboard API.

Policy: Underlying company/task/project read authorization and private-result filters apply. Full search requires company_scope:read; a human-only filter such as assigneeUserId=me is not valid board identity for an agent. A local create/navigation action still uses the destination feature’s normal permissions. Keyboard handling respects focused inputs and modal ownership.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Command palette](../../ui/src/components/CommandPalette.tsx), [shortcut hook](../../ui/src/hooks/useKeyboardShortcuts.ts), [query parser](../../ui/src/lib/search-query-parser.ts), and [search routes](../../server/src/routes/issues.ts).

Verification: `not-run` — Drive palette and shortcut entry points in the browser, preserve filter/query intent into full search, and check denied private/foreign results. Separately call the read/search path with the actual permitted agent and reject unsupported human-only filters; a board palette result is not agent authorization evidence.

Gaps: The map records transient palette state, not a promise that its open state or draft input survives reload. Every shell, keyboard layout, file-viewer gate, and creation action is not qualified by one palette test.
