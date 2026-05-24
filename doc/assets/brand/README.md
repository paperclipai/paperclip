# ValAdrien.DEV — Brand assets (staging)

Hand-coded SVG approximations of the ValAdrien mark for use in the `ValAdrien OS` repository. Pure vector, no raster dependency.

## Files

| File | Use |
|---|---|
| `valadrien-mark-dark.svg` | Mark-only, white on black. README banner on GitHub dark theme, social cards. |
| `valadrien-mark-light.svg` | Mark-only, black on white. README banner on GitHub light theme, print. |
| `valadrien-wordmark-dark.svg` | Mark + `ValAdrien.DEV` caption, dark variant. Site headers, slide decks. |
| `valadrien-wordmark-light.svg` | Mark + `ValAdrien.DEV` caption, light variant. Light backgrounds. |

## Color tokens

| Token | Hex | Use |
|---|---|---|
| `--va-ink-dark` | `#000000` | Dark backgrounds, marks on light bg |
| `--va-ink-light` | `#ffffff` | Light backgrounds, marks on dark bg |
| `--va-dev-accent` | `#00FF41` | `.DEV` accent on dark backgrounds (terminal phosphor green) |
| `--va-dev-accent-aa` | `#089E37` | `.DEV` accent on light backgrounds (passes WCAG AA on white) |

> Pure `#00FF41` on `#ffffff` fails accessibility contrast. The light wordmark uses `#089E37` (~4.6:1 on white) so the `.DEV` accent stays legible without losing the dev-green semantics. Both variants are easy to swap globally — search/replace the hex.

## Alternate dev-industry accent colors

Drop-in replacements if `#00FF41` reads too retro:

- **GitHub-graph green** `#39D353` — modern, friendly, GH-coded
- **Tailwind emerald-500** `#10B981` — modern SaaS / Linear-coded
- **VS Code blue** `#007ACC` — IDE-coded, more corporate
- **Anthropic warm coral** `#E08560` — warmer, agentic-AI-coded

## Source of truth

These are hand-coded approximations of the supplied raster reference. For pixel-perfect fidelity, replace with exports from the original vector source (Figma / Illustrator). Geometry summary:

- viewBox: `1024 × 600` (mark) or `1024 × 760` (wordmark)
- Mark: thick angular A with 78px stroke, apex at `(512, 80)`, base from `(240, 540)` to `(784, 540)`, crossbar at `y=380`
- Glitch particles: 22 hand-placed rects clustered left of x=224
- Brackets: `</>` in `ui-monospace`, 76px, sitting in the A's lower-right negative space
- Caption font: `Inter` / system-ui, 800 weight, 84px, letter-spacing 2

## Brand hierarchy

- **ValAdrien.DEV** = parent entity / org. Use the wordmark in footers, "by ValAdrien.DEV" attributions, legal/copyright contexts.
- **ValAdrien OS** = the product (this repo). Use the mark + "ValAdrien OS" wordtype in product surfaces.
