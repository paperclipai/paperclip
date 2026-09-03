# html-report design tokens

The single source of truth for how an html-report looks lives in
`templates/base.html`, inside the `:root` block of the inline `<style>`.
This document explains each token and **why it is locked in v1**.

Do not override these via `style=` attributes in block content — the
validator will reject such attempts with `E301`. If a palette change is
ever needed, it happens here, not in agent output.

## Palette (slate + teal, light print-friendly)

| Token           | Value     | Used for                                         |
|-----------------|-----------|--------------------------------------------------|
| `--bg`          | `#fbfaf7` | Page background — warm off-white, easier on eyes than pure white, prints clean |
| `--surface`     | `#ffffff` | Cards / details / summary box                    |
| `--surface-elev`| `#f7f6f1` | Opened details background                        |
| `--ink`         | `#1f2937` | Primary text — dark slate, high contrast without being harsh black |
| `--muted`       | `#64748b` | Secondary text, captions, metadata, TOC          |
| `--border`      | `#e5e7eb` | Hairlines, table rules, section dividers         |
| `--accent`      | `#0f766e` | Links, h1 eyebrow, info callouts, blockquote rule |
| `--accent-soft` | `#ccfbf1` | Info callout background                          |
| `--good`        | `#15803d` | Positive callout accent                          |
| `--good-soft`   | `#dcfce7` | Positive callout background                      |
| `--warn`        | `#b45309` | Warning callout accent                           |
| `--warn-soft`   | `#fef3c7` | Warning callout background                       |
| `--bad`         | `#b91c1c` | Error callout accent                             |
| `--bad-soft`    | `#fee2e2` | Error callout background                         |
| `--code-bg`     | `#f1f5f4` | `<pre>` / `<code>` background                    |

### Why slate + teal

- **Neutral enough for any domain** — biomed research, infra postmortem,
  sales dashboard, financial brief. No cultural or product-category bias.
- **Prints cleanly** — no gradients, no semi-transparent backdrops, no
  dark-mode ambiguity.
- **Restrained accent** — a single teal anchors the document. More than one
  accent color is "AI-aesthetic" territory and looks amateurish.
- **Cyrillic-safe** — system font stack fallbacks cover both Latin and
  Cyrillic letterforms consistently across macOS/Windows/Linux clients.

## Typography

| Token          | Stack                                                          | Used for                  |
|----------------|----------------------------------------------------------------|---------------------------|
| `--font-sans`  | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif` | Body text, callouts, nav |
| `--font-serif` | `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", Times, serif` | Headings h1–h6           |
| `--font-mono`  | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | `<code>`, `<pre>`        |

### Why system fonts only

- **Zero external requests.** No Google Fonts, no Adobe Typekit, no preconnect
  hints. Reports open on air-gapped machines and locked-down corporate
  networks.
- **Instant first paint.** System fonts are already resident in memory.
- **Cyrillic coverage.** Segoe UI (Windows), SF/Apple system fonts (macOS),
  Roboto (Android/Chrome), Noto Sans / Liberation Sans (Linux) all ship with
  Cyrillic glyphs. No "tofu" boxes.
- **No licensing ambiguity.** Reports can be archived and distributed without
  tracking font licences.

## Layout

| Property           | Value       | Rationale                                        |
|--------------------|-------------|--------------------------------------------------|
| `max-width`        | `820px`     | Classic reading-width for ~75-character lines; still big enough for tables and figures |
| Horizontal padding | `28px`      | Breathing room without eating into the column    |
| `--radius`         | `8px`       | Single corner radius — more would be decorative  |
| `--shadow`         | 2-stop soft | Hint of depth on the summary card, invisible on print |

No sticky sidebar, no two-column layouts. Single linear column because:

1. `Print → Save as PDF` from any browser produces a clean A4/Letter result
   out of the box.
2. Mobile renders it without media queries.
3. Readers don't have to scan a navigation that isn't really useful in a
   one-shot document.

## Print rules

`@media print` rules in `templates/base.html`:

- Body background removed, text forced to pure black.
- Container paddings collapsed so browser margins take over.
- Links get `a::after { content: " (" attr(href) ")" }` — only for external
  links; anchor links (`href^="#"`) stay clean.
- `page-break-inside: avoid` on `figure`, `table`, `.callout`, `pre`,
  `blockquote`, `h2`, `h3` — stops a heading orphaning itself at the bottom
  of a page.
- `details:not([open])` content is forced visible so nothing is hidden in a
  printed PDF.
- Summary card loses its elevation shadow and becomes a plain outlined box.
- `@page { margin: 18mm 16mm }` — safe A4 margins; browsers override with
  their own for US Letter if the user prints that way.

## If something genuinely does not look right

Do not patch it with `style=` in block content. Do not add another
CSS variable from the agent side. Instead:

1. File the feedback with a concrete reproducer (minimal JSON + what looked
   wrong + which browser).
2. A human editor updates `templates/base.html`.
3. Smoke tests (`examples/minimal.json`, `examples/rich.json`) are re-run.
4. The change ships.

The whole point of locking design tokens is that reports from six months ago
look identical to reports from tomorrow. Do not break that invariant.
