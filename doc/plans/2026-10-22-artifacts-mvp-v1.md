# Artifacts MVP V1 — shipping the lab's direction into the product

Date: 2026-10-22. Status: all four slices on `claude/artifacts-mvp-v1` (draft PR #17228); a browser pass on live data is the remaining check before the PR leaves draft.

## Role of this document

The artifact directions lab (`ui/src/artifact-directions`, merged in #17213) settled a
presentation for artifacts on three surfaces: the Artifacts page, the right panel's
Artifacts tab and the task thread. The lab draws it from fixtures on static mocks of the
chrome. This plan turns that reference into product code, one surface at a time, behind an
experimental setting, without changing the artifact data model where the lab's numbers do
not need it.

The lab stays the visual reference: every measurement below is the one the lab verified
against the PCLP-Core mocks (node 2129:133457, 2096:87691, 2096:86523, 2205:138266).

## Locked decisions

1. **Gated by `/instance/settings > Experimental > Artifacts V1`** (`enableArtifactsV1`,
   default off), the same plumbing as `enableCombinedInboxTasks`: shared type, validator,
   feature catalog, server defaults, managed-key list, UI hook, settings toggle. The old
   presentation stays the fallback until the setting is removed in a later cleanup.
2. **Token-only.** Every colour, radius, shadow, size and font value the lab kept in its
   scoped `tokens.css` becomes an `--artifact-*` token in `ui/src/index.css`, with the light
   theme's values as overrides, so the token gates pass and the theme editor can reach them.
   Artwork geometry (sheet 180×216, glyph at (58, 58), bars on a 26px pitch, stack centres)
   lives in one constants module, not in class names.
3. **Reuse the lab's code, not its types.** The primitives move to
   `ui/src/components/artifacts/v1/` and take `CompanyArtifact`, `IssueWorkProduct`,
   issue documents and attachments through small adapters, the way the lab's Today kit
   adapted the other direction. The lab keeps its own copies; it is a reference, not a
   dependency of product code.
4. **No new API fields for the first three slices.** The Artifacts page tiles show title,
   identifier, count and "Updated …"; the panel and thread rows get sizes from the issue
   work-product and attachment payloads they already have. A picture's aspect ratio comes
   from the loaded image (`naturalWidth / naturalHeight`), 4:3 until it loads.
5. **Reduced motion is respected**: the hover movement (page turn, 6px rise) applies only
   under `prefers-reduced-motion: no-preference`; colour fades stay.

## Slices

### Slice 1 — foundation (done)

- Experimental setting `enableArtifactsV1` end to end, with `useArtifactsV1Enabled()`.
- `--artifact-*` tokens in `index.css` (paper, ink, faint ink, sheet and print radii, sheet
  and print shadows with light overrides, grid column minimum, frame and tile heights, tile
  hover fill and radius, row fill, hover, radius and gap, play scrim, hover easing).
- Primitives under `ui/src/components/artifacts/v1/`: kind helpers (`treatmentOf`,
  `labelOf`, `glyphOf`, `mediaKindOf`), `ArtifactSheet` (preview and icon faces),
  `ArtifactPrint` (bordered picture, fitted to a box, play disc for video),
  `ArtifactStack` (the two backings), `ArtifactFront`, `ArtifactTile` (stack and single
  tiles with the caption and the Paper Mono pill), `ArtifactRow` (the 40px-icon row),
  date helpers, and the hover rules. Unit tests ported from the lab.
- Nothing mounted yet. Storybook stories under `documents-artifacts/` show the primitives on
  fixtures so reviewers can see them without the flag.

### Slice 2 — Artifacts page (done)

- With the flag on, `Artifacts.tsx` renders the V1 tiles: stacks when grouped by task
  (the default), single tiles otherwise, 28px gaps, 370px cells, hover fill with the
  12px radius.
- Filters become Tasks (default; grouped by task) · All files · Images · Videos ·
  Documents · Text · Files. The group-by menu and search stay.
- Opened stack: the `← All stacks / ACM-3 Title` row above the single tiles.
- Page tests updated for both flag states.

### Slice 3 — right panel Artifacts tab (done)

What the shipped tab does that the V1 rows must keep (read 2026-10-22,
`IssuePropertiesArtifactsTab.tsx`):

- Three sources merged: work products (`useIssueWorkProducts`), task documents
  (`useIssueDocuments`, minus `artifact-review-*` proxies) and attachments not
  already promoted to work products (`selectArtifactAttachments`).
- Rows are grouped by run with an agent-name header and a time; V1 flattens to
  one list, newest first (the lab's decision), and drops the headers.
- A Markdown work product expands in place into the document review surface
  (`MarkdownWorkProductRow`, backed by the `artifact-review-<id>` document) with
  raw open and download as secondary actions; a task document expands in place
  (`DocumentRow`) or opens in its own pane tab when `onOpenDocument` is given;
  a text attachment opens in a text tab (`openTextAttachment`), other files in a
  new tab; `documentDeepLink` expands or opens the requested document; the
  upload area (`ArtifactUploadContent`) wraps the list.
- Work products carry a status badge (`workProductStatusBadge`: in progress,
  for review, done, changes requested, failed).

Approach: the V1 row is the *face* of each item. Give `DocumentRow` and
`MarkdownWorkProductRow` a `face` render prop so, with the flag on, their
header is the V1 row (name over size · date, status badge and the open /
download controls in the row's trailing slot) while their expansion, deep-link
and review behaviour stay untouched; attachments and other work products render
the V1 row directly with the same destinations the shipped cards use.

- `IssuePropertiesArtifactsTab` renders the V1 row list when the flag is on: newest first,
  12px apart, 40px document icon or thumbnail with a play disc, name truncating before its
  extension over "size · date" with the panel's date form (Today / Yesterday / 2D ago /
  July 23). Existing actions (open, download, review) move into the row's menu.

### Slice 4 — task thread (done)

- Work products and documents between turns render as one full-width row 12px under the
  "Worked" row (`TaskChatProtocolCard.tsx`, `ResourceCard`): a registered file is named after
  the file with the deliverable's state beside it; a document after its key; the destination
  is the card's. A message's files render as the same rows inline under the footer, 12px
  below it, 8px apart at equal widths, wrapping past three (280px minimum), in place of the
  media grid and file chips (`TaskChatBubble.tsx`): pictures and video open the task's
  gallery, text opens a text tab when the panel offers one, anything else a new tab.
- Not carried over: the "Images · N / Files · N" labels and the four-up image grid; the
  rows name every file instead.

### Later

- Remove the flag and the old cards once the three surfaces have been in use.
- The lab's parked surfaces (media preview overlay, panel closeup) follow the same path if
  adopted.

## Verification per slice

Done (slices 1–4): `cd ui && pnpm typecheck` (catalog check and `tsc -b`, clean apart from
the five pre-existing `PluginOrganizationSwitcher` errors), `pnpm check:token-gates`,
`node scripts/check-maps.mjs`, and the Vitest suites for `components/artifacts/v1`, the
Artifacts page, the panel's Artifacts tab, the task-chat bubble and protocol card (each in
both flag states), the hook, the experimental settings page, the shared feature catalog and
the server instance settings. Not yet done: a browser pass with the flag on against a dev
instance with real artifacts on all three surfaces; the artwork was measured in the lab and
the wiring is covered by tests.

- `cd ui && pnpm typecheck` (catalog check and `tsc -b`), `pnpm check:token-gates`,
  `npx vitest run src/components/artifacts/v1` plus the touched pages' tests.
- A Playwright pass on the dev instance with the flag on, measuring what the lab measured:
  58px rows, 8px/12px gaps, 370px cells, 5° turn and 6px rise, Paper Mono pills.
- Storybook stories for the primitives, catalogued under `documents-artifacts`.

## Risks

- The Artifacts page tests and the task-chat tests assert the current markup; the flag keeps
  the default path unchanged, and the V1 path gets its own tests.
- Pictures without known dimensions render at 4:3 until they load; the fitted print then
  resizes once. The stack frame's height is fixed, so nothing below it moves.
- Token count grows by about thirty `--artifact-*` entries; they are namespaced and
  documented in the token block.
