# Luminous Accent UI Redesign

**Date:** 2026-04-05
**Status:** Approved
**Direction:** C) Luminous Accent — solid card surfaces with accent-tinted gradients on key elements
**Persona:** Non-technical executive/operator
**Prior context:** HeroUI v3 rewrite completed but resulted in a reskin, not a redesign. This spec defines the visual polish pass.
**Visual reference:** Run the dev server and visit `/AGE/visual-prototype` to see the Direction C mockup built with real HeroUI components.

---

## 1. Bug Fixes (Must-Fix)

### 1.1 New Issue Modal Positioning
The `NewIssueDialog` modal renders anchored to the bottom-left corner instead of centered. Investigate and fix the HeroUI `Modal` usage — likely a missing `placement` prop, incorrect wrapper structure, or CSS conflict. Modal must center on screen with proper backdrop.

### 1.2 Metric Cards Missing Card Treatment
Dashboard metric cards (Agents, Tasks, Spend, Approvals) currently render as floating numbers with no container. Wrap each in a HeroUI `Card` component with proper borders and shadows per the Luminous Accent color rules (Section 2).

### 1.3 Lists With Sharp Corners
All `border border-border` lists (Recent Activity, Recent Tasks, Issues list, Agents tree) must be wrapped in rounded `Card` containers using the theme's 16px radius. Internal dividers use `border-default-200/30`.

---

## 2. Design Language — Luminous Accent System

### 2.1 Color Treatment Rules

The accent color is information, not decoration. It signals what's alive, important, or needs attention.

| Context | Card Background | Text Color | Border | Shadow |
|---------|----------------|------------|--------|--------|
| Primary metric (Agents) | `from-accent/[0.08] to-accent/[0.02]` | `text-accent` | `border-accent/[0.12]` | `shadow-accent/6` |
| Financial (Spend) | `from-success/[0.05] to-transparent` | `text-success` | `border-success/[0.08]` | none |
| Danger states | gradient border | `text-danger` | `border-danger/20` | `shadow-danger/30` |
| Neutral / inactive | none | `text-foreground` | `border-default-200/60` | none |
| Links and references | n/a | `text-accent font-medium` | n/a | n/a |

### 2.2 Surface Hierarchy (3 Layers)

1. **Background** — deepest layer, `bg-background`
2. **Surface** — cards, sidebar, panels — HeroUI `Card` with `border-default-200/60` and theme surface shadow
3. **Elevated** — modals, dropdowns, popovers — `overlay-shadow` + subtle backdrop blur

### 2.3 Typography

| Element | Size | Weight | Tracking | Case | Color |
|---------|------|--------|----------|------|-------|
| Page titles | 24px | bold | tight | Mixed-case | `text-foreground` |
| Card section headers | 13px | semibold | normal | Mixed-case | `text-foreground/60` |
| Sidebar group labels | 10px | medium | wider | Uppercase | `text-accent/30` |
| Sidebar nav items | 13px | medium (active: semibold) | normal | Mixed-case | active: `text-accent`, inactive: `text-foreground/40` |
| Metric values | 28-32px | extrabold | tight | n/a | semantic color |
| Metric labels | 11px | medium | normal | Mixed-case | `text-foreground/40` |
| Metric sub-labels | 10px | normal | normal | Mixed-case | semantic color at 40-50% opacity |

---

## 3. Sidebar Redesign

### 3.1 Active Nav Item
```
bg-gradient-to-r from-accent/15 to-accent/5
border border-accent/10
text-accent font-semibold
rounded-xl
```

### 3.2 Company Avatar
- Gradient background: `from-accent to-secondary`
- Glow: `shadow-md shadow-accent/20`
- Size: `h-7 w-7`, `rounded-lg`

### 3.3 Inbox Badge
- Background: `bg-gradient-to-r from-danger to-red-500`
- Text: white, 10px, font-semibold
- Glow: `shadow-sm shadow-danger/30`
- Shape: `rounded-full`

### 3.4 Group Labels
- Color: `text-accent/30` (tinted, not neutral gray)
- Size: 10px, uppercase, tracking-wider, font-medium

### 3.5 Search Bar
- Background: `bg-default/30`
- Border: `border-default-200/40`
- Keyboard shortcut: `font-mono text-foreground/25`

---

## 4. Dashboard Redesign

### 4.1 Metric Cards
Each metric wrapped in HeroUI `Card` with:
- Icon in top-right inside tinted `rounded-xl` container (e.g. `bg-accent/10` for agents)
- Value in large extrabold text with semantic color
- Label in `text-foreground/40`
- Sub-label in semantic color at reduced opacity
- Agents card: accent gradient background + accent glow shadow
- Spend card: success gradient background
- Others: neutral `border-default-200/60`

### 4.2 Chart Cards
- Each chart in a HeroUI `Card` with `border-default-200/60`
- Chart bars/areas use `bg-accent/20` as base color
- Title: 12-13px semibold, `text-foreground/50`
- Subtitle: 10px, `text-foreground/25`

### 4.3 Recent Activity Section
- Wrapped in `Card` with rounded corners
- Header: card header with bottom border `border-default-200/40`
- Each row: avatar circle (6x6, initials), action text, accent-colored entity reference, timestamp
- Row dividers: `border-default-200/30`

### 4.4 Recent Tasks Section
- Wrapped in `Card` with rounded corners
- Each row: open-circle status icon (`border-2 border-accent/40`), title, issue ID in mono, agent as `Chip size="sm" variant="soft"`, timestamp
- Row dividers: `border-default-200/30`

---

## 5. List Pages

### 5.1 Issues List
- Rows inside a rounded `Card` container
- Separator lines: `border-default-200/30`
- Hover state: `hover:bg-accent/[0.03]` (subtle accent tint)
- Status icons maintain semantic colors
- "New Issue" button: `Button color="accent"` with accent fill

### 5.2 Agents Tree/List
- Rows inside a rounded `Card` container
- Each agent row:
  - Status dot with semantic color (green=active, yellow=idle, red=error)
  - Agent name: `font-medium text-foreground/80`
  - Role description: `text-foreground/40` (dimmer than name, clear separation)
  - "idle" status: HeroUI `Chip size="sm" variant="soft"`
  - Adapter name: muted text
- Filter tabs: HeroUI `Tabs` with correct v3 compound pattern (`Tabs.ListContainer > Tabs.List > Tabs.Tab`)
- "New Agent" button: `Button color="accent"`

### 5.3 Activity Page
- Same card-wrapped treatment as dashboard activity section
- Avatar + action text + accent references + timestamp per row

---

## 6. Modal Fix + Polish

### 6.1 Modal Centering
Fix `NewIssueDialog` to center on screen. Investigate:
- HeroUI Modal `placement` prop
- Missing wrapper component
- CSS conflicts from the migration

### 6.2 Modal Visual Treatment
All modals:
- `rounded-2xl` corners
- `overlay-shadow` for depth
- Backdrop: `backdrop-blur-[2px]` with theme backdrop color

### 6.3 Dropdowns and Popovers
- Consistent overlay shadow treatment
- Rounded corners matching theme radius

---

## 7. Motion Refinements

Keep existing Framer Motion spring system. Ensure:

- **Page transitions**: verify `AnimatePresence` key changes fire on route navigation
- **Card hover**: `scale(1.01)` with `transition: transform 150ms ease`
- **List item stagger**: 40ms delay, `opacity: 0 -> 1` + `y: 4px -> 0`
- **Sidebar collapse**: smooth height animation (already in `SidebarGroup`, verify working)
- **Modal entrance**: scale 0.95 -> 1.0 + fade, spring physics

---

## 8. HeroUI v3 Component Patterns

All components must use correct v3 compound patterns:

| Component | Pattern |
|-----------|---------|
| Card | `Card > Card.Header > Card.Title / Card.Description`, `Card.Content`, `Card.Footer` |
| Tabs | `Tabs > Tabs.ListContainer > Tabs.List > Tabs.Tab > Tabs.Indicator`, `Tabs.Panel` |
| Avatar | `Avatar > Avatar.Image + Avatar.Fallback` |
| Badge | `Badge.Anchor > [element] + Badge` |
| Modal | `Modal > Modal.Dialog > Modal.Header + Modal.Body + Modal.Footer` |
| Chip | `Chip > Chip.Label` (plain text auto-wraps) |

---

## 9. Scope and Non-Goals

**In scope:**
- All pages visible in the sidebar navigation
- Dashboard, Issues, Agents, Projects, Goals, Approvals, Costs, Activity, Inbox
- Sidebar, breadcrumbs, command palette visual treatment
- Modal fixes
- Light and dark mode consistency

**Not in scope (this pass):**
- Mobile bottom nav redesign
- Electron titlebar integration
- Settings pages redesign
- Plugin page styling
- New page layouts or information architecture changes
- New features or functionality

---

## 10. Verification

After implementation:
1. All pages render without console errors
2. `pnpm typecheck` passes
3. `pnpm build` passes
4. New Issue modal centers correctly
5. All metric cards have proper card treatment
6. All lists have rounded card containers
7. Accent color is visible on: active nav, primary metric, entity references, group labels
8. Light and dark mode both look intentional
9. Page titles are mixed-case, not uppercase
