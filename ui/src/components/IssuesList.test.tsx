// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./IssueRow", () => ({
  IssueRow: ({
    issue,
    desktopMetaLeading,
    desktopTrailing,
  }: {
    issue: Issue;
    desktopMetaLeading?: ReactNode;
    desktopTrailing?: ReactNode;
  }) => (
    <div data-testid="issue-row">
      <span>{issue.title}</span>
      {desktopMetaLeading}
      {desktopTrailing}
    </div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KanbanBoard: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {node}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("IssuesList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders server search results instead of filtering the full issue list locally", async () => {
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });
    const serverIssue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });

    mockIssuesApi.list.mockResolvedValue([serverIssue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { q: "server", projectId: undefined });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("debounces search updates so typing does not notify the page on every keystroke", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onSearchChange={onSearchChange}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    expect(valueSetter).toBeTypeOf("function");

    act(() => {
      if (!input || !valueSetter) return;
      valueSetter.call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter.call(input, "ab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(149);
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith("ab");

    act(() => {
      root.unmount();
    });
  });

  it("reuses the inbox issue column controls and persisted column visibility", async () => {
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["id", "assignee"]));

    const assignedIssue = createIssue({
      id: "issue-assigned",
      identifier: "PAP-9",
      title: "Assigned issue",
      assigneeAgentId: "agent-1",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[assignedIssue]}
        agents={[{ id: "agent-1", name: "Agent One" }]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const columnsButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Columns",
      );
      expect(columnsButton).not.toBeUndefined();
      expect(container.textContent).toContain("PAP-9");
      expect(container.textContent).toContain("Agent One");
      expect(container.textContent).not.toContain("Updated");
    });

    act(() => {
      root.unmount();
    });
  });

  it("filters the list to a single workspace when a workspace name is clicked", async () => {
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["id", "workspace"]));
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.list.mockResolvedValue([
      {
        id: "workspace-alpha",
        name: "Alpha",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
      {
        id: "workspace-beta",
        name: "Beta",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
    ]);

    const alphaIssue = createIssue({
      id: "issue-alpha",
      identifier: "PAP-20",
      title: "Alpha issue",
      executionWorkspaceId: "workspace-alpha",
    });
    const betaIssue = createIssue({
      id: "issue-beta",
      identifier: "PAP-21",
      title: "Beta issue",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[alphaIssue, betaIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha issue");
      expect(container.textContent).toContain("Beta issue");
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      expect(workspaceButton).not.toBeUndefined();
    });

    await act(async () => {
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      workspaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha issue");
      expect(container.textContent).not.toContain("Beta issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides routine-backed issues by default and reveals them when the routine filter is enabled", async () => {
    const manualIssue = createIssue({
      id: "issue-manual",
      identifier: "PAP-10",
      title: "Manual issue",
      originKind: "manual",
    });
    const routineIssue = createIssue({
      id: "issue-routine",
      identifier: "PAP-11",
      title: "Routine issue",
      originKind: "routine_execution",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[manualIssue, routineIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableRoutineVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Manual issue");
      expect(container.textContent).not.toContain("Routine issue");
    });

    await act(async () => {
      const filterButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Filter",
      );
      filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Show routine runs"),
      );
      expect(toggle).not.toBeUndefined();
    });

    await act(async () => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Show routine runs"),
      );
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Routine issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Enter without clearing the query", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="bug"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("bug");

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Escape once the field is empty", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch=""
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);

    act(() => {
      root.unmount();
    });
  });
});
