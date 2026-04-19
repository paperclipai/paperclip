// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueChecklistItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChecklistSection } from "./IssueChecklistSection";

const mockIssuesApi = vi.hoisted(() => ({
  listChecklistItems: vi.fn(),
  createChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Checklist issue",
    description: null,
    dueDate: null,
    status: "todo",
    boardPosition: 0,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
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
    checklistItems: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
  };
}

function createChecklistItem(overrides: Partial<IssueChecklistItem> = {}): IssueChecklistItem {
  return {
    id: "item-1",
    companyId: "company-1",
    issueId: "issue-1",
    title: "Wire the API",
    position: 0,
    completedAt: null,
    completedByAgentId: null,
    completedByUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function renderSection(container: HTMLDivElement, issue: Issue) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueChecklistSection issue={issue} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("IssueChecklistSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    mockIssuesApi.listChecklistItems.mockResolvedValue([]);
    mockIssuesApi.createChecklistItem.mockImplementation(async (_issueId: string, data: { title: string }) =>
      createChecklistItem({ id: "created-item", title: data.title }),
    );
    mockIssuesApi.updateChecklistItem.mockImplementation(async (id: string, data: Partial<IssueChecklistItem> & { completed?: boolean }) =>
      createChecklistItem({
        id,
        title: data.title ?? "Wire the API",
        completedAt: data.completed ? new Date("2026-04-06T13:00:00.000Z") : null,
      }),
    );
    mockIssuesApi.deleteChecklistItem.mockResolvedValue(createChecklistItem());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders checklist progress", async () => {
    const items = [
      createChecklistItem(),
      createChecklistItem({
        id: "item-2",
        title: "Polish the UI",
        position: 1,
        completedAt: new Date("2026-04-06T13:00:00.000Z"),
      }),
    ];
    mockIssuesApi.listChecklistItems.mockResolvedValue(items);
    const root = renderSection(container, createIssue({ checklistItems: items }));
    await flush();

    expect(container.textContent).toContain("Checklist");
    expect(container.textContent).toContain("1/2");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(container.textContent).toContain("Wire the API");
    expect(container.textContent).toContain("Polish the UI");

    act(() => root.unmount());
  });

  it("adds a checklist item", async () => {
    mockIssuesApi.listChecklistItems
      .mockResolvedValueOnce([])
      .mockResolvedValue([createChecklistItem({ id: "created-item", title: "Write tests" })]);
    const root = renderSection(container, createIssue());
    await flush();

    const input = container.querySelector('input[placeholder="Add checklist item..."]') as HTMLInputElement;
    act(() => {
      changeInputValue(input, "Write tests");
    });
    await act(async () => {
      container.querySelector("button:last-child")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(mockIssuesApi.createChecklistItem).toHaveBeenCalledWith("issue-1", { title: "Write tests" });
    expect(container.textContent).toContain("Write tests");

    act(() => root.unmount());
  });

  it("toggles a checklist item complete", async () => {
    const item = createChecklistItem();
    mockIssuesApi.listChecklistItems.mockResolvedValue([item]);
    const root = renderSection(container, createIssue({ checklistItems: [item] }));
    await flush();

    const checkbox = container.querySelector('[aria-label="Mark checklist item complete"]')!;
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.updateChecklistItem).toHaveBeenCalledWith("item-1", { completed: true });

    act(() => root.unmount());
  });

  it("hides checked checklist items", async () => {
    const items = [
      createChecklistItem({ title: "Wire the API" }),
      createChecklistItem({
        id: "item-2",
        title: "Polish the UI",
        position: 1,
        completedAt: new Date("2026-04-06T13:00:00.000Z"),
      }),
    ];
    mockIssuesApi.listChecklistItems.mockResolvedValue(items);
    const root = renderSection(container, createIssue({ checklistItems: items }));
    await flush();

    await act(async () => {
      container.querySelector('[aria-label="Hide checked checklist items"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Wire the API");
    expect(container.textContent).not.toContain("Polish the UI");

    act(() => root.unmount());
  });

  it("edits a checklist item title", async () => {
    const item = createChecklistItem();
    mockIssuesApi.listChecklistItems.mockResolvedValue([item]);
    const root = renderSection(container, createIssue({ checklistItems: [item] }));
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Wire the API")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const editInput = Array.from(container.querySelectorAll("input"))
      .find((input) => input.value === "Wire the API") as HTMLInputElement;
    act(() => {
      changeInputValue(editInput, "Wire the API route");
    });
    await act(async () => {
      editInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.updateChecklistItem).toHaveBeenCalledWith("item-1", { title: "Wire the API route" });

    act(() => root.unmount());
  });

  it("restores a deleted item when delete fails", async () => {
    const item = createChecklistItem();
    mockIssuesApi.listChecklistItems.mockResolvedValue([item]);
    mockIssuesApi.deleteChecklistItem.mockRejectedValue(new Error("Nope"));
    const root = renderSection(container, createIssue({ checklistItems: [item] }));
    await flush();

    await act(async () => {
      container.querySelector('[aria-label="Delete checklist item"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Wire the API");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Checklist item was not deleted" }));

    act(() => root.unmount());
  });
});
