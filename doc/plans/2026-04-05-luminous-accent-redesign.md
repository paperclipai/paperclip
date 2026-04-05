# Luminous Accent UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the HeroUI v3 reskin into an Apple-level "Luminous Accent" design — fix bugs, add accent-tinted surfaces, upgrade typography, wrap all lists in Card containers.

**Architecture:** Pure visual/CSS changes to existing React components. No new pages, features, or API changes. Every task modifies existing files in `ui/src/`. The accent color system uses gradient tints on card backgrounds to signal importance. HeroUI v3 compound component patterns must be used throughout.

**Tech Stack:** React 19, HeroUI v3 (beta), Tailwind CSS v4, Framer Motion, Lucide icons

**Spec:** `docs/superpowers/specs/2026-04-05-luminous-accent-redesign.md`
**Visual reference:** Run dev server, visit `/AGE/visual-prototype` tab C

---

### Task 1: Fix NewIssueDialog Modal Centering

The modal renders in the bottom-left corner because `Modal.Backdrop` is a sibling of `Modal.Container` instead of wrapping it. In HeroUI v3, `Modal.Backdrop` must wrap `Modal.Container`, and controlled state props (`isOpen`, `onOpenChange`) go on `Modal.Backdrop`, not `Modal`.

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx:855-862`

- [ ] **Step 1: Fix the Modal structure**

Change the modal wrapper from:

```tsx
<Modal
  isOpen={newIssueOpen}
  onOpenChange={(open) => {
    if (!open && !createIssue.isPending) closeNewIssue();
  }}
>
  <Modal.Backdrop />
  <Modal.Container size={expanded ? "lg" : "md"}>
    <Modal.Dialog>
```

To:

```tsx
<Modal.Backdrop
  isOpen={newIssueOpen}
  onOpenChange={(open: boolean) => {
    if (!open && !createIssue.isPending) closeNewIssue();
  }}
>
  <Modal.Container size={expanded ? "lg" : "md"}>
    <Modal.Dialog>
```

And change the closing tags from:

```tsx
        </Modal.Dialog>
      </Modal.Container>
    </Modal>
```

To:

```tsx
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
```

- [ ] **Step 2: Verify modal centers correctly**

Run: `pnpm dev`
Navigate to Issues page, click "New Issue" button.
Expected: Modal appears centered on screen with proper backdrop overlay.

- [ ] **Step 3: Apply same fix to all other modals in the codebase**

Search for the broken pattern `<Modal.Backdrop />` (self-closing backdrop as sibling) across:
- `ui/src/pages/PluginManager.tsx` (3 modals)
- `ui/src/pages/CompanySkills.tsx` (1 modal)
- `ui/src/pages/Inbox.tsx` (1 modal)
- `ui/src/pages/DesignGuide.tsx` (1 modal)
- Any other files found via: `grep -r "Modal.Backdrop />" ui/src/`

For each, restructure so `Modal.Backdrop` wraps `Modal.Container`:

```tsx
// BEFORE (broken):
<Modal isOpen={...} onOpenChange={...}>
  <Modal.Backdrop />
  <Modal.Container>
    <Modal.Dialog>...</Modal.Dialog>
  </Modal.Container>
</Modal>

// AFTER (correct):
<Modal.Backdrop isOpen={...} onOpenChange={...}>
  <Modal.Container>
    <Modal.Dialog>...</Modal.Dialog>
  </Modal.Container>
</Modal.Backdrop>
```

- [ ] **Step 4: Verify all modals**

Run: `pnpm typecheck`
Expected: No type errors.

Navigate to each page with a modal and verify centering works.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: center all modals with correct HeroUI v3 Modal.Backdrop wrapping"
```

---

### Task 2: Sidebar Redesign — Luminous Accent

Update the sidebar to use accent-tinted active states, gradient company avatar, luminous inbox badge, and accent-colored group labels.

**Files:**
- Modify: `ui/src/components/layout/AppSidebar.tsx`
- Modify: `ui/src/components/layout/SidebarGroup.tsx`

- [ ] **Step 1: Update NavItem active state**

In `AppSidebar.tsx`, change the NavItem `className` function (around line 76-83):

```tsx
// BEFORE:
isActive
  ? "bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-primary font-semibold"
  : "text-foreground/60 hover:bg-default/50 hover:text-foreground",

// AFTER:
isActive
  ? "bg-gradient-to-r from-accent/15 to-accent/5 border border-accent/10 text-accent font-semibold"
  : "text-foreground/40 hover:bg-default/40 hover:text-foreground/70 transition-colors",
```

- [ ] **Step 2: Update CompanyHeader avatar**

In the `CompanyHeader` component (around line 148-153), change the company avatar:

```tsx
// BEFORE:
<span
  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
  style={{ backgroundColor: brandColor ?? "#6366f1" }}
>

// AFTER:
<span
  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white shadow-md shadow-accent/20"
  style={{ background: brandColor ? brandColor : 'linear-gradient(135deg, var(--color-accent), var(--color-accent))' }}
>
```

- [ ] **Step 3: Update inbox badge to luminous style**

In the NavItem component, change the numeric badge rendering (around line 116-126):

```tsx
// BEFORE:
badgeTone === "danger"
  ? "bg-danger/90 text-white"
  : "bg-default-200 text-default-700",

// AFTER:
badgeTone === "danger"
  ? "bg-gradient-to-r from-danger to-red-500 text-white shadow-sm shadow-danger/30"
  : "bg-default-200 text-default-700",
```

- [ ] **Step 4: Update SearchTrigger styling**

In `SearchTrigger` (around line 176), update the keyboard shortcut:

```tsx
// BEFORE:
<kbd className="rounded-md border border-default-200 bg-background px-1.5 py-0.5 text-[10px] font-mono text-foreground/30">

// AFTER:
<kbd className="rounded-md border border-default-200/50 bg-background px-1.5 py-0.5 text-[10px] font-mono text-foreground/25">
```

- [ ] **Step 5: Update SidebarGroup label typography**

In `SidebarGroup.tsx`, change the label span (line 77):

```tsx
// BEFORE:
<span className="text-[10px] font-semibold uppercase tracking-widest font-mono text-foreground/40 truncate">

// AFTER:
<span className="text-[10px] font-medium uppercase tracking-wider text-accent/30 truncate">
```

- [ ] **Step 6: Verify sidebar appearance**

Run: `pnpm dev`
Check:
- Active nav item has accent gradient background with subtle accent border
- Company avatar has accent shadow glow
- Inbox badge (when count > 0) has red gradient with danger shadow
- Group labels (Overview, Work, Team, Operations) are accent-tinted, not gray

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/layout/AppSidebar.tsx ui/src/components/layout/SidebarGroup.tsx
git commit -m "feat: redesign sidebar with Luminous Accent system"
```

---

### Task 3: Typography — Page Titles and Section Headers

Change all page titles from uppercase to mixed-case, and update section headers.

**Files:**
- Modify: `ui/src/components/BreadcrumbBar.tsx`
- Modify: `ui/src/components/ActiveAgentsPanel.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Fix BreadcrumbBar page title typography**

In `BreadcrumbBar.tsx`, find the page title class (the span with `uppercase tracking-wider`):

```tsx
// BEFORE:
"text-sm font-semibold uppercase tracking-wider truncate"

// AFTER:
"text-sm font-semibold tracking-tight truncate"
```

- [ ] **Step 2: Fix ActiveAgentsPanel section header**

In `ActiveAgentsPanel.tsx`, find the heading class:

```tsx
// BEFORE:
"mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground"

// AFTER:
"mb-3 text-sm font-semibold text-foreground/60"
```

- [ ] **Step 3: Fix Dashboard section headers**

In `Dashboard.tsx`, find the "Recent Activity" and "Recent Tasks" headings (around lines 312, 332):

```tsx
// BEFORE:
<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">

// AFTER:
<h3 className="text-sm font-semibold text-foreground/60 mb-3">
```

- [ ] **Step 4: Verify**

Run: `pnpm dev`
Check: All page titles and section headers are mixed-case, not UPPERCASE.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BreadcrumbBar.tsx ui/src/components/ActiveAgentsPanel.tsx ui/src/pages/Dashboard.tsx
git commit -m "feat: update typography to mixed-case titles and accent-tinted headers"
```

---

### Task 4: MetricCard Redesign

Add HeroUI Card wrapper with semantic color tinting per the Luminous Accent system.

**Files:**
- Modify: `ui/src/components/MetricCard.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add color variant support to MetricCard**

Rewrite `MetricCard.tsx`:

```tsx
import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

type MetricTone = "accent" | "success" | "neutral";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
  tone?: MetricTone;
}

const toneStyles: Record<MetricTone, { card: string; value: string; icon: string; iconBg: string; sub: string; shadow?: React.CSSProperties }> = {
  accent: {
    card: "bg-gradient-to-br from-accent/[0.08] to-accent/[0.02] border-accent/[0.12]",
    value: "text-accent",
    icon: "text-accent/50",
    iconBg: "bg-accent/10",
    sub: "text-accent/40",
    shadow: { boxShadow: "0 2px 16px rgba(99,102,241,0.06)" },
  },
  success: {
    card: "bg-gradient-to-br from-success/[0.05] to-transparent border-success/[0.08]",
    value: "text-success",
    icon: "text-success/50",
    iconBg: "bg-success/10",
    sub: "text-success/40",
  },
  neutral: {
    card: "border-default-200/60",
    value: "text-foreground",
    icon: "text-foreground/20",
    iconBg: "bg-default/40",
    sub: "text-foreground/25",
  },
};

export function MetricCard({ icon: Icon, value, label, description, to, onClick, tone = "neutral" }: MetricCardProps) {
  const isClickable = !!(to || onClick);
  const s = toneStyles[tone];

  const inner = (
    <Card
      className={cn(s.card, isClickable && "cursor-pointer hover:opacity-90 transition-opacity")}
      style={s.shadow}
    >
      <Card.Content className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className={cn("text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums", s.value)}>
              {value}
            </p>
            <p className="text-[11px] font-medium text-foreground/40 mt-1.5">
              {label}
            </p>
            {description && (
              <div className={cn("text-[10px] mt-0.5 hidden sm:block", s.sub)}>{description}</div>
            )}
          </div>
          <div className={cn("rounded-xl p-2", s.iconBg)}>
            <Icon className={cn("h-4 w-4", s.icon)} />
          </div>
        </div>
      </Card.Content>
    </Card>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return <div onClick={onClick}>{inner}</div>;
  }

  return inner;
}
```

- [ ] **Step 2: Update Dashboard to pass tone props**

In `Dashboard.tsx`, update the metric card grid (around lines 232-284):

```tsx
<MetricCard
  icon={Bot}
  value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
  label="Agents Enabled"
  to="/agents"
  tone="accent"
  description={...}
/>
<MetricCard
  icon={CircleDot}
  value={data.tasks.inProgress}
  label="Tasks In Progress"
  to="/issues"
  tone="neutral"
  description={...}
/>
<MetricCard
  icon={DollarSign}
  value={formatCents(data.costs.monthSpendCents)}
  label="Month Spend"
  to="/costs"
  tone="success"
  description={...}
/>
<MetricCard
  icon={ShieldCheck}
  value={data.pendingApprovals + data.budgets.pendingApprovals}
  label="Pending Approvals"
  to="/approvals"
  tone="neutral"
  description={...}
/>
```

Also update the grid gap from `gap-1 sm:gap-2` to `gap-3`:

```tsx
// BEFORE:
<div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">

// AFTER:
<div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
```

- [ ] **Step 3: Verify**

Run: `pnpm dev`
Check: Agents card has indigo tint + glow, Spend card has green tint, others are neutral with clean borders.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/MetricCard.tsx ui/src/pages/Dashboard.tsx
git commit -m "feat: redesign MetricCard with Luminous Accent semantic color tinting"
```

---

### Task 5: ChartCard and Dashboard Lists

Update ChartCard to use HeroUI Card. Wrap Recent Activity and Recent Tasks in Card containers with rounded corners.

**Files:**
- Modify: `ui/src/components/ActivityCharts.tsx`
- Modify: `ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Update ChartCard to use HeroUI Card**

In `ActivityCharts.tsx`, update the `ChartCard` component (lines 47-57):

```tsx
import { Card } from "@heroui/react";

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="border-default-200/60">
      <Card.Content className="p-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold text-foreground/50">{title}</h3>
          {subtitle && <span className="text-[10px] text-foreground/25">{subtitle}</span>}
        </div>
        {children}
      </Card.Content>
    </Card>
  );
}
```

- [ ] **Step 2: Wrap Dashboard Recent Activity in Card**

In `Dashboard.tsx`, find the Recent Activity section (around line 310-328):

```tsx
// BEFORE:
<div className="min-w-0">
  <h3 className="text-sm font-semibold text-foreground/60 mb-3">
    Recent Activity
  </h3>
  <div className="border border-border divide-y divide-border overflow-hidden">
    {recentActivity.map((event) => (...))}
  </div>
</div>

// AFTER:
<div className="min-w-0">
  <Card className="border-default-200/60">
    <Card.Header className="px-4 py-3 border-b border-default-200/40">
      <Card.Title className="text-sm font-semibold text-foreground/60">Recent Activity</Card.Title>
    </Card.Header>
    <Card.Content className="p-0">
      {recentActivity.map((event) => (
        <ActivityRow
          key={event.id}
          event={event}
          agentMap={agentMap}
          entityNameMap={entityNameMap}
          entityTitleMap={entityTitleMap}
          className={cn(
            "border-b border-default-200/30 last:border-0",
            animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined,
          )}
        />
      ))}
    </Card.Content>
  </Card>
</div>
```

Add `import { Card } from "@heroui/react";` at the top of Dashboard.tsx.

- [ ] **Step 3: Wrap Dashboard Recent Tasks in Card**

In `Dashboard.tsx`, find the Recent Tasks section (around line 330-380):

```tsx
// BEFORE:
<div className="min-w-0">
  <h3 className="text-sm font-semibold text-foreground/60 mb-3">
    Recent Tasks
  </h3>
  {recentIssues.length === 0 ? (
    <div className="border border-border p-4">...</div>
  ) : (
    <div className="border border-border divide-y divide-border overflow-hidden">

// AFTER:
<div className="min-w-0">
  <Card className="border-default-200/60">
    <Card.Header className="px-4 py-3 border-b border-default-200/40">
      <Card.Title className="text-sm font-semibold text-foreground/60">Recent Tasks</Card.Title>
    </Card.Header>
    <Card.Content className="p-0">
      {recentIssues.length === 0 ? (
        <div className="p-4">
          <p className="text-sm text-foreground/40">No tasks yet.</p>
        </div>
      ) : (
        <>
          {recentIssues.slice(0, 10).map((issue) => (
            <Link
              key={issue.id}
              to={`/issues/${issue.identifier ?? issue.id}`}
              className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/[0.03] transition-colors no-underline text-inherit block border-b border-default-200/30 last:border-0"
            >
```

Close with `</></Card.Content></Card>` instead of the old `</div>`.

- [ ] **Step 4: Verify**

Run: `pnpm dev`
Check: Chart cards and activity/tasks sections have rounded card treatment, no sharp corners.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ActivityCharts.tsx ui/src/pages/Dashboard.tsx
git commit -m "feat: wrap charts and dashboard lists in HeroUI Card containers"
```

---

### Task 6: Issues Page — Card Wrapper and Accent Hover

Wrap the issues list in a Card container and add accent-tinted hover states.

**Files:**
- Modify: `ui/src/pages/Issues.tsx` (and/or the `IssuesList` component it renders)

- [ ] **Step 1: Identify the issues list rendering component**

Run: `grep -r "IssuesList\|issuesList\|issues-list" ui/src/ --include="*.tsx" -l`

Read the component that renders the list rows. It may be in `Issues.tsx` directly or in a sub-component.

- [ ] **Step 2: Wrap the issue rows in a Card**

Find the container that has `border border-border` or similar, and replace with:

```tsx
import { Card } from "@heroui/react";

<Card className="border-default-200/60">
  <Card.Content className="p-0">
    {/* existing issue rows */}
  </Card.Content>
</Card>
```

Update each row's hover class from `hover:bg-accent/50` to `hover:bg-accent/[0.03]`.
Update row dividers from `divide-y divide-border` to individual `border-b border-default-200/30 last:border-0`.

- [ ] **Step 3: Update "New Issue" button to accent color**

Find the "New Issue" button and add `color="accent"`:

```tsx
<Button color="accent" onPress={...}>
  New Issue
</Button>
```

- [ ] **Step 4: Verify**

Run: `pnpm dev`, navigate to Issues page.
Check: Issue rows are inside a rounded card, hover shows subtle accent tint.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: wrap issues list in Card with accent hover states"
```

---

### Task 7: Agents Page — Card Wrapper and Status Chips

Wrap the agents tree/list in a Card, update status badges to HeroUI Chip, dim role descriptions.

**Files:**
- Modify: `ui/src/pages/Agents.tsx`

- [ ] **Step 1: Wrap agent rows in a Card**

Find the container that holds the agent tree rows and wrap in:

```tsx
import { Card, Chip } from "@heroui/react";

<Card className="border-default-200/60">
  <Card.Content className="p-0">
    {/* existing agent rows */}
  </Card.Content>
</Card>
```

- [ ] **Step 2: Update agent name/role visual hierarchy**

For each agent row, ensure:
- Agent name: `font-medium text-foreground/80`
- Role description: `text-foreground/40` (dimmer than name)

- [ ] **Step 3: Replace "idle" text badges with HeroUI Chip**

Replace plain text "idle" badges with:

```tsx
<Chip size="sm" variant="soft">idle</Chip>
```

For other statuses:
- Active/running: `<Chip size="sm" variant="soft" color="success">active</Chip>`
- Error: `<Chip size="sm" variant="soft" color="danger">error</Chip>`
- Paused: `<Chip size="sm" variant="soft" color="warning">paused</Chip>`

- [ ] **Step 4: Update "New Agent" button**

```tsx
<Button color="accent" onPress={...}>New Agent</Button>
```

- [ ] **Step 5: Verify**

Run: `pnpm dev`, navigate to Agents page.
Check: Agent rows in rounded card, role text dimmer than name, status uses Chip components.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Agents.tsx && git commit -m "feat: redesign agents page with Card wrapper and status Chips"
```

---

### Task 8: Activity Page — Card Wrapper

Wrap the activity list in a Card with accent-colored entity references.

**Files:**
- Modify: `ui/src/pages/Activity.tsx`

- [ ] **Step 1: Wrap activity list in Card**

Find the activity list container:

```tsx
// BEFORE:
<div className="border border-border divide-y divide-border">

// AFTER:
<Card className="border-default-200/60">
  <Card.Content className="p-0">
```

Update row dividers to `border-b border-default-200/30 last:border-0`.

- [ ] **Step 2: Verify**

Run: `pnpm dev`, navigate to Activity page.
Check: Activity rows in rounded card container.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/Activity.tsx && git commit -m "feat: wrap activity page list in Card container"
```

---

### Task 9: Remaining Pages — Consistent Card Treatment

Apply Card wrapping and updated borders to Projects, Goals, Approvals, Costs, and Inbox pages.

**Files:**
- Modify: `ui/src/pages/Projects.tsx`
- Modify: `ui/src/pages/Goals.tsx`
- Modify: `ui/src/pages/Approvals.tsx`
- Modify: `ui/src/pages/Costs.tsx`
- Modify: `ui/src/pages/Inbox.tsx`

- [ ] **Step 1: Update each page's list container**

For each page, find `border border-border` containers and replace with `Card className="border-default-200/60"` wrapping. Pattern:

```tsx
// BEFORE:
<div className="border border-border ...">

// AFTER:
<Card className="border-default-200/60">
  <Card.Content className="p-0">
    ...
  </Card.Content>
</Card>
```

Update internal dividers from `divide-border` to `border-default-200/30`.

- [ ] **Step 2: Update action buttons to accent color**

For each page with a primary action button ("New Project", "New Goal", etc.), add `color="accent"`.

- [ ] **Step 3: Verify each page**

Run: `pnpm dev`
Navigate to each page and check:
- Projects: list rows in rounded card
- Goals: goal items in rounded card
- Approvals: approval cards have proper borders
- Costs: metric tiles updated (the Costs page already uses Card — just verify borders match `border-default-200/60`)
- Inbox: items in rounded card

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: apply Card containers and accent buttons to all remaining pages"
```

---

### Task 10: Final Verification

Run the full verification checklist from the spec.

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
pnpm typecheck
```

Expected: All packages pass with no errors.

- [ ] **Step 2: Run build**

```bash
pnpm build
```

Expected: Clean build, no errors.

- [ ] **Step 3: Visual verification checklist**

Start `pnpm dev` and check each item:

1. New Issue modal centers correctly on screen
2. All metric cards have Card containers with semantic color tints
3. All lists (activity, tasks, issues, agents) have rounded Card containers
4. Accent color visible on: active sidebar nav, primary metric, entity references, group labels
5. Light mode: switch theme and verify all tints/borders work in light mode
6. Dark mode: verify all tints/borders work in dark mode
7. Page titles are mixed-case ("Dashboard" not "DASHBOARD")
8. No console errors on any page

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A && git commit -m "fix: final visual polish and verification fixes"
```
