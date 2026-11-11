// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentTasksWidget } from "./ListWidgets";

const TASK_COUNT = 600;
const READ_LIMIT = TASK_COUNT * 2;

const reads = vi.hoisted(() => ({ total: 0, limit: Number.POSITIVE_INFINITY }));
const issuesQuery = vi.hoisted(() => ({ data: undefined as unknown, error: null, refetch: () => {}, isFetching: false }));
const shown = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("./data", () => ({
  useCompanyIssues: () => issuesQuery,
  useCompanyAgents: () => ({ data: [] }),
  useRecentActivity: () => ({ data: [] }),
}));
vi.mock("@/components/TaskSummaryList", () => ({
  TaskSummaryList: ({ issues }: { issues: ReadonlyArray<{ id: string }> }) => {
    shown.ids = issues.map((issue) => issue.id);
    return <ul>{issues.map((issue) => <li key={issue.id}>{issue.id}</li>)}</ul>;
  },
}));
vi.mock("@/components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("@/components/ActivityList", () => ({ ActivityList: () => null }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tasks(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const updatedAt = new Date(Date.UTC(2026, 0, 1) + ((index * 7_919) % count) * 60_000).toISOString();
    return {
      id: `task-${index}`,
      get updatedAt() {
        reads.total += 1;
        if (reads.total > reads.limit) throw new Error(`Task timestamp read limit exceeded: ${reads.total}`);
        return updatedAt;
      },
    };
  });
}

const placement = { instanceId: "recent-tasks", widgetId: "recent-tasks", w: 2, h: 2 };

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<RecentTasksWidget companyId="company-1" placement={placement} />);
  });
}

beforeEach(() => {
  reads.total = 0;
  reads.limit = READ_LIMIT;
  shown.ids = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("RecentTasksWidget with 600 tasks", () => {
  it("reads each task timestamp once, shows the newest tasks and does no work on an equal re-render", async () => {
    const list = tasks(TASK_COUNT);
    const newest = list
      .map((task, index) => ({ id: task.id, minute: (index * 7_919) % TASK_COUNT }))
      .sort((a, b) => b.minute - a.minute)
      .slice(0, 10)
      .map((task) => task.id);
    issuesQuery.data = list;
    await render();
    expect(reads.total).toBe(TASK_COUNT);
    expect(shown.ids).toEqual(newest);

    await render();
    expect(reads.total).toBe(TASK_COUNT);
  });
});
