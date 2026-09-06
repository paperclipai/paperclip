# @paperclipai/plugin-hdo-76-pixel-strip

HDO-76 Phase 2 prototype. Maps the archived HuiDots Owner-Console
**Pixel-Company visual authority** onto the live Paperclip UI as a
**read-only project-detail pixel strip**. State is mapped only from
persisted runtime state — no animation that implies work, no timer
inference, no write-back.

## Why this plugin exists

The Owner originally asked to "slowly improve the dashboard" so owners
have their own built surfaces, including the "pixel agents that
previously was done up". HDO-76 captured that intent as a four-phase,
Owner-gated plan. Phase 1 produced a research note ([Note
A](../packages/…/HDO-76-note-a-pixel-agent-surface.md)). This package
is the Phase 2 prototype for that note.

The prototype reuses the live Paperclip plugin SDK (`detailTab` +
`projectSidebarItem` slots, `usePluginData`/`usePluginAction`,
`pluginEntities`, `pluginState`) and the token-only rule from the live
Paperclip `DESIGN.md`. No raw hex, no decorative shadows, no fabricated
animation.

## What it does

- Adds a `Pixel Strip` tab on the project detail page.
- Adds an optional `Pixel Strip` sidebar item under each project.
- Renders one sprite per agent that currently has an active heartbeat
  run assigned to a project issue, plus one sprite per agent that is
  idle but recently worked on this project (last run within 24 h).
- Sprite state is mapped **only** from persisted runtime state:
  `working`, `waiting`, `blocked`, `decision_ready`, `idle`.

## What it explicitly does NOT do

- No animation that implies work or evidence.
- No timer-derived activity inference.
- No write-back to Paperclip state, issues, comments, or events.
- No re-creation of the archived `pixel-office/` SPA or the
  `pixel.css` / `pixel-company-live.css` styling.
- No second agent-framework seam, second event bus, or second truth
  source. Paperclip runtime is the only authority.

## Capabilities

The manifest declares only the read-side capabilities the prototype
needs. It does not request `issues.create`, `issue.comments.create`,
`issue.documents.write`, or `activity.log.write`.

```
companies.read
projects.read
issues.read
agents.read
events.subscribe
plugin.state.read
plugin.state.write
ui.detailTab.register
ui.projectSidebarItem.register
```

The plugin emits zero writes; this is enforced by capability surface,
not by code review alone.

## Verification approach

- `pnpm --filter @paperclipai/plugin-hdo-76-pixel-strip typecheck`
  passes.
- `pnpm --filter @paperclipai/plugin-hdo-76-pixel-strip test` passes
  and covers sprite-state derivation against fixture runtime state.
- `pnpm --filter @paperclipai/plugin-hdo-76-pixel-strip build`
  produces the manifest, worker, and UI bundles under `dist/`.
- The bundled UI renders a single row of pixel sprites that mirror the
  runtime truth; the verification tests assert the mapping.

## References

- HDO-76 — `Improvement and movement from paperclips` (parent issue).
- HDO-76 plan rev 2 — owner-gated, four-phase plan.
- Phase 1 research note A — `note-a-pixel-agent-surface` document on
  the parent issue.
- Archived pixel-agent authority —
  `HuiDots/Shared/huidots-owner-console/docs/PIXEL_COMPANY_VISUAL_AUTHORITY.md`,
  `…/DESIGN.md`, `…/src/huidots_owner_console/pixel_projection.py`.
- Live Paperclip plugin SDK —
  `HuiDots/Shared/paperclip-pi-local-backport/packages/plugins/sdk/`.
- Live Paperclip UI tokens — `HuiDots/Shared/paperclip-pi-local-backport/ui/src/index.css`,
  `pnpm check:token-gates`.
