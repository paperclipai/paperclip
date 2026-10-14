# Developer previews and diagnostic labs — agent access

Product map: [Developer previews and diagnostic labs](../feature-map/developer-labs.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `design`

Review: `baseline`.

API: `not-applicable` — No domain API required for static component examples; label this
as an explicit exception.

Agent access: `not-applicable` — Browser/Storybook / existing UI tooling.

Policy: Synthetic developer fixtures; no persisted company feature or agent authority
represented by the fixture.

Evidence: `source-only` — [implementation](../../ui/src/App.tsx) at the reviewed commit
above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: No domain API required for static component examples; label this as an explicit
exception.

## `interaction-labs`

Review: `baseline`.

API: `not-applicable` — A synthetic card's API parity belongs to the real feature, not
to a new lab API.

Agent access: `not-applicable` — Browser fixture plus the corresponding real interaction
API in its owning area.

Policy: Synthetic developer fixtures; no persisted company feature or agent authority
represented by the fixture.

Evidence: `source-only` — [implementation](../../ui/src/App.tsx) at the reviewed commit
above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: A synthetic card's API parity belongs to the real feature, not to a new lab API.

## `performance`

Review: `baseline`.

API: `not-applicable` — There is no domain REST action for scrolling a static fixture;
capture browser evidence separately.

Agent access: `not-applicable` — Browser performance fixture and measurement tooling.

Policy: Synthetic developer fixtures; no persisted company feature or agent authority
represented by the fixture.

Evidence: `source-only` — [implementation](../../ui/src/App.tsx) at the reviewed commit
above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: There is no domain REST action for scrolling a static fixture; capture browser
evidence separately.

## `route-gates`

Review: `baseline`.

API: `not-applicable` — Route registration and feature gates are not interchangeable; no
universal developer-only gate exists.

Agent access: `not-applicable` — Build/route inspection; relevant instance
feature-setting API for actual gates.

Policy: Synthetic developer fixtures; no persisted company feature or agent authority
represented by the fixture.

Evidence: `source-only` — [implementation](../../ui/src/App.tsx) at the reviewed commit
above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: Route registration and feature gates are not interchangeable; no universal
developer-only gate exists.
