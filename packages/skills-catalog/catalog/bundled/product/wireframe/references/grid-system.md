# Grid, palette, and type scale

These are the only values you may use. Do not introduce new colours, sizes, or grid units.

## Canvas presets

| Viewport | Width × Height | Use for                       |
| -------- | -------------- | ----------------------------- |
| Desktop  | 1280 × 800     | Default for web app screens   |
| Wide     | 1440 × 900     | Marketing landing pages       |
| Tablet   | 768 × 1024     | iPad-class screens            |
| Mobile   | 375 × 812      | iPhone-class screens          |

Always include `viewBox="0 0 W H"` matching the canvas so it scales when embedded.

## Grid

- Base unit: **8px**. All `x`, `y`, `width`, `height` values must be multiples of 8.
- Outer page margin: **24px** on desktop/tablet, **16px** on mobile.
- Column gutter: **24px** desktop, **16px** mobile.
- Vertical rhythm: **24px** between sibling components.

### Desktop 12-column grid

- Total width: 1280
- Outer margin (each side): 48
- Inner content width: 1184
- Column width: 88, gutter 8 → 12 × (88 + 8) − 8 = 1144 + 40 = 1184 ✓

In practice, snap to common widths:
- Sidebar: 240
- Content max: 944 (after sidebar)
- Card grid: 3 × 384 with 24 gutters or 4 × 280 with 24 gutters
- Modal width: 480 (small), 640 (default), 800 (wide)

### Mobile single column

- Total width: 375
- Outer margin: 16 each side → content 343
- Tap targets: 44 minimum height (snap to 48)

## Palette (the only colours allowed)

| Name             | Hex        | Use                                                      |
| ---------------- | ---------- | -------------------------------------------------------- |
| Ink              | `#000`     | Strokes, primary text                                    |
| Paper            | `#fff`     | Default fill                                             |
| Mute text        | `#666`     | Placeholder text inside inputs, secondary labels         |
| Placeholder grey | `#e6e6e6`  | Image/avatar/empty-state regions                         |
| Subtle grey      | `#f4f4f4`  | Optional zebra rows in tables; nothing else              |
| Annotation red   | `#d33`     | Annotation layer ONLY — dashed borders, callout numbers  |

That's the entire palette. No hover states, no focus rings, no brand colours.

## Type scale

Single typeface: `font-family="-apple-system, system-ui, sans-serif"`.

| Role     | Size | Weight | Use                              |
| -------- | ---- | ------ | -------------------------------- |
| Caption  | 12   | 400    | Help text, metadata, table footnotes |
| Body     | 14   | 400    | Default text, button labels, list rows |
| Heading  | 20   | 600    | Section headings, card titles    |
| Title    | 28   | 700    | Page title (one per screen)      |

Font-weight is the only typographic variation allowed beyond size. No italics, no underline (except links — see below).

### Link convention

For text links, render as body 14, with `text-decoration="underline"`. No colour change.

### Strokes on text

Always set `stroke="none"` on `<text>` elements. The wireframe SVG sets a default stroke at the `<svg>` root for boxes; text inherits it as an unwanted halo unless overridden.

## Standard component sizes

These appear so often you should memorise them.

| Component         | Size (W × H) |
| ----------------- | ------------ |
| Button (default)  | 120 × 40     |
| Button (small)    | 80 × 32      |
| Button (icon)     | 40 × 40      |
| Text input        | 320 × 40     |
| Text input (full) | 100% × 40    |
| Search input      | 480 × 40     |
| Dropdown          | 200 × 40     |
| Checkbox / radio  | 20 × 20      |
| Avatar (small)    | 32 × 32 circle |
| Avatar (medium)   | 48 × 48 circle |
| Navbar            | 100% × 64    |
| Tab               | (auto) × 48  |
| List row          | 100% × 56    |
| Table row         | 100% × 48    |
| Card padding      | 24 inside    |
| Modal             | 480 / 640 / 800 wide, height auto |

## Coordinate conventions

- Place every primitive inside a `<g transform="translate(x, y)">` so its internal coordinates start at `(0, 0)`. This makes primitives copy-pastable across screens.
- Use comments above each primitive: `<!-- 1: nav -->`, `<!-- 2: search -->` matching the annotation list you write below the SVG.
- Group related primitives under a parent `<g>` with a `data-region="..."` attribute for searchability.

## Negative space

Empty space is part of the design. Do not fill the canvas. A wireframe with one card centered in the viewport is a valid wireframe if that's the screen's intent.
