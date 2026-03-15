---
name: design-guide
description: >
  Paperclip UI design system guide for building consistent, reusable frontend
  components. Use when creating new UI components, modifying existing ones,
  adding pages or features to the frontend, styling UI elements, or when you
  need to understand the design language and conventions. Covers: component
  creation, design tokens, typography, status/priority systems, composition
  patterns, and the /design-guide showcase page. Always use this skill
  alongside the frontend-design skill (for visual quality) and the
  web-design-guidelines skill (for web best practices).
---

# Paperclip Design Guide

Paperclip's UI is a professional-grade control plane — dense, keyboard-driven, dark-themed by default. Every pixel earns its place.

**Always use with:** `frontend-design` (visual polish) and `web-design-guidelines` (web best practices).

---

## 1. Design Principles

- **Dense but scannable.** Maximum information without clicks to reveal. Whitespace separates, not pads.
- **Keyboard-first.** Global shortcuts (Cmd+K, C, [, ]). Power users rarely touch the mouse.
- **Contextual, not modal.** Inline editing over dialog boxes. Dropdowns over page navigations.
- **Dark theme default.** Neutral grays (OKLCH), not pure black. Accent colors for status/priority only. Text is the primary visual element.
- **Component-driven.** Prefer reusable components that capture style conventions. Build at the right abstraction — not too granular, not too monolithic.

---

## 2. Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4** with CSS variables (OKLCH color space)
- **shadcn/ui** (new-york style, neutral base, CSS variables enabled)
- **Radix UI** primitives (accessibility, focus management)
- **Lucide React** icons (16px nav, 14px inline)
- **class-variance-authority** (CVA) for component variants
- **clsx + tailwind-merge** via `cn()` utility

Config: `ui/components.json` (aliases: `@/components`, `@/components/ui`, `@/lib`, `@/hooks`)

---

## 3. Design Tokens

All tokens defined as CSS variables in `ui/src/index.css`. Both light and dark themes use OKLCH.

### Colors

Use semantic token names, never raw color values:

| Token | Usage |
|-------|-------|
| `--background` / `--foreground` | Page background and primary text |
| `--card` / `--card-foreground` | Card surfaces |
| `--primary` / `--primary-foreground` | Primary actions, emphasis |
| `--secondary` / `--secondary-foreground` | Secondary surfaces |
| `--muted` / `--muted-foreground` | Subdued text, labels |
| `--accent` / `--accent-foreground` | Hover states, active nav items |
| `--destructive` | Destructive actions |
| `--border` | All borders |
| `--ring` | Focus rings |
| `--sidebar-*` | Sidebar-specific variants |
| `--chart-1` through `--chart-5` | Data visualization |

### Radius

Single `--radius` variable (0.625rem) with derived sizes:

- `rounded-sm` — small inputs, pills
- `rounded-md` — buttons, inputs, small components
- `rounded-lg` — cards, dialogs
- `rounded-xl` — card containers, large components
- `rounded-full` — badges, avatars, status dots

### Shadows

Minimal shadows: `shadow-xs` (outline buttons), `shadow-sm` (cards). No heavy shadows.

---

## 4. Typography Scale

Use these exact patterns — do not invent new ones:

| Pattern | Classes | Usage |
|---------|---------|-------|
| Page title | `text-xl font-bold` | Top of pages |
| Section title | `text-lg font-semibold` | Major sections |
| Section heading | `text-sm font-semibold text-muted-foreground uppercase tracking-wide` | Section headers in design guide, sidebar |
| Card title | `text-sm font-medium` or `text-sm font-semibold` | Card headers, list item titles |
| Body | `text-sm` | Default body text |
| Muted | `text-sm text-muted-foreground` | Descriptions, secondary text |
| Tiny label | `text-xs text-muted-foreground` | Metadata, timestamps, property labels |
| Mono identifier | `text-xs font-mono text-muted-foreground` | Issue keys (PAP-001), CSS vars |
| Large stat | `text-2xl font-bold` | Dashboard metric values |
| Code/log | `font-mono text-xs` | Log output, code snippets |

---

## 5. Status & Priority Systems

### Status Colors (consistent across all entities)

Defined in `StatusBadge.tsx` and `StatusIcon.tsx`:

| Status | Color | Entity types |
|--------|-------|-------------|
| active, achieved, completed, succeeded, approved, done | Green shades | Agents, goals, issues, approvals |
| running | Cyan | Agents |
| paused | Orange | Agents |
| idle, pending | Yellow | Agents, approvals |
| failed, error, rejected, blocked | Red shades | Runs, agents, approvals, issues |
| archived, planned, backlog, cancelled | Neutral gray | Various |
| todo | Blue | Issues |
| in_progress | Indigo | Issues |
| in_review | Violet | Issues |

### Priority Icons

Defined in `PriorityIcon.tsx`: critical (red/AlertTriangle), high (orange/ArrowUp), medium (yellow/Minus), low (blue/ArrowDown).

### Agent Status Dots

Inline colored dots: running (cyan, animate-pulse), active (green), paused (yellow), error (red), offline (neutral).

---

## 6. Component Hierarchy

Three tiers:

1. **shadcn/ui primitives** (`ui/src/components/ui/`) — Button, Card, Input, Badge, Dialog, Tabs, etc. Do not modify these directly; extend via composition.
2. **Custom composites** (`ui/src/components/`) — StatusBadge, EntityRow, MetricCard, etc. These capture Paperclip-specific design language.
3. **Page components** (`ui/src/pages/`) — Compose primitives and composites into full views.

**See [references/component-index.md](references/component-index.md) for the complete component inventory with usage guidance.**

### When to Create a New Component

Create a reusable component when:
- The same visual pattern appears in 2+ places
- The pattern has interactive behavior (status changing, inline editing)
- The pattern encodes domain logic (status colors, priority icons)

Do NOT create a component for:
- One-off layouts specific to a single page
- Simple className combinations (use Tailwind directly)
- Thin wrappers that add no semantic value

---

## 7. Composition Patterns

These patterns describe how components work together. They may not be their own component, but they must be used consistently across the app.

### Entity Row with Status + Priority

The standard list item for issues and similar entities:

```tsx
<EntityRow
  leading={<><StatusIcon status="in_progress" /><PriorityIcon priority="high" /></>}
  identifier="PAP-001"
  title="Implement authentication flow"
  subtitle="Assigned to Agent Alpha"
  trailing={<StatusBadge status="in_progress" />}
  onClick={() => {}}
/>
```

Leading slot always: StatusIcon first, then PriorityIcon. Trailing slot: StatusBadge or timestamp.

### Grouped List

Issues grouped by status header + entity rows:

```tsx
<div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
  <StatusIcon status="in_progress" />
  <span className="text-sm font-medium">In Progress</span>
  <span className="text-xs text-muted-foreground ml-1">2</span>
</div>
<div className="border border-border rounded-b-md">
  <EntityRow ... />
  <EntityRow ... />
</div>
```

### Property Row

Key-value pairs in properties panels:

```tsx
<div className="flex items-center justify-between py-1.5">
  <span className="text-xs text-muted-foreground">Status</span>
  <StatusBadge status="active" />
</div>
```

Label is always `text-xs text-muted-foreground`, value on the right. Wrap in a container with `space-y-1`.

### Metric Card Grid

Dashboard metrics in a responsive grid:

```tsx
<div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
  <MetricCard icon={Bot} value={12} label="Active Agents" description="+3 this week" />
  ...
</div>
```

### Progress Bar (Budget)

Color by threshold: green (<60%), yellow (60-85%), red (>85%):

```tsx
<div className="w-full h-2 bg-muted rounded-full overflow-hidden">
  <div className="h-full rounded-full bg-green-400" style={{ width: `${pct}%` }} />
</div>
```

### Comment Thread

Author header (name + timestamp) then body, in bordered cards with `space-y-3`. Add comment textarea + button below.

### Cost Table

Standard `<table>` with `text-xs`, header row with `bg-accent/20`, `font-mono` for numeric values.

### Log Viewer

`bg-neutral-950 rounded-lg p-3 font-mono text-xs` container. Color lines by level: default (foreground), WARN (yellow-400), ERROR (red-400), SYS (blue-300). Include live indicator dot when streaming.

---

## 8. Interactive Patterns

### Hover States

- Entity rows: `hover:bg-accent/50`
- Nav items: `hover:bg-accent/50 hover:text-accent-foreground`
- Active nav: `bg-accent text-accent-foreground`

### Focus

`focus-visible:ring-ring focus-visible:ring-[3px]` — standard Tailwind focus-visible ring.

### Disabled

`disabled:opacity-50 disabled:pointer-events-none`

### Inline Editing

Use `InlineEditor` component — click text to edit, Enter saves, Escape cancels.

### Popover Selectors

StatusIcon and PriorityIcon use Radix Popover for inline selection. Follow this pattern for any clickable property that opens a picker.

---

## 9. Layout System

Three-zone layout defined in `Layout.tsx`:

```
┌──────────┬──────────────────────────────┬──────────────────────┐
│ Sidebar  │  Breadcrumb bar              │                      │
│ (w-60)   ├──────────────────────────────┤  Properties panel    │
│          │  Main content (flex-1)       │  (w-80, optional)    │
└──────────┴──────────────────────────────┴──────────────────────┘
```

- Sidebar: `w-60`, collapsible, contains CompanySwitcher + SidebarSections
- Properties panel: `w-80`, shown on detail views, hidden on lists
- Main content: scrollable, `flex-1`

---

## 10. The /design-guide Page

**Location:** `ui/src/pages/DesignGuide.tsx`
**Route:** `/design-guide`

This is the living showcase of every component and pattern in the app. It is the source of truth for how things look.

### Rules

1. **When you add a new reusable component, you MUST add it to the design guide page.** Show all variants, sizes, and states.
2. **When you modify an existing component's API, update its design guide section.**
3. **When you add a new composition pattern, add a section demonstrating it.**
4. Follow the existing structure: `<Section title="...">` wrapper with `<SubSection>` for grouping.
5. Keep sections ordered logically: foundational (colors, typography) first, then primitives, then composites, then patterns.

### Adding a New Section

```tsx
<Section title="My New Component">
  <SubSection title="Variants">
    {/* Show all variants */}
  </SubSection>
  <SubSection title="Sizes">
    {/* Show all sizes */}
  </SubSection>
  <SubSection title="States">
    {/* Show interactive/disabled states */}
  </SubSection>
</Section>
```

---

## 11. Component Index

**See [references/component-index.md](references/component-index.md) for the full component inventory.**

When you create a new reusable component:
1. Add it to the component index reference file
2. Add it to the /design-guide page
3. Follow existing naming and file conventions

---

## 12. File Conventions

- **shadcn primitives:** `ui/src/components/ui/{component}.tsx` — lowercase, kebab-case
- **Custom components:** `ui/src/components/{ComponentName}.tsx` — PascalCase
- **Pages:** `ui/src/pages/{PageName}.tsx` — PascalCase
- **Utilities:** `ui/src/lib/{name}.ts`
- **Hooks:** `ui/src/hooks/{useName}.ts`
- **API modules:** `ui/src/api/{entity}.ts`
- **Context providers:** `ui/src/context/{Name}Context.tsx`

All components use `cn()` from `@/lib/utils` for className merging. All components use CVA for variant definitions when they have multiple visual variants.

---

## 13. Common Mistakes to Avoid

- Using raw hex/rgb colors instead of CSS variable tokens
- Creating ad-hoc typography styles instead of using the established scale
- Hardcoding status colors instead of using StatusBadge/StatusIcon
- Building one-off styled elements when a reusable component exists
- Adding components without updating the design guide page
- Using `shadow-md` or heavier — keep shadows minimal (xs, sm only)
- Using `rounded-2xl` or larger — max is `rounded-xl` (except `rounded-full` for pills)
- Forgetting dark mode — always use semantic tokens, never hardcode light/dark values
