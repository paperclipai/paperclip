# Paperclip UI Rewrite — HeroUI v3

**Date:** 2026-04-05
**Status:** Draft
**Scope:** Complete UI rebuild using HeroUI v3, optimized for non-technical executives, with Electron native integration and full responsiveness.

---

## Context

Paperclip's current UI is built on shadcn/ui (Radix primitives) with Tailwind CSS v4 and oklch colors. It serves ~42 pages across 12 top-level navigation items. While functional, the UI is developer-oriented, dense, and lacks the premium feel needed for non-technical executive operators who govern AI agent companies.

This is a **big bang replacement** — not an incremental migration. We rebuild every component and page from scratch using HeroUI v3, while preserving the existing data layer (API clients, TanStack Query hooks, contexts, WebSocket system, router structure).

### What We Keep
- All API clients (`ui/src/api/*.ts`)
- TanStack Query setup and query keys (`ui/src/lib/queryKeys.ts`)
- React contexts (Company, LiveUpdates, Theme, Dialog, etc.)
- Custom hooks (`ui/src/hooks/`)
- WebSocket real-time system (`ui/src/context/LiveUpdatesProvider.tsx`)
- Router structure and URL patterns (`ui/src/App.tsx` — routes preserved, components replaced)
- Lib utilities (`ui/src/lib/`)
- Adapter UI modules (`ui/src/adapters/`)
- Plugin system (`ui/src/plugins/`)

### What We Rebuild
- Every page component (`ui/src/pages/*.tsx`)
- Every UI component (`ui/src/components/`)
- Layout shell, sidebar, navigation
- CSS/theme system (`ui/src/index.css`)
- Motion/animation system
- Mobile responsive layouts
- Electron titlebar integration

---

## Design Decisions

| Decision | Choice |
|----------|--------|
| Target persona | Non-technical executive/operator |
| Theme | System default + user toggle (light/dark/system) |
| Visual style | Soft & rounded (16px radius, soft shadows, Apple/Notion) |
| Navigation (Electron) | Sidebar + native titlebar (traffic lights in sidebar) |
| Navigation (Web) | Sidebar-only |
| IA structure | Grouped categories (Overview, Work, Team, Operations) |
| Dashboard | Action-first (needs attention) + live activity feed |
| Motion | Apple-level: spring physics, purposeful micro-interactions |
| Responsiveness | Fully responsive — desktop, tablet, mobile first-class |
| Component library | HeroUI v3 (beta) — 70 components, compound pattern |

---

## Tech Stack Changes

### Remove
- `@radix-ui/*` (all Radix primitives)
- `class-variance-authority` (CVA)
- `cmdk` (command palette)
- All shadcn/ui components in `ui/src/components/ui/`

### Add
- `@heroui/react` + `@heroui/styles` — component library
- `framer-motion` — Apple-level animations (spring physics, layout animations, AnimatePresence)
- `next-themes` or custom theme provider — system/light/dark toggle

### Keep
- `tailwindcss` v4
- `@tailwindcss/vite`
- `lucide-react` — icons
- `@tanstack/react-query`
- `react-router`
- `recharts` — charts
- `@mdxeditor/editor` — markdown editing

---

## Theme System

### Approach
Create a custom Paperclip theme for HeroUI using CSS variables. Two variants: `paperclip` (light) and `paperclip-dark` (dark). System preference detection as default.

### Key Design Tokens
```
--radius: 1rem            (16px — soft & rounded)
--field-radius: 1.5rem    (24px — extra soft inputs)
--accent: indigo           (primary brand color)
--surface-shadow: soft     (subtle elevation)
```

### Theme Toggle
Three-state toggle: System (default) → Light → Dark. Uses `prefers-color-scheme` media query for system detection. Persisted to localStorage.

---

## Information Architecture

### Sidebar Groups

**Overview**
- Dashboard (with badge count for items needing attention)
- Activity
- Inbox (with unread count)

**Work**
- Issues
- Projects
- Goals

**Team**
- Agents
- Skills

**Operations**
- Approvals (with pending count)
- Costs
- Routines
- Artifacts

### Sidebar Structure
- **Header**: Company avatar + name + company switcher dropdown
- **Search**: Inline search bar (opens command palette on focus)
- **Groups**: Collapsible category groups with section labels
- **Footer**: User avatar + name + settings gear + theme toggle

### Electron Desktop
- Frameless window with custom titlebar
- macOS traffic lights integrated into sidebar header (78px left padding)
- Sidebar header doubles as window drag region
- `app-region: drag` on titlebar area, `no-drag` on interactive elements

### Mobile (< 768px)
- Sidebar hidden, accessible via hamburger or swipe gesture
- Bottom tab bar: Home, Issues, Agents, Inbox, More
- "More" opens full navigation sheet
- Safe area inset support for notched devices

### Tablet (768px — 1024px)
- Collapsible sidebar (icon-only mode)
- No bottom tab bar
- Properties panel as overlay sheet instead of inline

---

## Page Designs

### Dashboard
**Layout:** Single column, scrollable

1. **Attention Bar** — Horizontal cards for items needing action:
   - Pending approvals (count + "Review" CTA)
   - Budget alerts (threshold warnings)
   - Agent errors (count + "Investigate" CTA)
   - Blocked tasks
   - Each card is dismissible or actionable
   - Animated entrance (staggered fade-in from left)

2. **KPI Strip** — 4 metric cards in a row:
   - Active agents (with running/idle breakdown)
   - Open tasks (with velocity sparkline)
   - Today's spend (with budget utilization bar)
   - Completion rate (with trend arrow)
   - Cards use HeroUI `Surface` with soft shadow

3. **Live Activity Feed** — Real-time scrolling feed:
   - Agent actions, task completions, status changes
   - Each entry: avatar + actor + action + target + timestamp
   - New items animate in with spring physics (slide down + fade)
   - Grouped by time (Just now, Earlier today, Yesterday)
   - Infinite scroll with skeleton loading

4. **Plugin Widget Slots** — Grid for plugin-injected widgets

### Issues (Tasks)
**Layout:** List view with filters

- Filter bar: Status, assignee, project, priority (HeroUI Select/Chip components)
- Grouped by status with collapsible sections
- Each row: priority indicator + ID + title + assignee avatar + status chip + date
- Click opens issue detail (right panel on desktop, full page on mobile)
- Bulk actions toolbar (appears on selection)
- New issue: Modal dialog with form
- Animated list: staggered entrance, smooth reorder on filter change

### Issue Detail
**Layout:** Two-column on desktop (content + properties panel)

- Left: Title (inline editable), description (markdown editor), comments thread, attachments
- Right (Properties Panel): Status, priority, assignee, project, parent task, dates, custom fields
- Comments: Threaded with avatar, timestamp, markdown support
- Animated tab transitions for sub-sections

### Agents
**Layout:** Card grid (desktop) / list (mobile)

- Each card: Avatar + name + role + status indicator (running/idle/error/paused)
- Status uses animated pulse for running agents
- Click opens agent detail page
- Agent detail: tabs for Overview, Heartbeats, Issues, Costs
- Heartbeat view: live terminal-style output with auto-scroll

### Projects
**Layout:** Card grid with progress indicators

- Each card: Name + description + issue count + progress bar + member avatars
- Click opens project detail with filtered issues view

### Goals
**Layout:** Tree view with progress

- Hierarchical goal tree (parent → child goals)
- Each node: title + progress percentage + status
- Expandable/collapsible with smooth animation
- Progress bars use HeroUI ProgressBar with accent color

### Approvals
**Layout:** Card list

- Each card: Type (hire/strategy/budget) + requester + summary + timestamp
- Action buttons: Approve (accent) + Reject (danger) + Request Changes
- Animated card removal on action (exit animation)

### Costs
**Layout:** Dashboard-style with charts

- Summary cards: Total spend, budget remaining, projected monthly
- Breakdown chart by agent (bar chart)
- Breakdown by model (pie/donut chart)
- Time series chart (line chart, 30-day)
- Uses recharts with HeroUI theme colors

### Activity
**Layout:** Timeline feed

- Full activity log with filters (by agent, by type, by date)
- Timeline visualization with connected dots
- Each entry expandable for details

### Inbox
**Layout:** Email-style list

- Tabs: Mine, Recent, Unread, All
- Each item: icon + title + preview + timestamp + read/unread indicator
- Click opens detail inline or navigates to source

### Settings Pages
- Clean form layouts using HeroUI Form, Input, Select, Switch
- Grouped into sections with Separator
- Save button with loading state
- Toast notifications on save

### Auth Pages
- Centered card layout
- Logo + title + form
- Animated entrance (scale + fade)
- Support for email/password, invite links, bootstrap mode

---

## Motion System

### Philosophy
Every animation communicates something. No decorative motion. Apple's principles: responsive, natural, contextual.

### Primitives (Framer Motion)
```typescript
// Standard transitions
const spring = { type: "spring", stiffness: 300, damping: 30 }
const gentleSpring = { type: "spring", stiffness: 200, damping: 25 }
const snappy = { type: "spring", stiffness: 500, damping: 35 }

// Page transitions
const pageEnter = { opacity: 1, y: 0, transition: gentleSpring }
const pageExit = { opacity: 0, y: 8, transition: { duration: 0.15 } }

// List item stagger
const stagger = { staggerChildren: 0.04 }
const itemEnter = { opacity: 1, y: 0 }
const itemExit = { opacity: 0, y: -4 }
```

### Where Motion Applies
- **Page transitions**: Fade + subtle Y shift on route change
- **List items**: Staggered entrance on initial load and filter changes
- **Cards**: Scale on hover (1.01), press (0.98)
- **Modals/Drawers**: Spring scale-in from trigger point
- **Toasts**: Slide in from top-right with spring
- **Sidebar groups**: Smooth collapse/expand with height animation
- **Dashboard attention bar**: Staggered card entrance from left
- **Activity feed items**: Slide down + fade for new real-time entries
- **Status changes**: Color crossfade (200ms)
- **Button press**: Scale 0.97 with spring return
- **Tab indicator**: Layout animation (shared layout ID)

### Reduced Motion
Respect `prefers-reduced-motion`. All Framer Motion animations check `useReducedMotion()`. HeroUI's built-in `motion-reduce:` utilities handle CSS transitions.

---

## Component Architecture

### Base Components (HeroUI v3)
Map of HeroUI components to Paperclip usage:

| HeroUI Component | Paperclip Usage |
|------------------|-----------------|
| Button | All CTAs, actions |
| Card + Surface | Metric cards, entity cards, dashboard widgets |
| Modal / Drawer | Dialogs, mobile navigation |
| Input / TextField / SearchField | Forms, inline edit, search |
| Select | Filters, property selectors |
| Tabs | Page sections, detail views |
| Table | Issue lists, cost breakdowns |
| Avatar | Agent/user identity |
| Badge | Status indicators, counts |
| Chip / TagGroup | Filters, labels, status pills |
| Tooltip | Help text, truncated content |
| Popover | Dropdowns, color pickers |
| Toast | Notifications, confirmations |
| Skeleton | Loading states |
| ProgressBar / ProgressCircle | Goal progress, budget utilization |
| Breadcrumbs | Navigation context |
| Alert / AlertDialog | Warnings, confirmations |
| Accordion / Disclosure | Sidebar groups, expandable sections |
| Separator | Section dividers |
| Form | All form layouts |
| Switch | Settings toggles |
| Spinner | Inline loading |
| ScrollShadow | Scrollable content areas |

### Custom Components to Build
- `AppSidebar` — Grouped navigation with company switcher, Electron titlebar integration
- `CommandPalette` — Global search/actions (Cmd+K) — built on HeroUI Modal + SearchField + ListBox
- `AttentionBar` — Dashboard action-needed cards
- `ActivityFeed` — Real-time activity list with animations
- `MetricCard` — KPI display with sparkline
- `StatusIndicator` — Agent/task status with animated pulse
- `PropertiesPanel` — Right sidebar for entity details
- `MobileBottomNav` — Tab bar for mobile
- `InlineEditor` — Markdown inline editing wrapper
- `EntityRow` — Reusable row for issues, agents in lists
- `EmptyState` — Illustrated empty states
- `ThemeToggle` — Three-state system/light/dark switcher

---

## Electron Integration

### Window Configuration
- Frameless window (`frame: false, titleBarStyle: 'hidden'`)
- `titleBarOverlay` for Windows (system buttons)
- macOS: traffic lights visible, positioned in sidebar header
- Custom drag region on sidebar header

### Platform Detection
```typescript
const isElectron = !!window.electronAPI
const isMac = navigator.platform.includes('Mac')
```

### CSS Adjustments
```css
/* Electron macOS — space for traffic lights */
.electron.mac .sidebar-header {
  padding-left: 78px;
  -webkit-app-region: drag;
}
.electron.mac .sidebar-header * {
  -webkit-app-region: no-drag;
}

/* Electron Windows — space for title bar overlay */
.electron.win .app-header {
  padding-right: 138px;
}
```

### Existing Integration Points (Preserve)
- `desktop/src/main/window.ts` — Window creation config
- `desktop/src/main/tray.ts` — System tray
- `desktop/src/main/lifecycle.ts` — App lifecycle
- `desktop/src/main/auto-updater.ts` — Auto-updates
- `desktop/src/preload/index.ts` — Preload bridge

---

## File Structure (New)

```
ui/src/
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx          (main layout wrapper)
│   │   ├── AppSidebar.tsx        (grouped sidebar nav)
│   │   ├── SidebarGroup.tsx      (collapsible nav group)
│   │   ├── CompanySwitcher.tsx   (company selector dropdown)
│   │   ├── BreadcrumbBar.tsx     (breadcrumb navigation)
│   │   ├── PropertiesPanel.tsx   (right sidebar panel)
│   │   ├── MobileBottomNav.tsx   (mobile tab bar)
│   │   ├── CommandPalette.tsx    (Cmd+K global search)
│   │   └── ThemeToggle.tsx       (system/light/dark)
│   ├── dashboard/
│   │   ├── AttentionBar.tsx
│   │   ├── MetricCard.tsx
│   │   ├── ActivityFeed.tsx
│   │   └── ActivityCharts.tsx
│   ├── issues/
│   │   ├── IssueRow.tsx
│   │   ├── IssueFilters.tsx
│   │   ├── IssueDetail.tsx
│   │   ├── IssueComments.tsx
│   │   └── NewIssueDialog.tsx
│   ├── agents/
│   │   ├── AgentCard.tsx
│   │   ├── AgentDetail.tsx
│   │   ├── AgentConfigForm.tsx
│   │   └── StatusIndicator.tsx
│   ├── projects/
│   │   ├── ProjectCard.tsx
│   │   └── NewProjectDialog.tsx
│   ├── goals/
│   │   ├── GoalTree.tsx
│   │   └── GoalNode.tsx
│   ├── approvals/
│   │   └── ApprovalCard.tsx
│   ├── costs/
│   │   └── CostCharts.tsx
│   ├── shared/
│   │   ├── EntityRow.tsx
│   │   ├── EmptyState.tsx
│   │   ├── InlineEditor.tsx
│   │   ├── Identity.tsx
│   │   ├── PageSkeleton.tsx
│   │   └── AnimatedList.tsx
│   └── plugins/
│       ├── PluginSlotOutlet.tsx
│       └── PluginLauncher.tsx
├── motion/
│   ├── transitions.ts            (shared spring/ease configs)
│   ├── AnimatedPage.tsx          (page transition wrapper)
│   ├── AnimatedList.tsx          (staggered list wrapper)
│   └── useReducedMotion.ts       (motion preference hook)
├── theme/
│   ├── paperclip-light.css       (light theme variables)
│   ├── paperclip-dark.css        (dark theme variables)
│   └── globals.css               (imports, base styles)
├── pages/                        (rebuilt — same routes, new components)
├── api/                          (preserved as-is)
├── context/                      (preserved as-is)
├── hooks/                        (preserved + new hooks)
├── lib/                          (preserved as-is)
├── adapters/                     (preserved as-is)
└── plugins/                      (preserved as-is)
```

---

## Migration Strategy

### Phase 1: Foundation
1. Install HeroUI v3 (`@heroui/react`, `@heroui/styles`)
2. Install Framer Motion
3. Create Paperclip theme (light + dark CSS files)
4. Set up theme provider with system detection
5. Update `index.css` to import HeroUI styles + Paperclip theme
6. Remove all shadcn/ui components from `components/ui/`
7. Remove Radix UI dependencies

### Phase 2: Shell
1. Build `AppShell` (main layout with sidebar + content + panel zones)
2. Build `AppSidebar` with grouped navigation
3. Build `CompanySwitcher`
4. Build `BreadcrumbBar`
5. Build `CommandPalette`
6. Build `ThemeToggle`
7. Build `MobileBottomNav`
8. Wire up Electron titlebar integration
9. Set up motion primitives (`motion/transitions.ts`)
10. Build `AnimatedPage` wrapper for route transitions

### Phase 3: Dashboard
1. Build `AttentionBar` with animated cards
2. Build `MetricCard` with sparklines
3. Build `ActivityFeed` with real-time updates
4. Rebuild `ActivityCharts`
5. Wire up plugin slots
6. Rebuild `Dashboard` page

### Phase 4: Core Pages
1. Issues list + detail + new issue dialog
2. Agents grid + detail + config form
3. Projects grid + detail + new project dialog

### Phase 5: Secondary Pages
1. Goals (tree view)
2. Approvals (card list)
3. Costs (charts dashboard)
4. Activity (timeline)
5. Inbox (email-style list)
6. Skills management

### Phase 6: Settings & Auth
1. Company settings
2. Instance settings (general, experimental, plugins)
3. Auth pages (login, invite, bootstrap, CLI auth)
4. Onboarding flow

### Phase 7: Polish
1. Mobile responsive pass on all pages
2. Tablet breakpoint optimization
3. Animation polish and performance
4. Reduced motion accessibility pass
5. Keyboard shortcut system
6. Loading states and error boundaries
7. Empty states with illustrations
8. Final QA across Electron + Web + Mobile

---

## Verification

### Functional
- All existing routes accessible and functional
- API calls work correctly (no data layer changes)
- Real-time updates (WebSocket) work on dashboard and throughout
- Company switching works
- Theme toggle works (system/light/dark)
- Command palette works (Cmd+K)
- Keyboard shortcuts work

### Visual
- Light and dark themes both look premium
- Consistent use of HeroUI components throughout
- Animations are smooth (60fps), purposeful, and respect reduced motion
- Mobile layout works on iPhone/Android viewports
- Tablet layout works on iPad viewports

### Electron
- Traffic lights integrate properly on macOS
- Window drag works on sidebar header
- Tray, auto-updater, lifecycle all still work
- No regressions in desktop/src/

### Build
```bash
pnpm typecheck          # No type errors
pnpm test:run           # All tests pass
pnpm build              # Clean build
pnpm dev:desktop        # Electron runs correctly
```
