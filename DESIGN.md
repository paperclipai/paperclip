# DESIGN.md — Raava Dashboard

> The design bible for the Raava dashboard. Every color, every component, every pixel decision lives here. If you are an AI agent building a new page, this is your single source of truth. If a value appears here, use it. If it doesn't, you're inventing — stop and check.

---

## 1. Visual Theme & Atmosphere

Raava is warm light pouring through a clean office window onto a tidy desk. It is the opposite of a developer tool. There are no monospace terminals, no matrix-green status bars, no dense data grids screaming for attention. This is a product built for the founder who manages a team of AI workers the same way they'd manage a team of humans — with a glance at a dashboard that feels like opening a well-organized team directory.

**Light-mode-first.** The default canvas is an off-white warmth (`oklch(0.99 0 0)`) — not sterile pure white, but the soft tone of good paper. Cards float above it with the gentlest of shadows, like index cards on a desk. Dark mode exists and is fully supported, but light mode is the soul of the product.

**The brand gradient** — `linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)` — moves from a confident blue through a soft purple into a grounded teal. It appears sparingly: on the primary call-to-action button, the active navigation indicator, the onboarding wizard's completed steps, and the large stat numbers on the home page. It is the product's signature. Overuse kills it.

**Three typefaces, each with a job.** Syne is the voice of the brand — it appears at weight 800 in welcome greetings, page titles, and large metric numbers. It is bold, geometric, and opinionated. Plus Jakarta Sans is the workhorse — body text, labels, buttons, descriptions. Comfortable and legible at every size. JetBrains Mono handles the rare moments where technical content surfaces — code blocks, configuration values, IDs.

**Card-based, not table-based.** Team members are cards in a grid, not rows in a spreadsheet. Each card is a small portrait of a team member: avatar, name, role, status dot, current task. The grid breathes — `gap-5` between cards, generous padding inside them. Tables appear only for dense operational data (task lists, billing line items), and even then they're styled with simple `border-b` dividers, not heavy grid lines.

**Human language everywhere.** The product says "Team Members" where other tools say "Agents." It says "Hire" where others say "Provision." Tasks, not Issues. Working, not Running. The UI should feel like managing people, not infrastructure.

**Status at a glance.** Small colored dots — 8px or 10px circles — are the primary status indicator throughout the product. Green means working. Red means attention needed. Yellow means idle or paused. Cyan with a pulse animation means actively running right now. These dots appear on team member cards, in navigation badges, and inline with task lists. Larger status badges (pill-shaped, color-coded backgrounds) provide more context when space allows.

---

## 2. Color Palette & Roles

All color tokens are defined in oklch and live in `ui/src/index.css`. These are the canonical values.

### Light Mode Tokens

| Token | Value | Role |
|---|---|---|
| `--background` | `oklch(0.99 0 0)` | Page canvas. The off-white ground that everything sits on. |
| `--foreground` | `oklch(0.15 0 0)` | Primary text color. Near-black for maximum readability without the harshness of pure black. |
| `--card` | `oklch(0.99 0 0)` | Card surfaces. Same tone as background; elevation is communicated through border + shadow, not color difference. |
| `--card-foreground` | `oklch(0.15 0 0)` | Text on cards. |
| `--primary` | `oklch(0.48 0.22 264)` | Brand blue — `#224AE8`. Buttons, links, active states, focus rings. The dominant interactive color. |
| `--primary-foreground` | `oklch(0.99 0 0)` | Text on primary-colored surfaces. White. |
| `--accent` | `oklch(0.72 0.14 185)` | Brand teal — `#00BDB7`. Secondary interactive color. Selection rings, completed wizard steps, hover tints. |
| `--accent-foreground` | `oklch(0.15 0 0)` | Text on accent-colored surfaces. |
| `--secondary` | `oklch(0.97 0 0)` | Light gray. Backgrounds for secondary buttons, inactive filter tabs, subtle containers. |
| `--secondary-foreground` | `oklch(0.15 0 0)` | Text on secondary surfaces. |
| `--muted` | `oklch(0.97 0 0)` | Muted backgrounds. Same as secondary. |
| `--muted-foreground` | `oklch(0.556 0 0)` | Secondary text. Descriptions, timestamps, helper text, placeholders. Medium gray. |
| `--destructive` | `oklch(0.577 0.245 27.325)` | Error red. Destructive buttons, validation errors, error states. |
| `--destructive-foreground` | `oklch(0.577 0.245 27.325)` | Text for destructive context (same as destructive in light mode). |
| `--border` | `oklch(0.922 0 0)` | Borders. Very light gray. Cards, inputs, dividers. |
| `--input` | `oklch(0.922 0 0)` | Input field borders. Same as border. |
| `--ring` | `oklch(0.48 0.22 264)` | Focus ring color. Matches primary. |
| `--popover` | `oklch(0.99 0 0)` | Popover/dropdown backgrounds. |
| `--popover-foreground` | `oklch(0.15 0 0)` | Text in popovers. |

### Dark Mode Tokens

| Token | Value | Role |
|---|---|---|
| `--background` | `oklch(0.15 0 0)` | Dark page canvas. |
| `--foreground` | `oklch(0.985 0 0)` | Light text on dark backgrounds. |
| `--card` | `oklch(0.205 0 0)` | Card surfaces. Slightly elevated from the background. |
| `--card-foreground` | `oklch(0.985 0 0)` | Text on dark cards. |
| `--primary` | `oklch(0.55 0.24 285)` | Adjusted brand purple-blue for dark backgrounds. |
| `--primary-foreground` | `oklch(0.99 0 0)` | White text on primary. |
| `--accent` | `oklch(0.72 0.14 185)` | Brand teal. Same value in both modes. |
| `--accent-foreground` | `oklch(0.985 0 0)` | Light text on accent. |
| `--secondary` | `oklch(0.269 0 0)` | Dark gray surfaces. |
| `--secondary-foreground` | `oklch(0.985 0 0)` | Light text on secondary. |
| `--muted` | `oklch(0.269 0 0)` | Muted dark surfaces. |
| `--muted-foreground` | `oklch(0.708 0 0)` | Secondary text in dark mode. Lighter gray than light mode's muted-foreground. |
| `--destructive` | `oklch(0.637 0.237 25.331)` | Error red, brightened for dark backgrounds. |
| `--destructive-foreground` | `oklch(0.985 0 0)` | White text on destructive. |
| `--border` | `oklch(0.269 0 0)` | Dark mode borders. |
| `--input` | `oklch(0.269 0 0)` | Dark mode input borders. |
| `--ring` | `oklch(0.55 0.24 285)` | Dark mode focus ring. Matches dark primary. |

### Brand Gradient

```css
--raava-gradient: linear-gradient(90deg, #224AE8, #716EFF, #00BDB7);
```

Used via utility classes:
- `.raava-gradient-bg` — solid gradient background (buttons, badges)
- `.raava-gradient-text` — gradient text fill via `background-clip: text` (stat numbers, brand marks)
- `.raava-stat-number` — large metric display: Syne weight 800, 2.5rem, gradient text

### Warm-White Section Alternation (Notion-inspired)

Long pages benefit from alternating between the standard background and a warm-white tone to create visual rhythm without borders or dividers.

| Token | Light Mode | Dark Mode | Role |
|---|---|---|---|
| `--background` | `oklch(0.99 0 0)` | `oklch(0.15 0 0)` | Standard page canvas |
| `--background-warm` | `#f6f5f4` | `oklch(0.17 0 0)` | Alternating section background. Yellow-brown undertone in light mode. |

Usage:
- Tailwind: `bg-background-warm`
- Utility class: `.raava-bg-warm`
- Apply to alternating content sections on long pages (Settings, Billing, Team Members list)
- In dark mode, the warm variant is a slightly lighter neutral — no warm undertone needed on dark backgrounds

### Status Colors

Status colors use Tailwind's built-in color scale. These are the exact mappings from `lib/status-colors.ts`:

**Agent status dots** (solid bg, `h-2 w-2 rounded-full`):

| Status | Dot Class | Behavior |
|---|---|---|
| Running | `bg-cyan-400` | `animate-pulse` — throbs to indicate live activity |
| Active / Working | `bg-green-400` | Solid |
| Paused | `bg-yellow-400` | Solid |
| Idle | `bg-yellow-400` | Solid |
| Pending Approval | `bg-amber-400` | Solid |
| Error / Needs Attention | `bg-red-400` | Solid |
| Archived / Stopped | `bg-neutral-400` | Solid |

**Status badges** (pill-shaped, `rounded-full`):

| Status | Light Mode | Dark Mode |
|---|---|---|
| Active / Succeeded / Done | `bg-green-100 text-green-700` | `bg-green-900/50 text-green-300` |
| Running | `bg-cyan-100 text-cyan-700` | `bg-cyan-900/50 text-cyan-300` |
| Paused / Timed Out | `bg-orange-100 text-orange-700` | `bg-orange-900/50 text-orange-300` |
| Idle / Pending | `bg-yellow-100 text-yellow-700` | `bg-yellow-900/50 text-yellow-300` |
| Error / Failed / Blocked | `bg-red-100 text-red-700` | `bg-red-900/50 text-red-300` |
| Archived / Stopped / Cancelled | `bg-muted text-muted-foreground` | `bg-muted text-muted-foreground` |
| In Review | `bg-violet-100 text-violet-700` | `bg-violet-900/50 text-violet-300` |
| Frozen | `bg-blue-100 text-blue-700` | `bg-blue-900/50 text-blue-300` |
| Provisioning | `bg-purple-100 text-purple-700` | `bg-purple-900/50 text-purple-300` |
| Pending Approval | `bg-amber-100 text-amber-700` | `bg-amber-900/50 text-amber-300` |

**Priority colors** (text only):

| Priority | Light Mode | Dark Mode |
|---|---|---|
| Critical | `text-red-600` | `text-red-400` |
| High | `text-orange-600` | `text-orange-400` |
| Medium | `text-yellow-600` | `text-yellow-400` |
| Low | `text-blue-600` | `text-blue-400` |

**Issue status circles** (bordered rings, `h-4 w-4 rounded-full border-2`):

| Status | Light Mode | Dark Mode |
|---|---|---|
| Backlog | `text-muted-foreground border-muted-foreground` | Same |
| Todo | `text-blue-600 border-blue-600` | `text-blue-400 border-blue-400` |
| In Progress | `text-yellow-600 border-yellow-600` | `text-yellow-400 border-yellow-400` |
| In Review | `text-violet-600 border-violet-600` | `text-violet-400 border-violet-400` |
| Done | `text-green-600 border-green-600` | `text-green-400 border-green-400` |
| Cancelled | `text-neutral-500 border-neutral-500` | Same |
| Blocked | `text-red-600 border-red-600` | `text-red-400 border-red-400` |

### Chart Colors (5-series palette)

| Series | Light Mode | Dark Mode |
|---|---|---|
| 1 | `oklch(0.646 0.222 41.116)` — warm orange | `oklch(0.488 0.243 264.376)` — blue |
| 2 | `oklch(0.6 0.118 184.704)` — teal-cyan | `oklch(0.696 0.17 162.48)` — green-teal |
| 3 | `oklch(0.398 0.07 227.392)` — dark blue-gray | `oklch(0.769 0.188 70.08)` — amber |
| 4 | `oklch(0.828 0.189 84.429)` — yellow-green | `oklch(0.627 0.265 303.9)` — purple |
| 5 | `oklch(0.769 0.188 70.08)` — amber-orange | `oklch(0.645 0.246 16.439)` — red-orange |

### Sidebar Tokens

The sidebar uses its own token set, currently mirroring the main palette:

| Token | Light | Dark |
|---|---|---|
| `--sidebar` | `oklch(0.99 0 0)` | `oklch(0.15 0 0)` |
| `--sidebar-foreground` | `oklch(0.15 0 0)` | `oklch(0.985 0 0)` |
| `--sidebar-primary` | `oklch(0.48 0.22 264)` | `oklch(0.55 0.24 285)` |
| `--sidebar-primary-foreground` | `oklch(0.99 0 0)` | `oklch(0.99 0 0)` |
| `--sidebar-accent` | `oklch(0.72 0.14 185)` | `oklch(0.72 0.14 185)` |
| `--sidebar-accent-foreground` | `oklch(0.15 0 0)` | `oklch(0.985 0 0)` |
| `--sidebar-border` | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` |
| `--sidebar-ring` | `oklch(0.48 0.22 264)` | `oklch(0.55 0.24 285)` |

---

## 3. Typography Rules

### Font Families

| Family | CSS Variable | Usage | Weights |
|---|---|---|---|
| **Syne** | `--font-display` / `.font-display` | Headlines, welcome greetings, metric counts, page titles. The brand voice. | 800 only |
| **Plus Jakarta Sans** | `--font-sans` (default body font) | All body text, labels, buttons, descriptions, navigation items. The workhorse. | 400 (normal), 500 (medium), 600 (semibold) |
| **JetBrains Mono** | `--font-mono` | Code blocks, inline code, technical IDs, configuration values. | 400 |

### Type Scale

| Role | Font Family | Size | Weight | Line Height | Tailwind Shorthand | Usage |
|---|---|---|---|---|---|---|
| Page Title | Syne | 22–26px | 800 | 1.2 | `font-display text-[22px]` or `text-[26px]` | Welcome banners, page-level headings |
| Metric Count | Syne | 24px–2.5rem | 800 | 1.2 | `font-display text-2xl` or `.raava-stat-number` | Dashboard status counts, large numbers |
| Section Header | Plus Jakarta Sans | 15px | 600 | 1.4 | `text-[15px] font-semibold` | Card headers, section labels, "Active Work", "Recent Tasks" |
| Card Title | Plus Jakarta Sans | 18px | 600 | 1.4 | `text-lg font-semibold` | Team member names on detail pages |
| Dialog Title | Plus Jakarta Sans | 18px | 600 | 1.0 | `text-lg leading-none font-semibold` | Modal/dialog headings |
| Body | Plus Jakarta Sans | 13–15px | 400 | 1.5 | `text-sm` or `text-[15px]` | Paragraph text, descriptions |
| Label | Plus Jakarta Sans | 13px | 500 | 1.4 | `text-[13px] font-medium` | Form labels, metadata labels, nav items |
| Small / Caption | Plus Jakarta Sans | 11–12px | 500 | 1.4 | `text-xs font-medium` | Badges, timestamps, helper text, status labels |
| Tiny | Plus Jakarta Sans | 10px | 500 | 1.3 | `text-[10px] font-medium` | Tool tags in role cards, micro-labels |
| Code | JetBrains Mono | 14px | 400 | 1.5 | `font-mono text-sm` | Inline code, technical values |
| Markdown Body | Plus Jakarta Sans | 15px | 400 | 1.6 | `.raava-markdown` class | Long-form rendered markdown content |

### Tabular Numerals (Stripe-inspired)

All metric and financial data displays use tabular (monospaced) numerals for perfect column alignment. Plus Jakarta Sans supports the `tnum` OpenType feature.

- `.raava-stat-number` includes `font-variant-numeric: tabular-nums` automatically.
- For any other numeric display (tables, billing data, metric cards), apply `.raava-tabular-nums` or the Tailwind class `tabular-nums`.

```css
.raava-tabular-nums {
  font-feature-settings: "tnum";
  font-variant-numeric: tabular-nums;
}
```

### Font Loading

Fonts are loaded via `<link>` tags in `index.html`. The font-family declarations in `index.css`:

```css
--font-sans: 'Plus Jakarta Sans', sans-serif;
--font-mono: 'JetBrains Mono', monospace;
--font-display: 'Syne', sans-serif;
```

The `.font-display` utility class is defined in `index.css`:

```css
.font-display {
  font-family: Syne, system-ui, sans-serif;
  font-weight: 800;
}
```

---

## 4. Component Stylings

### Buttons

Buttons use `class-variance-authority` for variant management. Base classes shared by all variants:

```
inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md
text-sm font-medium transition-[color,background-color,border-color,box-shadow,opacity]
disabled:pointer-events-none disabled:opacity-50
focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]
aria-invalid:ring-destructive/20 aria-invalid:border-destructive
```

**Variants:**

| Variant | Classes | Usage |
|---|---|---|
| `default` | `bg-primary text-primary-foreground hover:bg-primary/90` | Standard actions. "Save", "Create", "Submit". |
| `gradient` | `text-white font-semibold hover:opacity-90 [background:linear-gradient(90deg,#224AE8,#716EFF,#00BDB7)]` | Hero CTAs. "Hire Team Member", "Get Started", primary onboarding actions. The signature Raava button. |
| `destructive` | `bg-destructive text-white hover:bg-destructive/90` Dark: `dark:bg-destructive/60` | Dangerous actions. "Delete", "Remove", "Cancel membership". |
| `outline` | `border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground` Dark: `dark:bg-input/30 dark:border-input dark:hover:bg-input/50` | Secondary actions. "Cancel", "Back", form actions alongside a primary button. |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-secondary/80` | Tertiary actions. Filter buttons, less important options. |
| `ghost` | `hover:bg-accent hover:text-accent-foreground` Dark: `dark:hover:bg-accent/50` | Inline actions. Table row actions, icon-only buttons in toolbars. |
| `link` | `text-primary underline-offset-4 hover:underline` | Text-style links styled as buttons. |

**Sizes:**

| Size | Classes | Use Case |
|---|---|---|
| `default` | `h-10 px-4 py-2 has-[>svg]:px-3` | Standard buttons. |
| `xs` | `h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5` | Compact inline actions, table row buttons. |
| `sm` | `h-9 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5` | Slightly smaller than default. Dialog actions. |
| `lg` | `h-10 rounded-md px-6 has-[>svg]:px-4` | Wider buttons. Hero CTAs with extra breathing room. |
| `icon` | `size-10` | Square icon-only buttons. |
| `icon-xs` | `size-6 rounded-md` | Small icon-only buttons. Inline actions. |
| `icon-sm` | `size-9` | Medium icon-only buttons. |
| `icon-lg` | `size-10` | Large icon-only buttons. |

**States (all variants):**
- **Disabled:** `opacity-50`, `pointer-events-none`
- **Focus visible:** 3px ring at `ring/50` opacity, border becomes `ring` color
- **Invalid (aria-invalid):** Ring becomes `destructive/20`, border becomes destructive

### Cards

Cards are the primary content container. The `raava-card` utility class (from `index.css`) provides the canonical styling:

```css
.raava-card {
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow:
    rgba(34, 42, 53, 0.08) 0px 0px 0px 1px,   /* ring-shadow border (Cal.com) */
    rgba(50, 50, 93, 0.12) 0px 4px 8px -2px,   /* brand-tinted ambient (Stripe) */
    rgba(0, 0, 0, 0.06) 0px 2px 4px -1px;       /* tight contact shadow (Cal.com) */
}
```

In dark mode, `.raava-card` uses `--border-default` and no shadow (shadows are invisible on dark backgrounds). See "Dark Mode Border Depth" below.

The shadcn `Card` component provides structural scaffolding:

```
bg-card text-card-foreground flex flex-col gap-6 border py-6 shadow-sm
```

**Card anatomy:**

| Part | Component | Default Classes | Notes |
|---|---|---|---|
| Container | `Card` | `bg-card text-card-foreground border py-6 shadow-sm` | Use `.raava-card` class for the Raava-branded 12px radius + shadow. |
| Header | `CardHeader` | `grid auto-rows-min gap-2 px-6` | Supports a `CardAction` slot for top-right buttons. |
| Title | `CardTitle` | `leading-none font-semibold` | Usually `text-[15px]` for section headers. |
| Description | `CardDescription` | `text-muted-foreground text-sm` | Subtitle text below the title. |
| Content | `CardContent` | `px-6` | The main content area. |
| Footer | `CardFooter` | `flex items-center px-6` | Action bar at the bottom of the card. |

**Card states:**
- **Default:** Three-layer composited shadow (ring + brand-tinted ambient + contact)
- **Hover (when interactive):** Add `.raava-card-hover` class for elevated brand-tinted shadow on hover
- **Dark mode:** Uses `--border-default` (`#2e2e2e`) border, no shadow. Add `.raava-card-subtle`, `.raava-card-prominent`, or `.raava-card-accent` for border depth variation.

**Card in the home page pattern** (inline `raava-card` usage):

```tsx
<div className="raava-card bg-white px-6 py-5 dark:bg-card">
  <h2 className="text-[15px] font-semibold text-foreground mb-4">Section Title</h2>
  {/* content */}
</div>
```

### Badges / Status Pills

Badges are `rounded-full` pills. The base component:

```
inline-flex items-center justify-center rounded-full border border-transparent
px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0
```

**Variants:**

| Variant | Classes |
|---|---|
| `default` | `bg-primary text-primary-foreground` |
| `secondary` | `bg-secondary text-secondary-foreground` |
| `destructive` | `bg-destructive text-white` Dark: `dark:bg-destructive/60` |
| `outline` | `border-border text-foreground` |
| `ghost` | Transparent background |

**Status-specific badges** use the color mappings from `lib/status-colors.ts` (see Section 2). Pattern:

```tsx
// Light mode
<span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
  Active
</span>

// With dark mode support
<span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300">
  Active
</span>
```

**Task status badges** (from RaavaHome) use a slightly different pill shape:

```tsx
<span className="rounded-xl px-2.5 py-1 text-[11px] font-medium bg-emerald-500/10 text-emerald-500">
  Done
</span>
```

### Inputs

```
border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1
text-base md:text-sm shadow-xs
placeholder:text-muted-foreground
```

**States:**
- **Default:** `border-input` (light gray border), transparent background
- **Focus:** `focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]` — 3px ring in primary color at 50% opacity
- **Invalid:** `aria-invalid:ring-destructive/20 aria-invalid:border-destructive` — red ring and border
- **Disabled:** `disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50`
- **Dark mode:** `dark:bg-input/30` — slight background tint
- **Selection:** `selection:bg-primary selection:text-primary-foreground`

### Status Dots

Small colored circles used as primary status indicators throughout the product.

**Standard size (team member cards, nav items):**

```tsx
<span className="h-2.5 w-2.5 rounded-full shrink-0 bg-emerald-500" />
```

**Small size (inline with text, active work lists):**

```tsx
<span className="h-1.5 w-1.5 rounded-full shrink-0 bg-emerald-500" />
```

**Animated running indicator (live activity):**

```tsx
<span className="relative flex h-2 w-2">
  <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
</span>
```

**Issue status circles (bordered rings, not filled):**

```tsx
<span className="relative inline-flex h-4 w-4 rounded-full border-2 shrink-0 text-green-600 border-green-600 dark:text-green-400 dark:border-green-400">
  {/* For "done" status, add inner filled circle: */}
  <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
</span>
```

### Navigation Items (Sidebar)

The `RaavaNavItem` component defines the sidebar navigation pattern:

```tsx
// Container
"relative flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"

// Active state
"bg-[rgba(34,74,232,0.08)] font-semibold text-[#224AE8]"
// Dark active: "dark:bg-[rgba(34,74,232,0.15)] dark:text-[#6B8AFF]"

// Inactive state
"text-muted-foreground hover:bg-accent/50 hover:text-foreground"
```

**Active indicator:** A 3px-wide gradient bar on the left edge:

```tsx
<span
  className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full"
  style={{ background: "var(--raava-gradient)" }}
/>
```

**Nav badge (count):**

```tsx
<span className="ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none bg-primary text-primary-foreground">
  {count}
</span>
```

**Nav alert dot:**

```tsx
<span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
```

**Live count indicator (pulsing dot + count):**

```tsx
<span className="ml-auto flex items-center gap-1.5">
  <span className="relative flex h-2 w-2">
    <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
  </span>
  <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
    {count} live
  </span>
</span>
```

### Filter Tabs (Pill Style)

Used for status filtering on list pages. Pattern from RaavaHome task status badges:

```tsx
// Active tab
"bg-foreground text-background rounded-full px-4 py-2 text-sm font-medium"

// Inactive tab
"bg-secondary text-muted-foreground rounded-full px-4 py-2 text-sm font-medium hover:bg-secondary/80"
```

### Team Member Cards

Grid cards displaying team member information. Pattern from the Agents/Team page:

```tsx
<div className="raava-card bg-white px-6 py-5 dark:bg-card transition-shadow hover:shadow-md">
  {/* Avatar */}
  <div
    className="flex items-center justify-center h-11 w-11 rounded-full font-display text-sm"
    style={{ backgroundColor: avatarColor.bg, color: avatarColor.text }}
  >
    {initials}
  </div>

  {/* Name + Role */}
  <h3 className="text-lg font-semibold text-foreground">{name}</h3>
  <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
    {role}
  </span>

  {/* Status dot + label */}
  <div className="flex items-center gap-2">
    <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", dotClass)} />
    <span className="text-[13px] font-medium text-foreground">{statusLabel}</span>
  </div>
</div>
```

**Avatar colors** (deterministic based on name hash):

```ts
const AVATAR_COLORS = [
  { bg: "rgba(34,74,232,0.15)", text: "#224ae8" },
  { bg: "rgba(113,110,255,0.15)", text: "#716eff" },
  { bg: "rgba(73,92,244,0.15)", text: "#495cf4" },
  { bg: "rgba(140,51,217,0.15)", text: "#8c33d9" },
  { bg: "rgba(229,140,26,0.15)", text: "#e58c1a" },
  { bg: "rgba(26,166,153,0.15)", text: "#1aa699" },
];
```

### Welcome Banner

The home page hero section. Gradient overlay on rounded container:

```tsx
<div
  className="relative overflow-hidden rounded-2xl border border-border/50 px-8 py-7"
  style={{
    background: "linear-gradient(135deg, rgba(34,74,232,0.06) 0%, rgba(113,110,255,0.04) 50%, rgba(0,189,183,0.06) 100%)"
  }}
>
  <h1 className="font-display text-[22px] text-foreground">
    Good morning, {userName}.
  </h1>
  <p className="text-[15px] text-muted-foreground mt-2">
    Here's your team's status.
  </p>
</div>
```

Note: The gradient is extremely subtle — 4-6% opacity. This is not a bold gradient banner. It's a whisper of brand color.

### Status Cards (Metric Strip)

Three-column metric cards on the home page:

```tsx
<div className="grid grid-cols-3 gap-4">
  <Link
    to={route}
    className="raava-card flex flex-1 items-center gap-3 bg-white px-5 py-4 transition-colors hover:bg-accent/30 no-underline text-inherit dark:bg-card"
  >
    <span className="h-2.5 w-2.5 rounded-full shrink-0 bg-emerald-500" />
    <span className="font-display text-2xl text-foreground">{count}</span>
    <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
  </Link>
</div>
```

### Tables

Simple table styling with border-bottom dividers:

```tsx
{items.map((item, idx) => (
  <div
    className={cn(
      "flex items-center justify-between py-3",
      idx < items.length - 1 && "border-b border-border"
    )}
  >
    {/* Row content */}
  </div>
))}
```

**Hover state:** Add `hover:bg-muted/50` on interactive table rows.

### Dialogs / Modals

Built on Radix Dialog primitives.

**Overlay:**

```
fixed inset-0 z-50 bg-black/50
```

**Content:**

```
bg-background fixed top-[max(1rem,env(safe-area-inset-top))] md:top-[50%]
left-[50%] z-50 w-full max-w-[calc(100%-2rem)] translate-x-[-50%]
gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg
```

**Animations:**
- Open: `fade-in-0 zoom-in-[0.97] slide-in-from-top-[1%]`
- Close: `fade-out-0 zoom-out-[0.97] slide-out-to-top-[1%]`
- Duration: 150ms, `cubic-bezier(0.16, 1, 0.3, 1)`

**Expandable dialogs** transition `max-width` with:

```css
[data-slot="dialog-content"] {
  transition: max-width 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

### Tooltips

```
bg-foreground text-background z-50 rounded-md px-3 py-1.5 text-xs text-balance
```

Tooltips use a foreground-on-background scheme (dark tooltip on light mode, light tooltip on dark mode). Arrow: `size-2.5 fill-foreground rounded-[2px]`.

**Animations:** `animate-in fade-in-0 zoom-in-95` with slide directional variants.

### Onboarding Wizard Steps

Circular step indicators connected by lines:

```tsx
// Active step (current)
"flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold
 bg-gradient-to-r from-[#224AE8] via-[#716EFF] to-[#00BDB7] text-white shadow-md"

// Completed step
"flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold
 bg-[#00BDB7] text-white"

// Future step
"flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold
 border border-border text-muted-foreground bg-muted/30"

// Connecting line (completed)
"w-8 h-0.5 rounded-full bg-[#00BDB7]"

// Connecting line (incomplete)
"w-8 h-0.5 rounded-full bg-border"
```

### Role Selection Cards

Used in the onboarding wizard for selecting team member roles:

```tsx
// Base
"relative flex flex-col items-start gap-3 rounded-xl border p-5 text-left
 transition-all duration-200 hover:shadow-md bg-card"

// Selected
"border-2 border-transparent shadow-lg ring-2 ring-[#00BDB7]"
// With gradient border effect via backgroundImage

// Unselected
"border-border hover:border-[#716EFF]/40"
```

**Selected state** uses a CSS gradient border trick:

```tsx
style={{
  backgroundImage: "linear-gradient(var(--color-card), var(--color-card)), linear-gradient(135deg, #224AE8, #716EFF, #00BDB7)",
  backgroundOrigin: "border-box",
  backgroundClip: "padding-box, border-box",
}}
```

**Selected checkmark:** `w-5 h-5 rounded-full bg-[#00BDB7] text-white` in top-right corner.

**Role icon container:**
- Selected: `bg-gradient-to-br from-[#224AE8] to-[#00BDB7] text-white`
- Unselected: `bg-muted text-muted-foreground`

---

## 5. Layout Principles

### Page Structure

Every page follows the sidebar + content pattern:

```
┌──────────┬────────────────────────────────────────────┐
│          │                                            │
│  Sidebar │  Content Area                              │
│  240px   │  flex-1, p-6 to p-8                       │
│  fixed   │                                            │
│          │  ┌────────────────────────────────────┐    │
│          │  │  Welcome Banner / Page Title        │    │
│          │  └────────────────────────────────────┘    │
│          │                                            │
│          │  ┌──────┐ ┌──────┐ ┌──────┐              │
│          │  │ Metric│ │Metric│ │Metric│              │
│          │  └──────┘ └──────┘ └──────┘              │
│          │                                            │
│          │  ┌──────────────────┐ ┌────────┐         │
│          │  │  Content Card    │ │ Side   │         │
│          │  │                  │ │ Card   │         │
│          │  └──────────────────┘ └────────┘         │
│          │                                            │
└──────────┴────────────────────────────────────────────┘
```

### Spacing System

Tailwind's 4px base scale. The most commonly used gaps and padding:

| Spacing | Value | Usage |
|---|---|---|
| `gap-1` / `p-1` | 4px | Tight inline spacing. Popover content padding. |
| `gap-1.5` | 6px | Icon-to-text in badges, small component internal spacing. |
| `gap-2` | 8px | Standard icon-to-text gap. Form field label-to-input. |
| `gap-2.5` | 10px | Nav item icon-to-label gap. |
| `gap-3` | 12px | Status card dot-to-number gap. |
| `gap-4` | 16px | Metric card grid gap. Dialog internal gap. |
| `gap-5` | 20px | Card grid gap. Major section content spacing. |
| `gap-6` | 24px | Card internal vertical gap (between header, content, footer). |
| `p-5` | 20px | Card content padding (when using `raava-card` directly). |
| `p-6` | 24px | Standard page padding. Card header/content `px-6`. Dialog padding. |
| `p-8` | 32px | Welcome banner horizontal padding. |
| `py-7` | 28px | Welcome banner vertical padding. |

### Grid Patterns

**Team member cards:**

```tsx
<div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
  {/* Cards */}
</div>
```

**Metric cards (status strip):**

```tsx
<div className="grid grid-cols-3 gap-4">
  {/* StatusCard x3 */}
</div>
```

**Two-column layout (content + sidebar card):**

```tsx
<div className="flex gap-5">
  <div className="flex-1">{/* Main content */}</div>
  <div className="w-[280px] shrink-0">{/* Side panel */}</div>
</div>
```

**Page-level vertical rhythm:**

```tsx
<div className="space-y-6">
  {/* Welcome banner */}
  {/* Metric strip */}
  {/* Content sections */}
</div>
```

### Border Radius Scale

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | 6px (0.375rem) | Small elements, checkboxes |
| `--radius-md` | 8px (0.5rem) | Buttons, inputs, badges |
| `--radius-lg` | 12px (0.75rem) | Cards (`raava-card`), dropdowns |
| `--radius-xl` | 16px (1rem) | Role selection cards, special containers |
| `rounded-2xl` | 16px | Welcome banner |
| `rounded-full` | 9999px | Badges, status dots, pills, avatar circles |

---

## 6. Depth & Elevation

Raava uses a minimal elevation system. Depth is communicated through subtle combinations of border and shadow, not dramatic drop shadows.

| Level | Element | Shadow | Border | Notes |
|---|---|---|---|---|
| 0 | Page background | None | None | `oklch(0.99 0 0)`. The ground plane. |
| 1 | Cards (resting) | Three-layer composited: ring-shadow + brand-tinted ambient + contact | `1px solid var(--border)` | The `raava-card` default. Ring provides structure, blue-tinted ambient adds brand warmth, tight contact shadow grounds the card. |
| 1.5 | Inputs | `shadow-xs` | `1px solid var(--input)` | Even subtler than cards. |
| 2 | Cards (hover) | Elevated brand-tinted: wider spread, deeper blue-gray tint | `1px solid var(--border)` | Applied via `.raava-card-hover`. Stripe-inspired brand-colored elevation. |
| 3 | Dialogs/Modals | `shadow-lg` | `1px solid var(--border)` | Over `bg-black/50` overlay. The highest standard elevation. |
| 3 | Popovers/Dropdowns | `shadow-lg` | `1px solid var(--border)` | Same level as dialogs. |
| 4 | Tooltips | Inherits from Radix | None | Tooltips use `bg-foreground text-background` — color contrast, not shadow, provides the elevation cue. |

### Dark Mode Border Depth Hierarchy (Supabase-inspired)

In dark mode, shadows are invisible. Depth is communicated through progressive border lightening instead:

| Tier | Token | Value | Usage | Utility Class |
|---|---|---|---|---|
| Recessed | `--border-subtle` | `#242424` | Background elements, secondary containers | `.raava-border-subtle` |
| Standard | `--border-default` | `#2e2e2e` | Standard card borders (default for `.raava-card` in dark mode) | `.raava-border-default` |
| Prominent | `--border-prominent` | `#363636` | Interactive/focused elements, hovered cards | `.raava-border-prominent` |
| Accent | `--border-accent` | `rgba(34, 74, 232, 0.3)` | Highlighted/selected cards, active states | `.raava-border-accent` |

In light mode, all border utilities fall back to `var(--border)` so they are safe to use unconditionally.

### Focus Rings

Focus rings are the accessibility elevation layer:

```
focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring
```

3px wide, primary color at 50% opacity, with border color change. Consistent across all interactive elements.

### Gradient Shadow (Gradient Button)

The gradient button has a unique shadow that reinforces the brand:

```css
shadow-[0_4px_16px_rgba(34,74,232,0.2)]
```

This should only appear on the gradient button variant, never on other elements.

### Dark Mode Scrollbars

Custom scrollbar styling in dark mode:

```css
.dark *::-webkit-scrollbar-track { background: oklch(0.205 0 0); }
.dark *::-webkit-scrollbar-thumb { background: oklch(0.4 0 0); border-radius: 4px; }
.dark *::-webkit-scrollbar-thumb:hover { background: oklch(0.5 0 0); }
```

---

## 7. Do's and Don'ts

### DO

- **Use human language.** "Team Members" not "Agents." "Tasks" not "Issues." "Hire" not "Provision." "Working" not "Running." "Needs Attention" not "Error." The user is managing people, not infrastructure.
- **Use the brand gradient sparingly.** It belongs on: the primary CTA button, the active sidebar indicator bar, completed wizard steps, and `.raava-stat-number` displays. Nowhere else.
- **Use status dots as the primary status indicator.** Small colored circles (`h-2 w-2` or `h-2.5 w-2.5 rounded-full`) are how status is communicated at a glance. Badges provide detail when space allows.
- **Use card-based layouts for entity lists.** Team members, tasks, and similar entities live in card grids, not dense tables.
- **Use Plus Jakarta Sans for all body text.** Syne is display-only — weight 800, headlines and metric counts. Never use Syne for body text, labels, or buttons.
- **Use the pill-style filter tabs** (`rounded-full px-4 py-2`) for status filtering on list pages.
- **Use `rounded-full` for badges and status pills.** All badges and status indicators are pill-shaped.
- **Keep cards at 12px border-radius** (`rounded-lg` or `.raava-card`). Consistency matters.
- **Use oklch for all theme tokens.** The entire color system is built on oklch. Do not introduce hex values into CSS custom properties.
- **Animate running/live status** with `animate-pulse` on the status dot.
- **Use the `raava-card` utility class** when building card surfaces. It provides the canonical `border-radius: 12px`, `border`, and `box-shadow`.
- **Support both light and dark modes.** Every component must work in both. Use the `dark:` variant prefix for dark mode overrides.
- **Use `border-b border-border`** for table row dividers, not full grid borders.
- **Use `text-muted-foreground`** for all secondary/helper text, timestamps, and descriptions.
- **Preserve touch targets.** The CSS enforces `min-height: 44px` on interactive elements when `pointer: coarse`. Do not override this.
- **Use `text-balance`** on tooltips and short heading text for better line breaks.

### DON'T

- **Don't use developer terminology.** No "Agent," "Issue," "Adapter," "Provision," "SOUL.md," "Run," "heartbeat," "container." If a technical concept must be surfaced, translate it to business language first.
- **Don't apply the gradient to large surfaces.** No gradient backgrounds on cards, panels, pages, or sections. The gradient is for small, high-impact elements only.
- **Don't use Syne for body text or labels.** Syne at weight 800 is a display typeface. Using it for paragraphs, form labels, or navigation text is wrong.
- **Don't use pure black (`#000`) or pure white (`#fff`) for backgrounds.** Always use the oklch theme tokens. `oklch(0.99 0 0)` is not white. `oklch(0.15 0 0)` is not black. This is intentional.
- **Don't show technical configuration in primary views.** Adapter types, API keys, model names, token counts, infrastructure terms — these belong in Settings tabs, not in dashboard views or team member cards.
- **Don't use heavy shadows or dramatic elevation.** This is a flat, minimal design. `shadow-lg` is the maximum, and it's reserved for modals and popovers. Cards use barely-perceptible shadows.
- **Don't mix status color semantics.** Green is always positive (active, success, done). Red is always negative (error, attention, failed, blocked). Yellow/amber is always warning or waiting (idle, paused, pending). Never use green for a warning or red for success.
- **Don't show raw technical data to the user.** No token counts, model identifiers (`claude-3.5-sonnet`), run IDs, adapter names, or infrastructure metrics in user-facing views.
- **Don't use bordered/outlined status badges.** Status badges use the filled `bg-{color}-100 text-{color}-700` pattern, not outlined variants.
- **Don't break the `raava-card` pattern.** All cards should have consistent `12px` radius, `1px` border, and the subtle shadow. No cards with `rounded-xl`, no cards with `shadow-lg`, no cards without borders.
- **Don't inline styles for theme colors.** Use CSS custom properties and Tailwind classes. The only acceptable inline styles are for the brand gradient (which doesn't have a Tailwind utility) and avatar background colors (which are dynamic).
- **Don't use `shadow-[0_4px_16px_rgba(34,74,232,0.2)]`** on anything other than the gradient button.
- **Don't add animations** beyond `animate-pulse` on live status dots and the standard dialog/tooltip transitions. The product is calm, not flashy.

---

## 8. Responsive Behavior

### Breakpoints

Standard Tailwind breakpoints:

| Breakpoint | Width | Key Layout Changes |
|---|---|---|
| Default (mobile) | < 640px | Single-column layouts. Sidebar hidden. |
| `sm` | 640px | Team card grid becomes 2 columns. |
| `md` | 768px | Input text scales from `text-base` to `text-sm`. Dialogs center vertically. |
| `lg` | 1024px | Sidebar visible by default. |
| `xl` | 1280px | Team card grid becomes 3 columns. |

### Sidebar

- **Desktop (lg+):** Fixed 240px left sidebar, always visible.
- **Mobile (< lg):** Sidebar collapses. Accessed via hamburger menu or bottom nav.
- **Mobile bottom nav:** Key navigation items surface in a `MobileBottomNav` component.
- **Clicking a nav item on mobile** closes the sidebar automatically.

### Touch Targets

Enforced globally via CSS media query:

```css
@media (pointer: coarse) {
  button, [role="button"], input, select, textarea, [data-slot="select-trigger"] {
    min-height: 44px;
  }
}
```

Toggle elements (`[data-slot="toggle"]`) are exempt (`min-height: 0`).

### Grid Behavior

**Team member cards:**
- Mobile: `grid-cols-1` (stacked)
- `sm` (640px+): `grid-cols-2`
- `xl` (1280px+): `grid-cols-3`

**Metric cards:**
- Desktop: `grid-cols-3`
- Mobile: Stack vertically (add `sm:grid-cols-3 grid-cols-1`)

**Content + sidebar layout (`flex gap-5`):**
- Desktop: Side-by-side
- Mobile: Stack, side panel goes full width

### Dialog Responsiveness

- Mobile: Anchored to top with `top-[max(1rem,env(safe-area-inset-top))]`, `max-w-[calc(100%-2rem)]`
- Desktop (`md`+): Centered vertically at `top-[50%] translate-y-[-50%]`, `max-w-lg`
- Footer buttons: `flex-col-reverse` on mobile, `flex-row sm:justify-end` on desktop

### Welcome Banner

Responsive padding and text sizing:
- Mobile: Reduce to `px-5 py-5`, title to `text-[18px]`
- Desktop: Full `px-8 py-7`, title at `text-[22px]`

---

## 9. Agent Prompt Guide

Quick reference for AI coding agents building new pages or components. Copy-paste ready.

### Color Quick Reference

| Name | Light Mode | Dark Mode | Usage |
|---|---|---|---|
| Brand Blue | `#224AE8` / `oklch(0.48 0.22 264)` | `oklch(0.55 0.24 285)` | Primary actions, links, focus rings |
| Brand Teal | `#00BDB7` / `oklch(0.72 0.14 185)` | Same | Accent, selection, completions |
| Brand Gradient | `linear-gradient(90deg, #224AE8, #716EFF, #00BDB7)` | Same | Hero CTA, nav accent bar, stat numbers |
| Background | `oklch(0.99 0 0)` | `oklch(0.15 0 0)` | Page canvas |
| Foreground | `oklch(0.15 0 0)` | `oklch(0.985 0 0)` | Primary text |
| Muted Text | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | Secondary text, descriptions |
| Border | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | All borders |
| Destructive | `oklch(0.577 0.245 27.325)` | `oklch(0.637 0.237 25.331)` | Errors, destructive actions |

### Font Quick Reference

```tsx
// Page title
<h1 className="font-display text-[22px] text-foreground">Title</h1>

// Section header
<h2 className="text-[15px] font-semibold text-foreground">Section</h2>

// Metric number
<span className="font-display text-2xl text-foreground">{count}</span>

// Body text
<p className="text-sm text-foreground">Body text</p>

// Secondary text
<p className="text-[13px] text-muted-foreground">Helper text</p>

// Code / technical
<code className="font-mono text-sm">{value}</code>
```

### Common Component Patterns

**Raava-branded card:**

```tsx
<div className="raava-card bg-white px-6 py-5 dark:bg-card">
  <h2 className="text-[15px] font-semibold text-foreground mb-4">Title</h2>
  {/* content */}
</div>
```

**Status dot + label:**

```tsx
<div className="flex items-center gap-2">
  <span className="h-2.5 w-2.5 rounded-full shrink-0 bg-green-400" />
  <span className="text-[13px] font-medium text-foreground">Working</span>
</div>
```

**Status badge:**

```tsx
<span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300">
  Active
</span>
```

**Gradient button (hero CTA):**

```tsx
<Button variant="gradient" size="lg">
  Hire Team Member
</Button>
```

**Welcome banner:**

```tsx
<div
  className="relative overflow-hidden rounded-2xl border border-border/50 px-8 py-7"
  style={{
    background: "linear-gradient(135deg, rgba(34,74,232,0.06) 0%, rgba(113,110,255,0.04) 50%, rgba(0,189,183,0.06) 100%)"
  }}
>
  <h1 className="font-display text-[22px] text-foreground">
    Good morning, {name}.
  </h1>
  <p className="text-[15px] text-muted-foreground mt-2">
    Here's your team's status.
  </p>
</div>
```

**Metric strip (3-column status cards):**

```tsx
<div className="grid grid-cols-3 gap-4">
  {[
    { label: "Active", count: 3, color: "bg-emerald-500", to: "/team/active" },
    { label: "Idle", count: 1, color: "bg-gray-400", to: "/team/idle" },
    { label: "Needs Attention", count: 0, color: "bg-red-500", to: "/team/attention" },
  ].map((s) => (
    <Link
      key={s.label}
      to={s.to}
      className="raava-card flex flex-1 items-center gap-3 bg-white px-5 py-4 transition-colors hover:bg-accent/30 no-underline text-inherit dark:bg-card"
    >
      <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", s.color)} />
      <span className="font-display text-2xl text-foreground">{s.count}</span>
      <span className="text-[13px] font-medium text-muted-foreground">{s.label}</span>
    </Link>
  ))}
</div>
```

**Table row with divider:**

```tsx
<div className={cn("flex items-center justify-between py-3", !isLast && "border-b border-border")}>
  <span className="text-[13px] font-medium text-foreground">{title}</span>
  <span className="rounded-xl px-2.5 py-1 text-[11px] font-medium bg-emerald-500/10 text-emerald-500">
    Done
  </span>
</div>
```

**Avatar circle (deterministic color):**

```tsx
<div
  className="flex items-center justify-center h-11 w-11 rounded-full font-display text-sm"
  style={{ backgroundColor: "rgba(34,74,232,0.15)", color: "#224ae8" }}
>
  AK
</div>
```

### Status Color Quick Mapping

| Status | Dot | Badge (Light) | Human Label |
|---|---|---|---|
| Active/Working | `bg-green-400` | `bg-green-100 text-green-700` | "Working" |
| Running (live) | `bg-cyan-400 animate-pulse` | `bg-cyan-100 text-cyan-700` | "Running" |
| Idle | `bg-yellow-400` | `bg-yellow-100 text-yellow-700` | "Idle" |
| Paused | `bg-yellow-400` | `bg-orange-100 text-orange-700` | "Paused" |
| Error | `bg-red-400` | `bg-red-100 text-red-700` | "Needs Attention" |
| Archived | `bg-neutral-400` | `bg-muted text-muted-foreground` | "Archived" |
| Pending | `bg-amber-400` | `bg-amber-100 text-amber-700` | "Waiting for Approval" |

### When Building a New Page

Follow this checklist:

1. **Wrap content in the sidebar layout.** The page renders inside the main content area, which already has the sidebar. Your page component just returns its content.

2. **Set breadcrumbs.** Every page should call `useBreadcrumbs()` in a `useEffect`:
   ```tsx
   const { setBreadcrumbs } = useBreadcrumbs();
   useEffect(() => {
     setBreadcrumbs([{ label: "Page Name" }]);
   }, [setBreadcrumbs]);
   ```

3. **Use `space-y-6` for page-level vertical rhythm.** Wrap your page content in `<div className="space-y-6">`.

4. **Add a page title in Syne.** Either a welcome banner or a simple heading:
   ```tsx
   <h1 className="font-display text-[22px] text-foreground">Page Title</h1>
   ```

5. **Use card-based content sections.** Wrap logical groups in `raava-card`:
   ```tsx
   <div className="raava-card bg-white px-6 py-5 dark:bg-card">
   ```

6. **Apply Raava terminology.** Review your copy. Replace "Agent" with "Team Member," "Issue" with "Task," etc. See the Do's and Don'ts section.

7. **Include status indicators** using the dot + badge system from `lib/status-colors.ts`. Import `agentStatusDot`, `statusBadge`, or `priorityColor` as needed.

8. **Use `PageSkeleton`** for loading states. Import from `components/PageSkeleton`:
   ```tsx
   if (isLoading) return <PageSkeleton variant="dashboard" />;
   ```

9. **Handle errors** with the destructive card pattern:
   ```tsx
   <div className="raava-card bg-destructive/5 p-6 text-center">
     <AlertTriangle className="mx-auto h-8 w-8 text-destructive mb-2" />
     <p className="text-sm font-medium text-destructive">Failed to load data</p>
     <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
   </div>
   ```

10. **Test both light and dark modes.** Toggle `.dark` on the root element and verify all text is legible, borders are visible, and cards have appropriate contrast.

### File Locations

| What | Where |
|---|---|
| CSS tokens & utilities | `ui/src/index.css` |
| UI primitives (Button, Card, etc.) | `ui/src/components/ui/` |
| Status color mappings | `ui/src/lib/status-colors.ts` |
| Raava nav item | `ui/src/components/RaavaNavItem.tsx` |
| Onboarding wizard | `ui/src/components/RaavaOnboardingWizard.tsx` |
| Page components | `ui/src/pages/` |
| Utility functions (`cn`, etc.) | `ui/src/lib/utils.ts` |
| Query keys | `ui/src/lib/queryKeys.ts` |
| API clients | `ui/src/api/` |
| Context providers | `ui/src/context/` |

### Animation Reference

The product uses exactly three motion patterns:

1. **Status pulse:** `animate-pulse` on live/running status dots only.
2. **Dialog transitions:** `150ms cubic-bezier(0.16, 1, 0.3, 1)` — fade + subtle zoom + slide.
3. **Activity row entry:** Custom `dashboard-activity-enter` keyframe — `520ms` with blur-in and scale, plus `920ms` highlight fade. Only used on the dashboard activity feed. Respects `prefers-reduced-motion: reduce`.

No other animations. No page transitions. No hover animations beyond color/shadow transitions. The product is calm.
