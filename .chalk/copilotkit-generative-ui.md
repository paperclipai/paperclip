# CopilotKit Generative UI — Inline Chat Visualizations

## Goal

Add rich inline visualizations to the CopilotKit chat sidebar so that AI responses render interactive components instead of plain text. This transforms the sidebar from a text-only assistant into a visual command center — the key demo differentiator for Paperclip's CopilotKit integration.

## Current State (post v2 migration)

- **v2 migration is complete** — all hooks use `@copilotkit/react-core/v2` APIs
- 45 `useFrontendTool` handlers + 3 `useHumanInTheLoop` handlers registered, all returning plain JSON
- 3 existing `useHumanInTheLoop` instances with `render` props — all destructive confirmation dialogs (`deleteIssue`, `deleteProject`, `terminateAgent`) using `ToolCallStatus.Complete` / `ToolCallStatus.Executing` pattern
- Server runtime uses `BuiltInAgent` with `openai/gpt-5.4` via `createCopilotEndpointSingleRouteExpress`
- Provider: `CopilotKitProvider` from `@copilotkit/react-core/v2`
- Context: 4x `useAgentContext`, 1x `useConfigureSuggestions`
- Rich chart/card components already exist on the Dashboard page (`ActivityCharts.tsx`, `MetricCard.tsx`, `ActiveAgentsPanel.tsx`, `KanbanBoard.tsx`) but are not exposed in chat
- Styling system: Tailwind with `border-border`, `text-muted-foreground`, `rounded-lg`, `p-3`/`p-4`, alpha opacity patterns (`/5`, `/25`, `/50`)
- No `ui/src/components/chat/` directory exists yet

## Architecture

All inline components live in a new directory:

```
ui/src/components/chat/
├── ChatDashboardCard.tsx      # Step 1
├── ChatAgentStatusGrid.tsx    # Step 2
├── ChatIssueList.tsx          # Step 3
├── ChatCostBreakdown.tsx      # Step 4
├── ChatApprovalCard.tsx       # Step 5
├── ChatOrgChart.tsx           # Step 6
└── index.ts                   # barrel export
```

Each component is a self-contained React component that:
- Receives data via `args` / `result` from the tool handler
- Fits within the ~340px sidebar width
- Uses existing Tailwind color/spacing patterns
- Is read-only OR interactive (approval actions, issue creation)

Components are wired in via `render` props on existing `useFrontendTool` / `useHumanInTheLoop` calls in `useCopilotActions.tsx`. No new tools needed — we add `render` to tools that already return data.

---

## Step 1: ChatDashboardCard — Mini Dashboard Summary

**Tool to modify:** `getDashboard` (`useFrontendTool`)

**What it renders:** A compact card showing company health at a glance.

```
┌─────────────────────────────────┐
│ ACME Dashboard                   │
│                                  │
│  12 Agents    47 Issues   $2.4k │
│  ●3 run ●2 err  ●8 open  /5k   │
│                                  │
│  ████████░░  48% budget used     │
│                                  │
│  [View Dashboard ->]             │
└─────────────────────────────────┘
```

**Data source:** `dashboardApi.getSummary(companyId)` — already called by the `getDashboard` handler.

**Layout:**
- Container: `rounded-lg border border-border bg-card p-3 text-sm space-y-2`
- 3-column metric row: agent count, issue count, budget spent
- Sub-labels: `text-[10px] text-muted-foreground` with colored dots for statuses
- Budget bar: full-width `h-1.5 rounded-full bg-muted` with filled portion colored by utilization (emerald < 70%, yellow 70-90%, red > 90%)
- Footer link: `text-xs text-primary hover:underline cursor-pointer` calling `navigate()`

**Wiring (v2 pattern):**
```tsx
useFrontendTool({
  name: "getDashboard",
  // ... existing config ...
  render: ({ status, result }) => {
    if (status === ToolCallStatus.Complete && result) {
      return <ChatDashboardCard data={result} onNavigate={navigate} />;
    }
    return <ChatLoadingSkeleton />;
  },
});
```

---

## Step 2: ChatAgentStatusGrid — Agent Overview

**Tool to modify:** `listAgents` (`useFrontendTool`)

**What it renders:** A grid of agent cards showing status at a glance.

```
┌─────────────────────────────────┐
│ 5 Agents                         │
│                                  │
│ ┌──────────┐ ┌──────────┐      │
│ │ ● Alice   │ │ ○ Bob     │      │
│ │ CTO       │ │ Engineer  │      │
│ │ running   │ │ idle      │      │
│ └──────────┘ └──────────┘      │
│ ┌──────────┐ ┌──────────┐      │
│ │ ! Carol   │ │ ● Dave    │      │
│ │ Designer  │ │ Marketer  │      │
│ │ error     │ │ active    │      │
│ └──────────┘ └──────────┘      │
└─────────────────────────────────┘
```

**Data source:** `agentsApi.list(companyId)` — already called.

**Layout:**
- Container: `rounded-lg border border-border bg-card p-3 text-sm`
- Header: count + "Agents" label
- Grid: `grid grid-cols-2 gap-1.5`
- Each card: `rounded-md border border-border/50 p-2`
  - Status dot: `h-2 w-2 rounded-full` — emerald (running/active), gray (idle/paused), red (error), amber (terminated)
  - Name: `text-xs font-medium truncate`
  - Role: `text-[10px] text-muted-foreground`
  - Status: `text-[10px]` colored by state
- Clickable cards navigate to agent detail

---

## Step 3: ChatIssueList — Inline Issue Preview

**Tool to modify:** `listIssues` (`useFrontendTool`)

**What it renders:** A compact issue list with status/priority indicators.

```
┌─────────────────────────────────┐
│ 8 Issues                         │
│                                  │
│ * ACME-42  Fix login crash       │
│   urgent · in_progress · Alice   │
│                                  │
│ * ACME-38  Update docs           │
│   medium · todo · unassigned     │
│                                  │
│ * ACME-35  Add dark mode         │
│   low · done · Bob               │
│                                  │
│ ... and 5 more                   │
│ [View all issues ->]             │
└─────────────────────────────────┘
```

**Data source:** `issuesApi.list(companyId, filters)` — already called.

**Layout:**
- Container: `rounded-lg border border-border bg-card p-3 text-sm`
- Max 5 items shown, "+ N more" footer
- Each row: `py-1.5 border-b border-border/30 last:border-0`
  - Priority dot: colored circle (red=urgent, orange=high, yellow=medium, gray=low)
  - Identifier: `text-xs font-mono text-muted-foreground`
  - Title: `text-xs font-medium truncate`
  - Sub-line: `text-[10px] text-muted-foreground` — priority label · status · assignee
- Clickable rows navigate to issue detail

---

## Step 4: ChatCostBreakdown — Budget & Spend Visualization

**Tools to modify:** `getCostSummary`, `getCostsByAgent` (`useFrontendTool`)

**What it renders:** Budget utilization with top spenders.

```
┌─────────────────────────────────┐
│ Cost Summary (MTD)               │
│                                  │
│         $2,450                   │
│        / $5,000                  │
│  ████████████░░░░░  49%          │
│                                  │
│  Top agents:                     │
│  Alice    ████████░░  $980       │
│  Bob      ████░░░░░░  $520      │
│  Carol    ███░░░░░░░  $410      │
│                                  │
│  [View costs ->]                 │
└─────────────────────────────────┘
```

**Layout:**
- Container: `rounded-lg border border-border bg-card p-3 text-sm space-y-3`
- Center block: large `text-lg font-semibold tabular-nums` for total spent, `text-xs text-muted-foreground` for budget
- Progress bar: `h-2 rounded-full bg-muted` with colored fill
- Agent breakdown: horizontal bars, `h-1.5 rounded-full` per agent, capped to top 3
- Each row: agent name `text-xs` + bar + `text-xs tabular-nums text-muted-foreground` for amount

---

## Step 5: ChatApprovalCard — Actionable Approval

**Tool to modify:** New `useHumanInTheLoop` replacing or alongside `listApprovals`

**What it renders:** Pending approvals with inline action buttons.

```
┌─────────────────────────────────┐
│ Pending Approval                 │
│                                  │
│ New Agent Request                │
│ "Hire a QA engineer for ACME"   │
│ Requested by: Alice (CTO)       │
│ 2 hours ago                      │
│                                  │
│ [Approve] [Reject] [Revise]     │
└─────────────────────────────────┘
```

**Pattern:** Uses `useHumanInTheLoop` with `render` + `ToolCallStatus` (same pattern as existing `deleteIssue`/`deleteProject`/`terminateAgent`).

**Layout:**
- Container: `rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3 text-sm space-y-2`
- Type label: `text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300`
- Description: `text-xs`
- Requester + time: `text-[10px] text-muted-foreground`
- Buttons row: `flex gap-2`
  - Approve: `rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700`
  - Reject: `rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground`
  - Request Revision: `rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent`

**Wiring:**
```tsx
useHumanInTheLoop({
  name: "reviewApproval",
  description: "Review a pending approval with inline approve/reject/revise actions",
  parameters: z.object({
    approvalId: z.string().describe("Approval ID"),
  }),
  render: ({ args, respond, status }) => {
    if (status === ToolCallStatus.Complete) {
      return <p className="text-sm text-muted-foreground">Approval reviewed.</p>;
    }
    if (status === ToolCallStatus.Executing && respond) {
      return <ChatApprovalCard approvalId={args.approvalId} onDecision={respond} />;
    }
    return null;
  },
});
```

---

## Step 6: ChatOrgChart — Mini Org Tree

**Tool to modify:** `getAgentOrgChart` (`useFrontendTool`)

**What it renders:** A compact hierarchical view of the agent org chart.

```
┌─────────────────────────────────┐
│ Org Chart                        │
│                                  │
│ ● Alice (CEO)                    │
│ |-- ● Bob (CTO)                 │
│ |   |-- ○ Carol (Engineer)      │
│ |   +-- ● Dave (Engineer)       │
│ +-- ! Eve (CFO)                 │
│     +-- ○ Frank (Analyst)       │
│                                  │
│ [View full org chart ->]         │
└─────────────────────────────────┘
```

**Data source:** `agentsApi.orgChart(companyId)` — already called.

**Layout:**
- Container: `rounded-lg border border-border bg-card p-3 text-sm`
- Tree rendered with left padding per depth level (`pl-4` per level)
- Each node: status dot + name `text-xs font-medium` + role `text-[10px] text-muted-foreground`
- Connector lines: `border-l border-border/50` with `before:` pseudo-elements or unicode box-drawing chars
- Max depth 3, collapse deeper levels with "..."

---

## Step 7: Wire Up Render Props

**File:** `ui/src/hooks/useCopilotActions.tsx`

For each tool, add a `render` prop that returns the corresponding chat component. The pattern depends on whether the component is read-only or interactive:

### Read-only renders (Steps 1-4, 6) — on `useFrontendTool`:
```tsx
useFrontendTool({
  name: "getDashboard",
  // ... existing config ...
  render: ({ status, result }) => {
    if (status === ToolCallStatus.Complete && result) {
      return <ChatDashboardCard data={result} onNavigate={navigate} />;
    }
    return <ChatLoadingSkeleton />;
  },
});
```

### Interactive renders (Step 5 — approvals) — on `useHumanInTheLoop`:
```tsx
useHumanInTheLoop({
  name: "reviewApproval",
  // ... config ...
  render: ({ args, respond, status }) => {
    if (status === ToolCallStatus.Complete) return <p>Done.</p>;
    if (status === ToolCallStatus.Executing && respond) {
      return <ChatApprovalCard approvalId={args.approvalId} onDecision={respond} />;
    }
    return null;
  },
});
```

### Loading state (optional):
Add a simple `ChatLoadingSkeleton` component — a `rounded-lg border border-border bg-card p-3 animate-pulse` with gray placeholder blocks. Used when `status !== ToolCallStatus.Complete`.

---

## Demo Flow

Recommended sequence for a live demo:

1. **"How's ACME doing?"** -> `getDashboard` -> ChatDashboardCard (metrics + budget bar)
2. **"Show me the agents"** -> `listAgents` -> ChatAgentStatusGrid (2x2 grid with status dots)
3. **"What's in the backlog?"** -> `listIssues` with status=backlog -> ChatIssueList (priority-colored rows)
4. **"What's our spend this month?"** -> `getCostSummary` + `getCostsByAgent` -> ChatCostBreakdown (budget ring + top spenders)
5. **"Any pending approvals?"** -> `listApprovals` -> ChatApprovalCard (with action buttons)
6. **"Approve it"** -> inline approve click -> confirmation inline
7. **"Show me the org chart"** -> `getAgentOrgChart` -> ChatOrgChart (indented tree)

This demonstrates: **data viz**, **actionable UI**, **navigation**, and **live state** — all inline in the chat.

---

## Implementation Order

| Step | Component | Effort | Demo Impact |
|------|-----------|--------|-------------|
| 1 | ChatDashboardCard | Small | **High** — single card shows the entire value prop |
| 2 | ChatAgentStatusGrid | Small | High — live status is visually compelling |
| 3 | ChatIssueList | Small | Medium — bread-and-butter feature |
| 4 | ChatCostBreakdown | Medium | High — budget viz is unique to Paperclip |
| 5 | ChatApprovalCard | Medium | **High** — interactive approval is the "wow" moment |
| 6 | ChatOrgChart | Small | Medium — simple tree but looks polished |

Steps 1-3 can ship as a first pass. Steps 4-6 add depth.
