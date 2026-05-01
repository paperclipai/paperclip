# Paperclip Design System

## Direction: Precision & Density

**Feel:** A control plane for AI agents and the humans who govern them. Calm, unornamented, monochrome by default — operators read this UI all day and make consequential decisions (approvals, budgets, agent hires, delegation). Density and legibility beat decoration. The product is the *signal*, not the chrome.

**Signature:** Sidebar-anchored dashboard with information-dense cards (activity, approvals, agents, budgets) and clear status colors only where action is required. Sharp corners on large surfaces, soft corners on small controls — a deliberate dev-tool aesthetic, not a consumer app.

**Why not "Sophistication & Trust" or "Warmth":** Paperclip's user is a builder/operator running a fleet of agents — they want a Bloomberg terminal, not a boardroom or a friend. Sophistication reads slow; warmth reads marketing. Precision/Density signals: *we will not waste your screen real estate or your attention*.

---

## Foundation

The system is implemented in `ui/src/index.css` as Tailwind v4 `@theme` tokens with shadcn/ui (new-york style, neutral base) on top. **Always extend tokens via CSS variables in `index.css` — never hardcode hex values in components.** All colors are OKLCH for perceptual uniformity in dark mode.

- **Tailwind:** v4 with `@theme inline` token mapping
- **Component library:** shadcn/ui new-york + Radix/Base UI primitives
- **Icon library:** lucide-react (16px default in buttons, 20px standalone)
- **Theme modes:** light + dark, switched via `.dark` class on root; `color-scheme` is set so native form controls and scrollbars follow

---

## Color Palette (OKLCH)

Paperclip is intentionally **monochrome with semantic accents**. Color carries meaning — never decoration.

### Neutral surfaces (light mode)
| Token | OKLCH | Use |
|-------|-------|-----|
| `--background` | `oklch(1 0 0)` | App canvas |
| `--foreground` | `oklch(0.145 0 0)` | Primary text |
| `--card` / `--popover` | `oklch(1 0 0)` | Card and popover surfaces |
| `--muted` / `--secondary` / `--accent` | `oklch(0.97 0 0)` | Subtle fills, hovers |
| `--muted-foreground` | `oklch(0.556 0 0)` | Secondary text, captions |
| `--border` / `--input` | `oklch(0.922 0 0)` | Hairlines, separators |
| `--ring` | `oklch(0.708 0 0)` | Focus ring |
| `--primary` | `oklch(0.205 0 0)` | Primary action (near-black) |

### Neutral surfaces (dark mode)
| Token | OKLCH | Use |
|-------|-------|-----|
| `--background` | `oklch(0.145 0 0)` | App canvas |
| `--foreground` | `oklch(0.985 0 0)` | Primary text |
| `--card` / `--popover` | `oklch(0.205 0 0)` | Elevated surfaces |
| `--muted` / `--secondary` / `--accent` | `oklch(0.269 0 0)` | Subtle fills |
| `--muted-foreground` | `oklch(0.708 0 0)` | Secondary text |
| `--border` / `--input` | `oklch(0.269 0 0)` | Hairlines |

### Semantic
| Token | Meaning |
|-------|---------|
| `--destructive` | Errors, destructive actions, budget incidents |
| `--chart-1..5` | Activity charts (variants by mode) |

**Status colors live in component-local Tailwind utilities** (e.g., `text-amber-600` for warnings, `text-emerald-600` for success) — keep them off the global token list to avoid theme drift. Use sparingly; the dashboard should read mostly grayscale.

### Sidebar
Sidebar has its own paired tokens (`--sidebar`, `--sidebar-foreground`, `--sidebar-border`, etc.). It is one notch lighter than the canvas in dark mode and identical to canvas in light. Treat it as a distinct surface — never apply card styles inside it.

---

## Typography

### Font Stack
- **Sans (default):** system stack via Tailwind defaults (`ui-sans-serif, system-ui, sans-serif`)
- **Mono:** system stack (`ui-monospace, SFMono-Regular, …`) — used for IDs, JSON payloads, code in approvals
- **Editor:** MDXEditor inherits via `font-family: inherit` override on `.paperclip-mdxeditor`

### Scale (Tailwind utilities — no custom sizes)
| Class | Size / line-height | Use |
|-------|-------------------|-----|
| `text-2xl` | 24px / 32px | Page titles |
| `text-xl` | 20px / 28px | Section headings |
| `text-lg` | 18px / 28px | Card titles, modal titles |
| `text-base` | 16px / 24px | Long-form content (descriptions) |
| `text-sm` | 14px / 20px | **Default UI text** (buttons, table rows, menu items) |
| `text-xs` | 12px / 16px | Metadata, badges, breadcrumbs, captions |
| `text-[11px]` | 11px / 14px | Reserved for status pills only |

### Weight
- `font-medium` (500) for buttons, labels, interactive text
- `font-semibold` (600) for card titles and section headings
- `font-bold` (700) reserved for page titles and hero stats
- Default body weight is 400; never use weights below 400

### Headings
- `h1, h2, h3` use `text-wrap: balance` globally
- Avoid `<h1>` inside cards — page-level only

---

## Spacing & Density

### Base unit: 4px (Tailwind default)

| Use | Token |
|-----|-------|
| Inline icon-to-text gap | `gap-1.5` (6px) or `gap-2` (8px) |
| Card padding | `p-6` (24px) — see `<Card>` component |
| Card content vertical rhythm | `gap-6` (24px) between sections, `gap-2` (8px) within header |
| Page padding | `px-4 py-6` mobile, `px-6 py-8` desktop |
| Form field stack | `gap-2` (8px) label → input, `gap-4` (16px) between fields |
| Table row | `py-2.5` (10px) for compact, `py-3` (12px) for default |
| Sidebar nav item | `px-3 py-2` (12 × 8px) |

**Density principle:** Default to dense. Operators sweeping a queue need to see more, not less. If a row exceeds 56px, justify it.

---

## Border Radius

The system intentionally splits radius by surface size:

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 6px (`0.375rem`) | Badges, small chips, icon buttons |
| `--radius-md` | 8px (`0.5rem`) | Buttons, inputs, dropdown items |
| `--radius-lg` | **0px** | Cards, panels, sidebars |
| `--radius-xl` | **0px** | Modals, sheets |

**Rationale:** Sharp large surfaces (cards, panels, modals) read as a tool/grid; soft small controls (buttons, inputs, chips) stay tactile. Never round a card.

---

## Depth Strategy: Borders First, Shadows for Float

| Level | Treatment | Use |
|-------|-----------|-----|
| L0 | none | App canvas |
| L1 | `1px solid var(--border)` | Cards, panels, separators (default) |
| L1 + `shadow-sm` | hairline + 1px ambient | Cards as defined in `<Card>` — sits flat but reads detached |
| L2 | `shadow-md` | Dropdowns, popovers, command palette |
| L3 | `shadow-lg` + scrim | Modals, sheets, dialogs |

**Rules:**
- A shadow without a border is informational ("I float"), never decorative.
- Never combine shadow + colored border on the same surface.
- Dark mode: shadows are subtle (`shadow-sm` is enough); rely on border + surface contrast.

---

## Component Specifications

### Button (`ui/src/components/ui/button.tsx`)
Source of truth. Match these heights when authoring custom interactive elements.

| Size | Height | Padding | Text | Icon | Use |
|------|--------|---------|------|------|-----|
| `xs` | 24px | 8px | 12px / 500 | 12px | Inline row actions |
| `sm` | 36px | 12px | 14px / 500 | 16px | Toolbar, dense forms |
| `default` | 40px | 16px / 8px | 14px / 500 | 16px | Standard CTA |
| `lg` | 40px | 24px | 14px / 500 | 16px | Page-level primary |
| `icon` | 40 × 40px | — | — | 16px | Standalone icon |
| `icon-xs` | 24 × 24px | — | — | 12px | Inline |
| `icon-sm` | 36 × 36px | — | — | 16px | Toolbar |

Variants: `default` (primary), `destructive`, `outline`, `secondary`, `ghost`, `link`. Only one `default` (primary) per visible region — the rest are `outline`/`ghost`.

### Card (`ui/src/components/ui/card.tsx`)
- `flex flex-col gap-6 border py-6 shadow-sm` (no radius — sharp)
- `CardHeader` uses CSS grid; opt into a 2-column layout by including a `<CardAction>` child
- `CardContent` is `px-6`; `CardHeader` and `CardFooter` are `px-6`
- Never add internal shadows to a card — depth is the card itself

### Input / Form Controls
- 36px height for `sm`, 40px for `default`
- 1px border on idle, ring on focus (`focus-visible:ring-ring/50 ring-[3px]`)
- Error state: `aria-invalid="true"` triggers `border-destructive` + destructive ring
- Labels above inputs, never inline (except checkbox/switch)

### Badge / Status Pill
- 22px height, `--radius-sm` (6px), `text-xs` / 500
- Variants: neutral (default), success, warning, destructive
- Dot prefix optional — use for live status only (running, healthy, failing)

### Sidebar
- Fixed left, ~240px expanded / 56px collapsed
- Active item: muted background + `font-medium`, no left border
- Section labels: `text-xs uppercase tracking-wide text-muted-foreground`, `px-3`
- Group separators: `<Separator>` with 16px vertical margin

### Command Palette (`ui/src/components/CommandPalette.tsx`)
- Triggered by `⌘K`
- Modal centered, max-width 640px, sharp corners, L3 shadow
- Item rows: 40px, `text-sm`, kbd shortcut right-aligned in `text-xs text-muted-foreground`

### Tables / Lists
- Prefer `<div>` grids over `<table>` unless data is truly tabular
- Row height: 48px default, 40px compact
- Hairline `border-b` between rows; no zebra striping
- Hover: `bg-accent` (very subtle)

---

## Responsive Rules

Paperclip is **desktop-first** but every page must remain functional at 375px width.

| Breakpoint | Behavior |
|------------|----------|
| `< 640px` (mobile) | Sidebar collapses to drawer (`<Sheet>`); cards stack 1-col; tables → list rows; min target size 44px |
| `640–1024px` (tablet) | Sidebar collapsed by default; cards 1–2 col |
| `1024–1440px` (laptop) | Sidebar expanded; cards 2–3 col grids; default density |
| `> 1440px` (desktop) | Sidebar expanded; cards 3–4 col grids; max content width 1440px (no edge-to-edge dashboards beyond this) |

**Coarse pointer override (`@media (pointer: coarse)`):** All interactive elements get `min-height: 44px` automatically via `index.css` base layer. Do not override unless the element is decorative.

**Overflow rules:**
- Body has `overflow: hidden` — page-level scroll is owned by the main column, not `<html>`
- Long lists must use `<ScrollArea>` (custom scrollbar) or the auto-hide scrollbar utility (`scrollbar-auto-hide`)

---

## Motion

Motion is informational. If an animation does not answer "what just changed?" — cut it.

| Token | Duration | Easing | Use |
|-------|----------|--------|-----|
| instant | 80ms | `ease-out` | Hover/press, focus ring |
| fast | 140ms | `ease-out` | Menu reveal, tooltip, badge swap |
| base | 220ms | `cubic-bezier(0.2, 0, 0, 1)` | Sheet/drawer/modal open, sidebar collapse |
| emphasis | 320ms | `cubic-bezier(0.32, 0.72, 0, 1)` | Multi-element coordinated transitions (rare) |

**Rules:**
- `transition-[color,background-color,border-color,box-shadow,opacity]` — never `transition-all`
- Respect `prefers-reduced-motion` — collapse non-essential motion to 0ms
- No bounce, no parallax, no scroll-jacking
- Streaming agent output uses a 1px caret, no spinners

---

## Component Posture (global rules)

1. **Monochrome by default.** Color appears when status changes (red for budget incident, amber for approval needed, green for healthy). Decorative color is forbidden.
2. **Border, not glow.** Use `border` + `shadow-sm` for elevation. Never `ring` for static elevation.
3. **One primary per region.** Every other action is `outline` or `ghost`.
4. **Sentence case.** Buttons, labels, headings — sentence case. No ALL CAPS, no Title Case Headlines.
5. **No emoji in chrome.** Emoji only appears in user-authored content (comments, agent output).
6. **Show data, not loading.** Use skeletons (`<Skeleton>`) shaped like the data, not spinners. Spinners are for first paint only.
7. **Dark mode is first-class.** Every component must be tested in both modes; rely on tokens, not hardcoded colors.
8. **Keyboard-first.** `⌘K` opens command palette, `Esc` closes overlays, `/` focuses primary search. New flows must define their keyboard map.

---

## Audit Expectations

Before any frontend PR ships, the engineer should self-check (and the CDO will spot-check) against:

- [ ] **Tokens, not hex.** No hardcoded colors outside `index.css` — search the diff for `#` and `oklch(`.
- [ ] **Radius discipline.** Cards/panels/modals are sharp (radius 0). Buttons/inputs/badges use `rounded-md` or `rounded-sm`.
- [ ] **Button heights from `buttonVariants`.** No bespoke buttons with custom heights.
- [ ] **Dark mode parity.** Component renders correctly with `.dark` toggled. No hardcoded white/black.
- [ ] **Focus ring visible.** Tabbing through reaches every interactive element with a visible ring.
- [ ] **Mobile (375px) doesn't break.** Sidebar collapses, content stacks, no horizontal scroll.
- [ ] **Coarse pointer targets ≥ 44px.** Verified by base layer; do not override.
- [ ] **No `transition-all`.** Only the explicit property list.
- [ ] **Skeleton shape matches content.** No generic full-width gray bars.
- [ ] **Sentence case copy.** Buttons, headings, labels.
- [ ] **`/audit` and `/baseline-ui review` pass with no critical/high findings.**

CDO runs `/audit` + `/baseline-ui review` on any non-trivial UI change before close-out. Findings at critical/high severity are filed as child issues assigned to CTO.

---

## Out of Scope for This System

- Marketing site (`paperclip.run` or equivalent) — separate brand surface
- CLI / TUI styling — terminal conventions apply, not this doc
- Embedded plugin UIs (e.g., third-party adapter views) — should *honor* tokens but plugins own their layout

---

## Updating This Document

This file is the persisted source of truth between agent sessions. When a design decision contradicts what's written here:

1. The CDO updates this file with the new decision and the rationale.
2. The change is committed in the same PR as the implementation that prompted it.
3. Components are updated to match — never fork the system silently.

If you find yourself reaching for a value not in this doc, that's a signal to either (a) reuse what's here or (b) propose an addition. Don't invent in-place.
