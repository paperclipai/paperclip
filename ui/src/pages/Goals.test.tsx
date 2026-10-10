// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { Goals } from "./Goals";

const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockOpenNewGoal = vi.hoisted(() => vi.fn());

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewGoal: mockOpenNewGoal }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));
// Keep the test on the page's query-state handling, not the tree renderer.
vi.mock("../components/GoalTree", () => ({
  GoalTree: ({ goals }: { goals: Array<{ id: string; title: string }> }) => (
    <ul aria-label="Goal tree">{goals.map((goal) => <li key={goal.id}>{goal.title}</li>)}</ul>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as Promise<void> | undefined;
  if (maybePromise !== undefined && typeof maybePromise.then === "function") {
    return maybePromise.then(() => {
      flushSync(() => {});
    });
  }
  return result;
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function goal(id: string, title: string) {
  return { id, title } as never;
}

const transient = () => new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });

describe("Goals", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGoalsApi.list.mockResolvedValue([goal("goal-1", "Ship the release")]);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  function render(client: QueryClient) {
    const tree = (
      <QueryClientProvider client={client}>
        <Goals />
      </QueryClientProvider>
    );
    return act(async () => {
      root = createRoot(container);
      root.render(tree);
    });
  }

  it("keeps loaded goals on screen when a refetch fails transiently", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(queryClient);
    await flushQueries();
    expect(container.textContent).toContain("Ship the release");

    // The next load fails during a deploy: the cached list stays, no error UI.
    mockGoalsApi.list.mockRejectedValueOnce(transient());
    await act(async () => {
      await queryClient.invalidateQueries({ refetchType: "active" });
    });
    await flushQueries();

    expect(container.textContent).toContain("Ship the release");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("tenant_app_unavailable");
  });

  it("shows readable copy with Retry on a real failure before the first load", async () => {
    mockGoalsApi.list.mockReset();
    // A raw machine code must never reach the page: shared copy replaces it.
    mockGoalsApi.list.mockRejectedValue(new ApiError("boom_stack_trace", 500, { error: "boom_stack_trace" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(queryClient);
    await flushQueries();

    const alert = container.querySelector('[data-query-view="error"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load goals");
    expect(alert?.textContent).toContain("unexpected error");
    expect(alert?.textContent).not.toContain("boom_stack_trace");
    expect(alert?.querySelector("button")?.textContent).toContain("Retry");
    // Retry goes through the query, which now succeeds.
    mockGoalsApi.list.mockResolvedValue([goal("goal-1", "Ship the release")]);
    const retryButton = alert!.querySelector("button")!;
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushQueries();
    expect(container.textContent).toContain("Ship the release");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  });

  it("shows the skeleton, not an empty state, when the first load is paused on an outage", async () => {
    // Paused queries report isLoading=false, so gating on it alone would
    // render the empty state during an outage; the view state must win.
    mockGoalsApi.list.mockReset();
    mockGoalsApi.list.mockReturnValue(new Promise(() => {}));
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await render(queryClient);
      await flushQueries();

      expect(container.textContent).not.toContain("No goals yet");
      expect(container.querySelector('[data-query-view="error"]')).toBeNull();
      expect(container.querySelector('[aria-label="Goal tree"]')).toBeNull();
    } finally {
      onlineManager.setOnline(true);
    }
  });
});
