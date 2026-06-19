---
name: wireframe
description: Produce low-fidelity black-and-white UI wireframes as standalone SVG files, optionally bundled into a single-page HTML viewer and published via the here-now skill. Use when the user asks to "wireframe X", "sketch a screen for", "draft a layout", "low-fi mockup", "rough mock", "make a page to view the wireframes", "build a viewer for these screens", or to "deploy / publish / host the wireframes". Do NOT use when the user wants production UI code, branded designs, hi-fi mockups, or animated/interactive prototypes — use frontend-design or similar instead.
key: paperclipai/bundled/product/wireframe
recommendedForRoles:
  - designer
  - product
  - engineer
tags:
  - design
  - wireframe
  - ux
  - prototyping
  - svg
---

# Wireframe

Produce low-fidelity, black-and-white UI wireframes as **standalone SVG files**. The goal is to communicate **structure** — what goes where, in what order, at roughly what size — without committing to colour, brand, or polish.

## When to use

Trigger on phrases like:

- "wireframe a [screen / page / flow] for X"
- "low-fi / lo-fi mockup of X"
- "draft a layout for X"
- "rough sketch of the [dashboard / settings / login / ...] page"
- "show me how X would lay out before I build it"

Skip and defer to `frontend-design` (or similar) when the request mentions: brand, polish, real components, "production-ready", colour palettes, hi-fi, Figma export, or actual code/HTML/React deliverables.

## House style — non-negotiable

Wireframes are diagnostic, not decorative. Lock these tokens on every output:

| Token            | Value                                             | Notes                                  |
| ---------------- | ------------------------------------------------- | -------------------------------------- |
| Stroke           | `#000` width `1.5`                                | All borders, dividers, outlines        |
| Fill (boxes)     | `#fff`                                            | Default for cards/containers           |
| Placeholder fill | `#e6e6e6`                                         | Image/avatar/empty-state regions       |
| Text colour      | `#000` for labels, `#666` for placeholder text    | No other colours                       |
| Accent           | `#d33` (dashed) — annotation layer ONLY           | Never inside real UI elements          |
| Font             | `font-family="-apple-system, system-ui, sans-serif"` | Single typeface across the whole file  |
| Type scale       | `12` caption · `14` body · `20` heading · `28` title | No other sizes                         |
| Grid             | 8px snap, 24px gutter                             | All x/y/w/h must be multiples of 8     |
| Default canvas   | `1280×800` desktop, `375×812` mobile, `768×1024` tablet | Pick one and state it in the comment   |

If you need to highlight a specific region for a callout, use the **annotation layer** (red dashed). Never colourise the wireframe itself.

## Workflow

1. **Confirm scope.** What screen(s)? Which viewport (desktop / tablet / mobile)? Single screen or multi-screen flow? If unclear, ask one question, then proceed with the most likely default.
2. **Pick a canvas** from the table above. State the viewport in your reply.
3. **Compose from primitives.** Read `references/components.md` and assemble the screen from the primitive snippets. Snap every coordinate to 8px.
4. **Write the SVG to a file.** Default path: `wireframes/<slug>.svg` in the working directory. Filename slug describes the screen (`login.svg`, `dashboard.svg`, `settings-account.svg`).
5. **Emit a textual annotation list** in your reply, mapping each numbered region in the SVG to a one-line description ("1 — primary nav, 2 — search input, 3 — list of recent items"). This makes the wireframe accessible, queryable, and reviewable in text-only channels.
6. **For multi-screen flows**, produce one SVG per screen and a summary `flow.svg` that arranges thumbnails left-to-right with arrows between them.

## Quick start — minimal SVG

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"
     font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <!-- canvas border -->
  <rect x="0" y="0" width="1280" height="800" />

  <!-- example: a button -->
  <g transform="translate(48, 48)">
    <rect width="120" height="40" rx="4" />
    <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Continue</text>
  </g>
</svg>
```

Two house-style gotchas worth memorising:

- Always set `stroke="none"` on `<text>` elements (text inherits the parent stroke and gets a halo otherwise).
- Always wrap text fill explicitly (`fill="#000"`) since the parent group fill is `#fff` for boxes.

## Primitive library

The full set of reusable primitives lives in `references/components.md`. Load it whenever you need a primitive whose exact markup you do not have in working memory. Do not re-derive primitives from scratch — copy the snippet and adjust coordinates.

Primitives provided:

- **Inputs:** button (filled, outlined, icon), text input, textarea, dropdown, checkbox, radio, toggle, search input
- **Layout:** card, section divider, sidebar, two-column, three-column
- **Navigation:** navbar, tab bar, breadcrumb, pagination, sidebar nav
- **Content:** heading, paragraph block, list row, table, key-value pair, metric tile
- **Media:** image placeholder, avatar (circle/square), video placeholder
- **Overlay:** modal, drawer, toast, tooltip, dropdown menu (open state)
- **Annotation:** numbered callout, dashed region highlight, arrow connector

## Grid, palette, and type scale

For exact pixel values, palette tokens, and type sizes, see `references/grid-system.md`.

## Worked examples

`references/examples.md` contains four complete wireframes you can copy and adapt:

1. Login screen (mobile, 375×812)
2. Admin dashboard (desktop, 1280×800)
3. Settings page with form (desktop, 1280×800)
4. Modal confirmation overlay (desktop, 1280×800)

When the user's request is close to one of these, start from the example and modify, rather than building from blank.

## Output convention

Every wireframe response should include:

1. The SVG file written to disk (path stated explicitly).
2. The SVG inlined in your reply (so it renders in markdown previews).
3. A short numbered annotation list mapping regions to intent.
4. Any explicit assumption you made (viewport, signed-in state, empty/populated, dark/light not applicable since monochrome).

## If the user requests a website / viewer page

Trigger on phrases like "make a page that shows the screens", "single page I can scroll", "build a viewer", "let me click through the wireframes", "show them all on one page", or any request to bundle multiple wireframes into a browsable artifact (not a production site).

Build **one static `index.html`** that loads the SVG wireframes directly. Do not turn this into a React app or component library — it's a review surface, not product UI.

**File layout** (default):

```
design/<task-slug>/
  index.html
  wireframes/    # the SVGs from this skill
  screenshots/   # any reference screenshots
```

**Page anatomy** (start from `assets/site-template.html` and adjust — do not re-derive the CSS):

- **Sticky sidebar TOC** (240px on desktop) listing every screen with anchor links. Group by Flow / Screens / Open questions.
- **Hero header** at the top: crumb (issue id), title, one-paragraph summary, pill row of meta tags (`12 screens`, `Lo-fi · monochrome`, `Click any wireframe to zoom`).
- **One section per screen** with a 2-column grid: wireframe on the left, reference image + numbered annotations + a "Why this changes" callout on the right. The wireframe `<img>` points to the SVG file directly — do not inline it.
- **Click-to-zoom lightbox** for any element marked `[data-zoom]`. Esc and backdrop click both close.
- **Flow diagram** section near the top that loads `wireframes/flow.svg` full-width.
- **Open questions** section at the bottom for unresolved decisions.

**House style for the viewer** (matches the wireframes themselves):

- Palette: `--bg: #fafaf8`, `--panel: #fff`, `--ink: #111`, `--muted: #666`, `--line: #e5e5e0`, `--accent: #d33` (red dashed callouts only).
- System font stack only: `-apple-system, system-ui, "Segoe UI", sans-serif`. No web fonts.
- 8px-based spacing, `border-radius: 8px` on cards, 1px `--line` borders, no shadows except the hover lift on `.wire`.
- The viewer chrome is allowed to be slightly more polished than the wireframes (subtle hover, rounded cards) — but never colourful. The wireframes themselves stay strictly monochrome.

**Responsive** (verify before reporting done):

- ≥980px: two-column grid, sidebar TOC visible.
- 900–980px: grid stacks to one column, TOC still sidebar.
- <900px (tablet/phone): TOC collapses to a sticky `<details>` disclosure at the top of the page, defaults closed; tapping a link auto-closes it. Sections get `scroll-margin-top: 80px` so anchor jumps clear the sticky bar.
- <560px (phone): tighter type/spacing scale, hero shrinks, lightbox switches from flex-centered to block layout at full viewport width with `touch-action: pinch-zoom` so users can pinch in further.

**Verification** before handing off: open the file in a browser and walk it at 1440×900, 768×1024, and 390×844. Confirm anchor jumps land cleanly, lightbox opens/closes, and SVGs render at the right aspect.

## If the user asks to deploy / publish / host the wireframes

Defer to the **`here-now` skill** — it owns publishing, anonymous vs. permanent sites, claim tokens, and credentials. Do not roll your own hosting.

Load the `here-now` skill and follow its `publish.sh` recipe. The shape is:

```bash
cd design/<task-slug>
{path-to-here-now}/scripts/publish.sh .
# → https://{adjective-noun-suffix}.here.now/
```

If `here-now` isn't installed for the current agent, install it (`npx skills add heredotnow/skill --skill here-now -g`) or escalate to whoever owns the agent's skill set. Do not roll your own hosting.

Things to remember when invoking it:

- Publish the **directory containing `index.html` at its root**, not the parent. `index.html` must be at the root of the published tree.
- Without saved credentials the site is **anonymous and expires in 24 hours**. With a saved API key, it's permanent. If the user wants a permanent URL, follow the `here-now` skill's sign-in-code flow — don't fake your way around it.
- For an update, pass `--slug {existing-slug}` so the URL stays stable across review rounds (the script auto-loads the claim token from `.herenow/state.json`).
- Read `publish_result.*` lines from script stderr to determine `auth_mode` and the claim URL — do not read `.herenow/state.json` and present its contents as the source of truth.
- Always share the `siteUrl` from the current run; if anonymous, also share the claim URL and the 24h expiry warning.

## What this skill is NOT for

- **Production UI code** — use `frontend-design` or write React/HTML directly.
- **Hi-fi or branded mockups** — use Figma or a design tool, not this.
- **Interactive prototypes** — SVG is static; export multi-screen flows as a flow.svg.
- **Diagrams of system architecture, sequence flows, or data models** — use mermaid or plantuml.
- **Illustrations or art** — use `example-skills:canvas-design` or `algorithmic-art`.

## Bundled assets

- `assets/template.svg` — blank desktop canvas with hidden 8px-grid guides; copy as a starting point.
- `assets/template-mobile.svg` — same for 375×812 mobile.
- `assets/site-template.html` — minimal review-viewer page (sticky TOC + responsive collapse + lightbox). Copy to `design/<task-slug>/index.html` and fill in the sections when the user requests a website.
