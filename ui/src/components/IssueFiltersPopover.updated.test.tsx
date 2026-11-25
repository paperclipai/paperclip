// @vitest-environment jsdom

import { act, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { useIssueUpdatedFilterNow } from "../hooks/useIssueUpdatedFilterNow";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueUpdatedServerBefore,
  type IssueFilterState,
} from "../lib/issue-filters";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
    <input {...props} type="checkbox" checked={checked} onChange={event => onCheckedChange?.(event.target.checked)} />
  ),
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

function makeIssue(id: string, title: string, updatedAt: Date, lastActivityAt?: Date): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    createdAt: updatedAt,
    updatedAt,
    lastActivityAt: lastActivityAt ?? null,
    lastExternalCommentAt: null,
    workMode: "standard",
  };
}

describe("IssueFiltersPopover Updated time filter", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["legacy", "streamlined", "refreshed"] as const)("filters tasks by Updated time window and custom range in %s", presentation => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    const tasks = [
      makeIssue("fresh", "Fresh task", new Date("2026-11-14T12:00:00.000Z")),
      makeIssue("commented", "Recently active task", new Date("2026-10-01T12:00:00.000Z"), new Date("2026-11-13T12:00:00.000Z")),
      makeIssue("mid", "Mid-window task", new Date("2026-11-05T12:00:00.000Z")),
      makeIssue("old", "Old task", new Date("2026-10-10T12:00:00.000Z")),
    ];

    function Harness() {
      const [state, setState] = useState<IssueFilterState>(defaultIssueFilterState);
      const visible = applyIssueFilters(tasks, state, null, false, undefined, {}, now);
      return (
        <>
          <IssueFiltersPopover
            presentation={presentation}
            state={state}
            onChange={(patch) => setState((prev) => ({ ...prev, ...patch }))}
            activeFilterCount={countActiveIssueFilters(state)}
          />
          <ul data-testid="visible-tasks">
            {visible.map((task) => <li key={task.id}>{task.id}</li>)}
          </ul>
          <output data-testid="updated-before">{issueUpdatedServerBefore(state) ?? ""}</output>
        </>
      );
    }

    const root = createRoot(container);
    act(() => root.render(<Harness />));

    const visibleIds = () => Array.from(container.querySelectorAll('[data-testid="visible-tasks"] li')).map(el => el.textContent);
    const updated = () => container.querySelector('[data-filter-options="updated"]')!;
    const option = (label: string) =>
      Array.from(updated().querySelectorAll("button, label")).find(el => el.textContent === label) as HTMLElement;

    expect(updated().textContent).toBe("Any timeLast 24 hoursLast 3 daysLast 7 daysLast 30 daysCustom range");
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(visibleIds()).toEqual(["fresh", "commented", "mid", "old"]);

    // Pick Last 3 days — keeps fresh + recently active task, hides older ones.
    act(() => (option("Last 3 days").querySelector("input") ?? option("Last 3 days")).click());
    expect(visibleIds()).toEqual(["fresh", "commented"]);
    expect(container.querySelector('[data-testid="updated-before"]')?.textContent).toBe("");

    // Switch to Custom range and set From / To dates.
    act(() => (option("Custom range").querySelector("input") ?? option("Custom range")).click());
    const from = container.querySelector<HTMLInputElement>('input[aria-label="Updated from"]');
    const to = container.querySelector<HTMLInputElement>('input[aria-label="Updated to"]');
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    act(() => setInputValue(from!, "2026-11-04"));
    act(() => setInputValue(to!, "2026-11-06"));
    expect(to!.min).toBe("2026-11-04");
    expect(visibleIds()).toEqual(["mid"]);
    expect(container.querySelector('[data-testid="updated-before"]')?.textContent).toBe(new Date(2026, 10, 7).toISOString());

    // Clear resets Updated filter and shows all tasks again.
    const clearButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Clear");
    expect(clearButton).toBeDefined();
    act(() => clearButton!.click());
    expect(visibleIds()).toEqual(["fresh", "commented", "mid", "old"]);

    act(() => root.unmount());
  });

  it("drops a task from Last 24 hours automatically when wall-clock time crosses the window", () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T12:00:00.000Z") });
    const root = createRoot(container);
    try {
      const tasks = [
        makeIssue("aging", "Aging task", new Date("2026-11-14T13:00:00.000Z")), // 23h old
        makeIssue("fresh", "Fresh task", new Date("2026-11-15T11:00:00.000Z")), // 1h old
      ];
      const filters: IssueFilterState = { ...defaultIssueFilterState, updatedWithin: "24h" };

      function MemoizedListHarness() {
        const updatedNow = useIssueUpdatedFilterNow(tasks, filters.updatedWithin);
        const visible = useMemo(
          () => applyIssueFilters(tasks, filters, null, false, undefined, {}, updatedNow),
          [updatedNow],
        );
        return (
          <ul data-testid="aging-tasks">
            {visible.map((task) => <li key={task.id}>{task.id}</li>)}
          </ul>
        );
      }

      act(() => root.render(<MemoizedListHarness />));
      const ids = () => Array.from(container.querySelectorAll('[data-testid="aging-tasks"] li')).map(el => el.textContent);
      expect(ids()).toEqual(["aging", "fresh"]);

      // Advance 2 hours with no task data changes: "aging" is now 25h old and drops out.
      act(() => {
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      });
      expect(ids()).toEqual(["fresh"]);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
    }
  });

  it("bounds timestamp reads on large collections across expiry and unchanged rerenders", () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T12:00:00.000Z") });
    const root = createRoot(container);
    try {
      const count = 500;
      const maxReads = count * 5;
      let timestampReads = 0;

      const tasks: Issue[] = Array.from({ length: count }, (_, index) => {
        // First task is 23h old (ages out in 1h); remaining 499 are 1h-10h old.
        const ageMs = index === 0
          ? 23 * 60 * 60 * 1000
          : (1 + (index % 9)) * 60 * 60 * 1000;
        const storedUpdatedAt = new Date(Date.now() - ageMs);
        const task = makeIssue(`task-${index}`, `Task ${index}`, storedUpdatedAt);
        Object.defineProperty(task, "updatedAt", {
          enumerable: true,
          get() {
            timestampReads += 1;
            if (timestampReads > maxReads) {
              throw new Error(`Exceeded bounded timestamp reads (${timestampReads} > ${maxReads})`);
            }
            return storedUpdatedAt;
          },
        });
        return task;
      });

      const filters: IssueFilterState = { ...defaultIssueFilterState, updatedWithin: "24h" };

      function LargeListHarness({ unrelatedProp }: { unrelatedProp: number }) {
        const updatedNow = useIssueUpdatedFilterNow(tasks, filters.updatedWithin);
        const visible = useMemo(
          () => applyIssueFilters(tasks, filters, null, false, undefined, {}, updatedNow),
          [updatedNow],
        );
        return <output data-testid="large-count" data-prop={unrelatedProp}>{visible.length}</output>;
      }

      act(() => root.render(<LargeListHarness unrelatedProp={1} />));
      expect(container.querySelector('[data-testid="large-count"]')?.textContent).toBe("500");
      const readsAfterMount = timestampReads;
      expect(readsAfterMount).toBe(count * 2);

      // Unchanged rerender hits memoization with zero extra scans.
      act(() => root.render(<LargeListHarness unrelatedProp={2} />));
      expect(timestampReads).toBe(readsAfterMount);

      // Advance past the first task's 24h boundary: exactly one expiry refresh scan runs.
      act(() => {
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      });
      expect(container.querySelector('[data-testid="large-count"]')?.textContent).toBe("499");
      const readsAfterExpiry = timestampReads;
      expect(readsAfterExpiry).toBe(count * 4);

      // Subsequent unchanged rerender still performs zero extra scans.
      act(() => root.render(<LargeListHarness unrelatedProp={3} />));
      expect(timestampReads).toBe(readsAfterExpiry);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
    }
  });
});
