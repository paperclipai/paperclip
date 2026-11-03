# Team packages and catalog installation — agent access

Product map: [Team packages and catalog installation](../feature-map/teams.md).

Feature ID: `teams`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `discovery`

Capability ID: `teams/discovery`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/teams/catalog`.
- `GET /api/teams/catalog/{catalogId}`.

Agent access: `available` — REST / native call_api / CLI teams.

Policy: Authenticated catalog browsing; same-company preview; agent install requires
agents:create grant or canCreateAgents.

Evidence: `source-only` — [implementation](../../server/src/routes/teams-catalog.ts#L36)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Team browsing exists even though there is no dedicated teams product screen.

## `preview`

Capability ID: `teams/preview`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/teams/catalog/{catalogId}/preview`.

Agent access: `available` — REST / native call_api / CLI teams preview.

Policy: Authenticated catalog browsing; same-company preview; agent install requires
agents:create grant or canCreateAgents.

Evidence: `source-only` — [implementation](../../server/src/routes/teams-catalog.ts#L36)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Preview does not install a team; its audit write should not be mistaken for agent
execution proof.

## `install`

Capability ID: `teams/install`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/teams/catalog/{catalogId}/install`.

Agent access: `available` — Authorized agent REST / native call_api / CLI teams install.

Policy: Authenticated catalog browsing; same-company preview; agent install requires
agents:create grant or canCreateAgents.

Evidence: `source-only` — [implementation](../../server/src/routes/teams-catalog.ts#L36)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Actual agent permission branch exists. Resulting agents/accounts/workspaces may
still need operator setup.

## `configuration`

Capability ID: `teams/configuration`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/teams/catalog/{catalogId}/preview`.
- `POST /api/companies/{companyId}/teams/catalog/{catalogId}/install`.

Agent access: `partial` — Team package variables/options via REST/CLI; resulting
resources use their own APIs.

Policy: Authenticated catalog browsing; same-company preview; agent install requires
agents:create grant or canCreateAgents.

Evidence: `source-only` — [implementation](../../server/src/routes/teams-catalog.ts#L36)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: There is no independent generic team-edit resource; distinguish package options
from installed agent/project configuration.
