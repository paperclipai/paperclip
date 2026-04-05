# HUD Command Center UI Redesign

**Date:** 2026-04-05
**Status:** Approved
**Approach:** CSS-Only Theme Overhaul (zero new dependencies, maximum performance)

## Overview

Transform the OH MY COMPANY platform from its current brutalist/monochromatic aesthetic into a futuristic **Command Center / HUD** interface. The platform manages AI agent companies — the HUD metaphor (agents as operatives, issues as missions, dashboard as mission control) is a natural fit.

## Visual Direction

- **Style:** Command Center / HUD — data-dense, military/mission-control feel
- **Palette:** Electric Blue (#00D4FF) + Dark navy-black
- **Animation:** Full Sci-Fi — scanning lines, radar sweeps, holographic shimmer, boot-up sequences, animated border traces
- **Typography:** Military Stencil headers (Orbitron), monospace data (JetBrains Mono), clean body (Inter)
- **Implementation:** Pure CSS animations only — zero JS animation runtime, GPU-composited properties, `prefers-reduced-motion` respected

## Phases

1. **Phase 1: Design System Foundation + Layout Shell** — theme variables, fonts, animations, sidebar, layout
2. **Phase 2: Dashboard** — the hero command center page
3. **Phase 3: CEO Chat** — futuristic conversational AI interface
4. **Phase 4: All Remaining Pages** — apply system everywhere

Each phase is a separate implementation cycle. This spec covers Phase 1.

---

## 1. Color Palette

All colors in OKLch (existing color space used in project).

The root element declares `color-scheme: dark` to ensure native browser elements (scrollbars, form controls, system UI) match the dark theme.

### Dark Theme (Primary — forced as default for HUD)

| Token | OKLch Value | Hex Approx | Usage |
|-------|-------------|------------|-------|
| `--background` | `oklch(0.09 0.01 240)` | #0a0e1a | Deep navy-black base |
| `--foreground` | `oklch(0.93 0.01 240)` | #e8eaf0 | Cool white text |
| `--card` | `oklch(0.12 0.015 240)` | #141929 | Panel/card backgrounds |
| `--card-foreground` | `oklch(0.93 0.01 240)` | #e8eaf0 | Card text |
| `--popover` | `oklch(0.14 0.015 240)` | #181d30 | Dropdown/popover bg |
| `--popover-foreground` | `oklch(0.93 0.01 240)` | #e8eaf0 | Popover text |
| `--primary` | `oklch(0.72 0.15 220)` | #00d4ff | Electric blue accent |
| `--primary-foreground` | `oklch(0.09 0.01 240)` | #0a0e1a | Dark text on blue |
| `--secondary` | `oklch(0.16 0.02 240)` | #1a2035 | Subtle panel fills |
| `--secondary-foreground` | `oklch(0.88 0.01 240)` | #d8dbe5 | Text on secondary |
| `--muted` | `oklch(0.18 0.015 240)` | #1e2438 | Inactive/disabled bg |
| `--muted-foreground` | `oklch(0.55 0.02 240)` | #6b7394 | Dimmed text |
| `--accent` | `oklch(0.16 0.02 240)` | #1a2035 | Hover state bg (intentionally identical to `--secondary` — shadcn expects both tokens; they serve different semantic roles but share the same value in this dark HUD palette) |
| `--accent-foreground` | `oklch(0.93 0.01 240)` | #e8eaf0 | Hover text |
| `--destructive` | `oklch(0.65 0.25 25)` | #ff4444 | Critical/error red |
| `--destructive-foreground` | `oklch(0.98 0 0)` | #fafafa | Text on destructive |
| `--border` | `oklch(0.22 0.025 240)` | #252d45 | Panel edges, grid lines |
| `--input` | `oklch(0.22 0.025 240)` | #252d45 | Input borders |
| `--ring` | `oklch(0.72 0.15 220)` | #00d4ff | Focus ring = electric blue |

### Semantic Status Colors (CSS custom properties)

| Token | OKLch Value | Usage |
|-------|-------------|-------|
| `--status-active` | `oklch(0.75 0.18 155)` | Agent running, success — green |
| `--status-warning` | `oklch(0.78 0.15 75)` | Pending, paused — amber |
| `--status-error` | `oklch(0.65 0.25 25)` | Error, critical — red |
| `--status-info` | `oklch(0.72 0.15 220)` | Info, active — electric blue |
| `--status-violet` | `oklch(0.65 0.2 290)` | AI/chat activity — violet |

### Sidebar-Specific Tokens

| Token | Value |
|-------|-------|
| `--sidebar` | `oklch(0.10 0.015 240)` |
| `--sidebar-foreground` | `oklch(0.88 0.01 240)` |
| `--sidebar-primary` | `oklch(0.72 0.15 220)` |
| `--sidebar-primary-foreground` | `oklch(0.09 0.01 240)` |
| `--sidebar-accent` | `oklch(0.14 0.02 240)` |
| `--sidebar-accent-foreground` | `oklch(0.93 0.01 240)` |
| `--sidebar-border` | `oklch(0.20 0.02 240)` |
| `--sidebar-ring` | `oklch(0.72 0.15 220)` |

### Light Theme

The HUD is dark-first. Light theme is **deferred to Phase 4** — it requires its own design pass to ensure the command center aesthetic translates without losing readability. For Phase 1-3, the app defaults to dark mode. The existing light theme CSS variables remain in place but are not updated until Phase 4.

### Chart Colors (Data Viz)

| Token | Value | Usage |
|-------|-------|-------|
| `--chart-1` | `oklch(0.72 0.15 220)` | Electric blue — primary series |
| `--chart-2` | `oklch(0.75 0.18 155)` | Green — secondary |
| `--chart-3` | `oklch(0.78 0.15 75)` | Amber — tertiary |
| `--chart-4` | `oklch(0.65 0.2 290)` | Violet — quaternary |
| `--chart-5` | `oklch(0.65 0.25 25)` | Red — quinary |

---

## 2. Typography

### Font Stack

Fonts are loaded via `<link rel="preload">` tags in `index.html` for optimal performance (avoids render-blocking `@import`):

```html
<!-- In index.html <head> -->
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"></noscript>
```

| Role | Font Family | Weights | CSS Variable |
|------|-------------|---------|--------------|
| **Display/Headers** | `'Orbitron', sans-serif` | 600, 700 | `--font-display` |
| **Monospace/Data** | `'JetBrains Mono', monospace` | 400, 500 | `--font-mono` |
| **Body** | `'Inter', system-ui, sans-serif` | 400, 500 | `--font-sans` |

### Typography Rules

- **Page titles (h1):** Orbitron 700, 18px, uppercase, `letter-spacing: 0.1em`, color: `var(--foreground)`
- **Section headers (h2):** Orbitron 600, 13px, uppercase, `letter-spacing: 0.08em`, with `// ` prefix in `var(--muted-foreground)`
- **Card titles (h3):** Orbitron 600, 12px, uppercase, `letter-spacing: 0.06em`
- **Body text:** Inter 400, 14px, `line-height: 1.6`
- **Data values:** JetBrains Mono 500, 14px, color: `var(--primary)` for key metrics
- **Labels/captions:** JetBrains Mono 400, 11px, uppercase, `letter-spacing: 0.05em`, color: `var(--muted-foreground)`
- **Status text:** JetBrains Mono 400, 11px
- **Timestamps:** JetBrains Mono 400, 10px, `var(--muted-foreground)`

---

## 3. Border Radius & Shape Language

### Radius Tokens

| Token | Value |
|-------|-------|
| `--radius` | `2px` |
| `--radius-sm` | `2px` |
| `--radius-md` | `3px` |
| `--radius-lg` | `4px` |
| `--radius-xl` | `6px` |

Sharp, tactical edges. Near-zero rounding.

### Angled Corner Cuts

Major panels and cards use CSS `clip-path` for a tactical hex-cut appearance:

```css
.hud-panel {
  clip-path: polygon(
    0 0,
    calc(100% - 12px) 0,
    100% 12px,
    100% 100%,
    12px 100%,
    0 calc(100% - 12px)
  );
}
```

Applied to: dashboard cards, detail panels, dialog containers. Not applied to small elements (buttons, badges, inputs).

**Clip-path and pseudo-element interaction:** Since `clip-path` clips all child content including `::before`/`::after`, the clip-path is applied to an **inner wrapper** (`.hud-panel-inner`) while scan-line and border-trace pseudo-elements are on the **outer container** (`.hud-panel`). This dual-element pattern ensures animations extend to the full rectangular boundary while the inner content has the tactical cut appearance.

---

## 4. CSS Animations

All animations use only `transform`, `opacity`, `filter`, or `box-shadow` — GPU-composited properties. No layout triggers.

### 4.1 Scan Line

A thin horizontal line sweeps down panels periodically. Uses `transform: translateY()` instead of `top` to stay GPU-composited.

```css
@keyframes hud-scan {
  0% { transform: translateY(0); opacity: 0; }
  5% { opacity: 1; }
  95% { opacity: 1; }
  100% { transform: translateY(calc(var(--scan-height, 300px))); opacity: 0; }
}
```

- Applied via `::after` pseudo-element on `.hud-panel`, positioned `top: 0; left: 0; right: 0; height: 1px;`
- `--scan-height` set per-panel (defaults to 300px, overridden with actual panel height via a tiny CSS custom property)
- 1px height, `var(--primary)` color, 0.15 opacity
- Duration: 8s, infinite, linear
- `will-change: transform, opacity` on the pseudo-element

### 4.2 Border Trace

Electric blue glow traces around a panel's edge on hover.

```css
@keyframes border-trace {
  0% { background-position: 0% 0%; }
  100% { background-position: 200% 0%; }
}
```

- Applied via `::before` pseudo-element with gradient border technique
- `background: linear-gradient(90deg, transparent 0%, var(--primary) 50%, transparent 100%)`
- `background-size: 200% 100%`
- Duration: 2s, infinite on hover
- Fades in on hover, fades out on leave

### 4.3 Glow Pulse

Status indicators breathe with a soft glow.

```css
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 4px var(--glow-color); }
  50% { box-shadow: 0 0 12px var(--glow-color), 0 0 24px var(--glow-color); }
}
```

- Applied to status dots, active nav items, live badges
- Duration: 2s for normal, 1.5s for error (faster = urgency)
- Color set via `--glow-color` scoped custom property

### 4.4 Data Reveal

Numbers and data cells appear with a blur-to-sharp transition.

```css
@keyframes data-reveal {
  0% { opacity: 0; filter: blur(4px); transform: translateY(4px); }
  100% { opacity: 1; filter: blur(0); transform: translateY(0); }
}
```

- Duration: 300ms, cubic-bezier(0.16, 1, 0.3, 1)
- Staggered via `animation-delay` using `nth-child()` selectors: `.data-reveal > :nth-child(1) { animation-delay: 0ms }`, `.data-reveal > :nth-child(2) { animation-delay: 50ms }`, etc. up to 10 children. For dynamic lists beyond 10 items, inline `style="animation-delay: ${index * 50}ms"` via React.
- Applied on page mount to data values, counters, table rows

### 4.5 Boot Sequence

Page entrance animation when navigating.

```css
@keyframes boot-in {
  0% { opacity: 0; transform: translateY(8px); filter: blur(2px); }
  40% { opacity: 0.7; filter: blur(0); }
  100% { opacity: 1; transform: translateY(0); }
}
```

- Duration: 500ms, cubic-bezier(0.16, 1, 0.3, 1)
- Applied to main content wrapper on route change via a `.hud-boot` class
- **Trigger mechanism:** Since CSS cannot detect SPA route changes, a small React hook (`useBootAnimation`) adds the `.hud-boot` class to the content wrapper on mount. The class is removed after the animation completes (via `animationend` event). This is the only JS involvement — the animation itself is pure CSS.
- Single play (not infinite)

### 4.6 Radar Sweep

Radial sweep on circular status widgets.

```css
@keyframes radar-sweep {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
```

- Applied via `::before` with `conic-gradient(from 0deg, transparent 0%, var(--primary) 10%, transparent 20%)`
- Duration: 4s, infinite, linear
- Used on dashboard system health widget

### 4.7 Background Grid Pulse

Subtle background tactical grid that breathes.

```css
@keyframes grid-fade {
  0%, 100% { opacity: 0.03; }
  50% { opacity: 0.07; }
}
```

- Applied to `body::before` with:
  ```css
  background-image:
    repeating-linear-gradient(0deg, var(--border) 0 1px, transparent 1px 60px),
    repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 60px);
  ```
- Duration: 6s, infinite
- Covers entire viewport, `pointer-events: none`, `z-index: 0`

### 4.8 Holographic Shimmer

A diagonal light sweep across surfaces on hover.

```css
@keyframes holo-shimmer {
  0% { transform: translateX(-100%) rotate(-45deg); }
  100% { transform: translateX(200%) rotate(-45deg); }
}
```

- Applied via `::after` with white-to-transparent gradient, 0.05 opacity
- Duration: 1.5s on hover trigger, single play
- Used on cards, agent avatars, key panels

### Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

All animations respect the user's motion preferences.

---

## 5. Component Transformations

### 5.1 Layout Shell (`Layout.tsx`)

- **Body background:** `var(--background)` with grid-pulse overlay
- **Main content area:** `boot-in` animation on route transitions
- **Overall feel:** Dark command center with subtle grid wireframe behind everything

### 5.2 Company Rail (`CompanyRail.tsx`)

- **Background:** `var(--sidebar)` — darkest element
- **Left edge:** 1px solid `var(--primary)` accent line (full height)
- **Company icons:** 2px `var(--primary)` ring when selected, glow-pulse
- **Logo:** Electric blue tint via CSS filter

### 5.3 Sidebar (`Sidebar.tsx`)

- **Background:** `var(--sidebar)` with 1px right border `var(--sidebar-border)`
- **Section headers:** JetBrains Mono 9px, uppercase, `var(--muted-foreground)`, horizontal rule after
- **Nav items:**
  - Orbitron 11px, uppercase, `letter-spacing: 0.06em`
  - Active: left 2px `var(--primary)` bar + `var(--sidebar-accent)` bg + glow-pulse on icon
  - Hover: `var(--sidebar-accent)` background fade-in
  - Icons: Lucide icons get `var(--primary)` color when active
- **Agent list items:**
  - Status dot with glow-pulse when running
  - Name in Inter 13px, role in JetBrains Mono 10px muted
- **Collapse behavior:** Existing responsive behavior preserved

### 5.4 Breadcrumb Bar (`BreadcrumbBar.tsx`)

- **Background:** transparent (inherits main bg)
- **Separator:** `>` character in JetBrains Mono, `var(--muted-foreground)`
- **Current page:** Orbitron 11px, uppercase, `var(--foreground)`
- **Parent links:** Inter 12px, `var(--muted-foreground)`, hover: `var(--primary)`

### 5.5 Cards (global pattern)

- **Background:** `var(--card)` with `clip-path` angled corners
- **Border:** 1px `var(--border)`
- **Scan line:** `::after` with `hud-scan` animation
- **Hover:** border-trace animation + `translateY(-1px)` + holo-shimmer
- **Header pattern:** `// SECTION NAME` — Orbitron 11px uppercase. The `// ` prefix is rendered via a CSS `::before` pseudo-element (`content: "// "`) on `.hud-section-header` elements, keeping it purely decorative and out of the DOM/accessibility tree.
- **Data inside:** JetBrains Mono, key values in `var(--primary)`

### 5.6 Buttons (`button.tsx`)

| Variant | Style |
|---------|-------|
| **default (primary)** | `var(--primary)` bg, dark text, hover: `box-shadow: 0 0 20px var(--primary)` glow |
| **secondary** | `var(--secondary)` bg, light text, hover: border lightens |
| **outline** | transparent bg, 1px `var(--primary)` border, hover: border-trace animation |
| **ghost** | transparent, hover: `var(--primary)/8%` bg tint |
| **destructive** | `var(--destructive)` bg, hover: red glow |

All buttons: Orbitron 11px, uppercase, `letter-spacing: 0.04em`, sharp 2px radius.

### 5.7 Badges / Status Indicators

- **Active/Running:** `var(--status-active)` bg at 15% opacity, green text, glow-pulse dot
- **Paused/Warning:** `var(--status-warning)` bg at 15% opacity, amber text, static dot
- **Error/Critical:** `var(--status-error)` bg at 15% opacity, red text, fast glow-pulse dot
- **Info:** `var(--status-info)` bg at 15% opacity, electric blue text
- **All badges:** JetBrains Mono 10px, uppercase, sharp radius

### 5.8 Inputs & Forms

- **Border:** 1px `var(--input)`, focus: `var(--primary)` with `box-shadow: 0 0 8px var(--primary)/30%`
- **Background:** `var(--secondary)`
- **Text:** Inter 14px
- **Placeholder:** JetBrains Mono 12px, `var(--muted-foreground)`, italic
- **Labels:** JetBrains Mono 11px, uppercase, `var(--muted-foreground)`

### 5.9 Tables

- **Header row:** `var(--secondary)` bg, JetBrains Mono 10px uppercase labels
- **Data rows:** data-reveal animation on mount, hover: `var(--accent)` bg
- **Cell values:** JetBrains Mono 13px for data, Inter 13px for text

### 5.10 Dialogs

- **Overlay:** black at 70% opacity with subtle backdrop-blur
- **Panel:** `var(--card)` bg, `clip-path` angled corners, border-trace animation on open
- **Title:** Orbitron, uppercase
- **Boot-in animation on open**

### 5.11 Toast Notifications

- **Background:** `var(--card)` with left 3px colored bar (green/amber/red/blue by tone)
- **Text:** Inter body, JetBrains Mono for values
- **Entry:** Slide in from right with data-reveal effect

---

## 6. Files to Modify

### Phase 1 (Foundation + Layout Shell)

| File | Change |
|------|--------|
| `ui/index.html` | Add `<link rel="preload">` tags for Google Fonts (Orbitron, JetBrains Mono) |
| `ui/src/index.css` | Replace all CSS variables (both `:root` and `.dark`), add `color-scheme: dark`, add `@keyframes`, add utility classes (`.hud-panel`, `.font-display`, `.font-mono`, `.hud-scan`, `.hud-boot`, `.data-reveal`, `.hud-section-header`, etc.), add grid background, add mobile animation overrides |
| `ui/src/components/ui/button.tsx` | Update variant classes for HUD styling (glow effects, Orbitron font) |
| `ui/src/components/ui/badge.tsx` | Add glow-pulse support, status color variants |
| `ui/src/components/ui/card.tsx` | Add `hud-panel` class option for clip-path + scan line |
| `ui/src/components/ui/input.tsx` | Update focus styles for electric blue glow |
| `ui/src/components/ui/dialog.tsx` | Update overlay + panel styling |
| `ui/src/components/Layout.tsx` | Add boot-in animation wrapper, grid background |
| `ui/src/components/Sidebar.tsx` | Restyle nav items (Orbitron, active states, glow) |
| `ui/src/components/CompanyRail.tsx` | Add left accent line, selected glow |
| `ui/src/components/BreadcrumbBar.tsx` | Restyle with mono separators, Orbitron current |
| `ui/src/components/SidebarNavItem.tsx` | Active state with glow, border bar |
| `ui/src/components/SidebarSection.tsx` | JetBrains Mono headers, horizontal rules |
| `ui/src/context/ThemeContext.tsx` | Default to dark theme for HUD aesthetic |

### Phase 2 (Dashboard) — separate spec
### Phase 3 (CEO Chat) — separate spec
### Phase 4 (All Pages) — separate spec

---

## 7. Dependencies

**New dependencies: NONE.**

- Fonts loaded via Google Fonts `@import` in CSS (no npm package)
- All animations in pure CSS `@keyframes`
- Existing stack unchanged: Tailwind v4, Radix UI, shadcn, Lucide

---

## 8. Performance Budget

| Metric | Target |
|--------|--------|
| CSS animations | GPU-composited (`transform`, `opacity`, `filter`) preferred. `box-shadow` animations (glow-pulse) are paint-only — capped at 6 simultaneous instances per viewport to limit paint cost. On mobile, glow-pulse is reduced to static box-shadow (no animation). |
| Layout triggers | Zero — no `width`, `height`, `top`, `left` animations on elements |
| `will-change` | Applied only to animated pseudo-elements |
| Font loading | `display=swap` — no FOIT |
| Total CSS additions | ~4KB (keyframes + utility classes + variables) |
| Bundle size change | 0KB JavaScript |
| Reduced motion | All animations disabled via `prefers-reduced-motion` |
| Mobile animations | Glow-pulse reduced to static box-shadow; holo-shimmer disabled; scan line interval doubled to 16s |

---

## 9. Success Criteria

1. Every page feels like a mission control interface
2. Active agents visibly pulse — the UI feels alive when agents are working
3. Data appears with satisfying reveal animations
4. Navigation feels instant with boot-in transitions
5. Zero layout shift from animations
6. No performance degradation on mobile
7. Full dark/light mode support (dark is primary)
8. Accessible — all animations respect motion preferences
