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

### Blocked Inbox reason + action (K-20108)

A blocked-inbox row answers three questions: which task, why it stopped, what to do. Two rules decide what the row is allowed to say.

**Rule 1 — the chip prints the reason, the variant drives the styling.** `BlockedReasonChip` renders `blockedReasonLabel(reason)`, not `blockedVariantLabel(variant)`. The variant still selects colour, icon and `data-variant`, and still names the group the row is bucketed under. Printing the group label on the row made it redundant with its own group header *and* collapsed the server's 11 reasons into 6 indistinguishable strings — `needs_attention` covers Unassigned blocker, Parked blocker, Cancelled blocker and Review without action path alike.

**Rule 2 — the action obeys a documented suppression rule.** `blockedRowActionLabel()` returns `null` when the action carries no target, so nothing renders. The rule is "does this action name something?", not "is this a string I recognise?" — it keys on the **label** only to recognise the fallback, never on the reason.

Live census, 2026-09-28T19:26Z, `GET /api/companies/{id}/issues?status=blocked&includeBlockedInboxAttention=true&includeBlockedBy=true&limit=500` — 74 blocked rows, 60 carrying an action:

| action label | rows | `leafIssue` null | detail strings | rendered |
|---|---|---|---|---|
| `Inspect blocker chain` | 51 of 60 (85%) | 51/51 | 1 | no — suppressed |
| `Answer confirmation` | 5 | 5/5 | 1 | yes |
| `Choose disposition` | 2 | 2/2 | 1 | yes |
| `Assign blocker` | 1 | 0/1 | 1 | yes |
| `Resume parked blocker` | 1 | 0/1 | 1 | yes |

**Read the two degenerate columns, not the row counts.** The totals drift — the same board read 76 attended rows on one pass, 67 on the next, 60 on the last. The degeneracy does not: on all 51 stalled rows simultaneously, `leafIssue` is null, `recoveryIssue` is null, `owner.type` is `"unknown"`, and the detail string is one byte-identical string. Those are properties of the server branch, so they hold at any queue depth. `Assign blocker` → K-20119 and `Resume parked blocker` → K-20035 also carry a non-null `leafIssue`, but that is **not** why they render: neither label is in the fallback set, so they return at the first check and never reach the leaf test. Naming a leaf only matters to a row still wearing a fallback label — condition 2 exists to rescue a *stalled* row that acquires a leaf, not to explain the two specific rows.

`Inspect blocker chain` is the `blocked_chain_stalled` fallback branch of the attention build (`server/src/services/issues.ts`, ~L6391): it fires when no leaf produced a specific finding. It is dropped for two independent reasons — it names no target, and the rows already sit under a group header reading "Blocked chain stalled", so rendering it adds ~51 lines of noise and zero information.

**The number that re-opens it.** These three are **implemented**, not merely described. A row is suppressed only while all three hold, so the first to become true renders the action with no code change:

1. the label stops being a known fallback — e.g. it becomes `Unblock K-20015 by removing done blocker K-20016`;
2. `leafIssue` becomes non-null on a stalled row (0 of 51 today) — the row now names a target;
3. the detail stops being the canonical stall string **and is present** (1 distinct string today), so the row carries something the label alone does not. An *absent* detail does not re-open the action — the check requires a detail that differs, so only an empty detail falls through with the fallback.

A rule written as "hide the action when the reason is `blocked_chain_stalled`" would have silently swallowed all three. So would a label-only allowlist that ignored conditions 2 and 3 — which is why the function tests all three, and why the guide and the function must be changed together.

**Search parity.** `blockedRowSearchTokens()` indexes exactly what the row displays: title, identifier, the specific reason, the displayed action, and **two conditional tokens** — the variant group label only when the group header is actually rendered (with grouping set to "None" there is no header, so indexing it would match a row that reads only "Parked blocker"), and the owner name **as the row resolves it** (the server sets `owner.label: null` on the finding-driven path while the row still shows the assignee name from `owner.agentId`, so indexing the raw field alone made a displayed name unfindable).

`action.detail` is not indexed, and a suppressed action is not findable either. `leafIssue`/`recoveryIssue` refs are also **not** indexed: no render path draws them — the row has no blocker-chain or linked-blocker content, and the server's `leafIssue` is the last issue in `finding.dependencyPath`, which is a *different* issue from the row. Re-add them only in the same change that renders them. Never let the search box index text the row does not show — a filter that matches on hidden strings is a lie about the result.

Showcase: `ui/src/pages/DesignGuide.tsx` → "Blocked Inbox reason and action (K-20108)". Tests: `ui/src/lib/blockedInbox.test.ts`, `ui/src/components/BlockedReasonChip.test.tsx`, `ui/src/components/BlockedInboxView.test.tsx`.

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
