# Scaled Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Issues Kanban board usable with hundreds of issues by adding compact high-volume rendering, collapsed cold lanes, and per-column reveal controls.

**Architecture:** Keep the change UI-only. `IssuesList` owns persisted board density preferences in existing company-scoped view state, while `KanbanBoard` owns lane rendering, card density, collapsed rails, and per-column "show more" state.

**Tech Stack:** React 19, TypeScript, Vite, Vitest/jsdom, `@dnd-kit/core`, `@dnd-kit/sortable`, Tailwind utility classes.

---

## File Structure

- Modify `ui/src/components/IssuesList.tsx`: extend `IssueViewState`, derive high-volume board preferences, add toolbar controls, pass props into `KanbanBoard`.
- Modify `ui/src/components/KanbanBoard.tsx`: add compact cards, collapsed rail lanes, visible-card limits, and per-column reveal behavior.
- Create `ui/src/components/KanbanBoard.test.tsx`: focused tests for high-volume behavior and drag/drop update callback.
- Modify `ui/src/components/IssuesList.test.tsx`: update the mocked `KanbanBoard` expectations for new props.
- Keep `doc/plans/2026-05-05-scaled-kanban-board-design.md` as the design source of truth.

## Task 1: Add Kanban Board Scaling Mechanics

**Files:**
- Modify: `ui/src/components/KanbanBoard.tsx`
- Create: `ui/src/components/KanbanBoard.test.tsx`

- [ ] **Step 1: Write focused tests**

Create `ui/src/components/KanbanBoard.test.tsx` with tests that render 60 todo issues and assert:

```tsx
renderBoard({ issues: createIssues(60, "todo"), compactCards: true, initialVisibleCount: 10, revealIncrement: 10 });
expect(container.textContent).toContain("Showing 10 of 60");
expect(container.textContent).toContain("Show 10 more");
```

Also test collapsed rails:

```tsx
renderBoard({ issues: createIssues(3, "done"), collapsedStatuses: ["done"] });
expect(container.textContent).toContain("Done");
expect(container.textContent).toContain("3");
expect(container.textContent).not.toContain("Issue 1");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm exec vitest run ui/src/components/KanbanBoard.test.tsx
```

Expected: fail because `KanbanBoard.test.tsx` is new and the props/behavior do not exist.

- [ ] **Step 3: Implement minimal board behavior**

In `KanbanBoard.tsx`, add exported constants:

```ts
export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE = 10;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;
```

Extend props:

```ts
compactCards?: boolean;
collapsedStatuses?: string[];
initialVisibleCount?: number;
revealIncrement?: number;
```

Add per-status visible-count state keyed by status. Expanded columns render `issues.slice(0, visibleCount)` and show a button when hidden issues remain. Collapsed columns render a narrow droppable rail with status icon, label, and count, but no cards.

Reset per-status visible-count state when `initialVisibleCount` or `revealIncrement` changes so choosing a smaller cards-per-column preset does not leave a column expanded past the newly selected page size.

- [ ] **Step 4: Preserve drag/drop**

Keep `DndContext`, `SortableContext`, and `handleDragEnd` status detection. Because collapsed rails use `useDroppable({ id: status })`, dropping a visible card onto a rail continues to resolve `targetStatus` through the existing status-id branch.

- [ ] **Step 5: Run focused test**

Run:

```bash
pnpm exec vitest run ui/src/components/KanbanBoard.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/KanbanBoard.tsx ui/src/components/KanbanBoard.test.tsx
git commit -m "Scale kanban board columns"
```

## Task 2: Wire Board Density State Into IssuesList

**Files:**
- Modify: `ui/src/components/IssuesList.tsx`
- Modify: `ui/src/components/IssuesList.test.tsx`

- [ ] **Step 1: Write/update tests**

In `IssuesList.test.tsx`, update the `KanbanBoard` mock to capture:

```ts
compactCards?: boolean;
collapsedStatuses?: string[];
initialVisibleCount?: number;
revealIncrement?: number;
```

Add a test that stores board mode in localStorage, renders more than 100 issues, and expects:

```ts
expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
  compactCards: true,
  collapsedStatuses: expect.arrayContaining(["backlog", "done", "cancelled"]),
  initialVisibleCount: 10,
  revealIncrement: 10,
}));
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm exec vitest run ui/src/components/IssuesList.test.tsx
```

Expected: fail because `IssuesList` does not pass the new props yet.

- [ ] **Step 3: Add persisted board density preferences**

Extend `IssueViewState`:

```ts
boardCardDensity: "auto" | "compact" | "comfortable";
boardColdLaneMode: "auto" | "collapsed" | "expanded";
boardColumnPageSize: 10 | 25 | 50;
```

Default the density modes to `"auto"` and page size to `10`. Derive:

```ts
const boardHighVolume = viewState.viewMode === "board" && filtered.length > KANBAN_BOARD_HIGH_VOLUME_THRESHOLD;
const boardCompactCards = viewState.boardCardDensity === "compact"
  || (viewState.boardCardDensity === "auto" && boardHighVolume);
const boardCollapsedStatuses = viewState.boardColdLaneMode === "collapsed"
  || (viewState.boardColdLaneMode === "auto" && boardHighVolume)
    ? [...KANBAN_COLD_STATUSES]
    : [];
```

- [ ] **Step 4: Add toolbar controls**

When `viewState.viewMode === "board"`, add small outline/icon buttons near the existing view controls:

```tsx
<Button ... title={boardCompactCards ? "Use comfortable cards" : "Use compact cards"}>...</Button>
<Button ... title={boardCollapsedStatuses.length > 0 ? "Expand cold lanes" : "Collapse cold lanes"}>...</Button>
<Button ... title="Cards per column">...</Button>
<Button ... title="Reset board density">...</Button>
```

Use lucide icons already available or import `ChevronsDownUp`, `PanelTopClose`, and `RotateCcw`.

- [ ] **Step 5: Pass board props**

Update the `KanbanBoard` call:

```tsx
<KanbanBoard
  issues={filtered}
  agents={agents}
  liveIssueIds={liveIssueIds}
  compactCards={boardCompactCards}
  collapsedStatuses={boardCollapsedStatuses}
  initialVisibleCount={viewState.boardColumnPageSize}
  revealIncrement={viewState.boardColumnPageSize}
  onUpdateIssue={onUpdateIssue}
/>
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run ui/src/components/IssuesList.test.tsx ui/src/components/KanbanBoard.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/IssuesList.tsx ui/src/components/IssuesList.test.tsx
git commit -m "Wire issue board density controls"
```

## Task 3: Verification And PR Prep

**Files:**
- Verify existing changes only.

- [ ] **Step 1: Run targeted UI tests**

```bash
pnpm exec vitest run ui/src/components/IssuesList.test.tsx ui/src/components/KanbanBoard.test.tsx
```

Expected: pass.

- [ ] **Step 2: Run broader cheap test path**

```bash
pnpm test
```

Expected: pass.

- [ ] **Step 3: Check worktree**

```bash
git status --short
```

Expected: only intentional changes before committing, or clean after final commit.

- [ ] **Step 4: Prepare PR**

Read `.github/PULL_REQUEST_TEMPLATE.md` and use it for the PR body. Include:

- design spec path
- scaled Kanban behavior summary
- test commands and results
- Model Used section with the current Codex model details available in this session

## Self-Review

- Spec coverage: The plan covers compact high-volume board cards, collapsed cold lanes, cards-per-column presets, per-column reveal controls, persisted board preferences, current API reuse, and focused tests.
- Placeholder scan: No unresolved markers or unspecified implementation placeholders remain.
- Type consistency: The plan consistently uses `boardCardDensity`, `boardColdLaneMode`, `boardColumnPageSize`, `compactCards`, `collapsedStatuses`, `initialVisibleCount`, and `revealIncrement`.
