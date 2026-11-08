// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listAll: vi.fn(),
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockKanbanBoard = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockExternalObjectsApi = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    ...mockIssuesApi,
    listCompact: mockIssuesApi.list,
  },
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: mockExternalObjectsApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./IssueRow", () => ({
  IssueRow: ({ issue, leadingControl }: { issue: Issue; leadingControl?: ReactNode }) => (
    <div data-testid="issue-row"><span>{issue.title}</span>{leadingControl}</div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD: 100,
  KANBAN_COLD_STATUSES: ["backlog", "done", "cancelled"],
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE: 10,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS: [10, 25, 50],
  KanbanBoard: (props: {
    issues: Issue[];
    compactCards?: boolean;
    collapsedStatuses?: string[];
    initialVisibleCount?: number;
    revealIncrement?: number;
  }) => {
    mockKanbanBoard(props);
    return (
      <div data-testid="kanban-board">
        {props.issues.map((issue) => (
          <span key={issue.id}>{issue.title}</span>
        ))}
      </div>
    );
  },
}));

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
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: "person",
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
    workMode: overrides.workMode ?? "standard",
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

function setDocumentScrollMetrics({
  innerHeight,
  scrollY,
  scrollHeight,
}: {
  innerHeight: number;
  scrollY: number;
  scrollHeight: number;
}) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: scrollHeight });
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
    mockKanbanBoard.mockReset();
    mockNavigate.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockExternalObjectsApi.getIssueSummaries.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listAll.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableExternalObjects: false,
      enableStreamlinedUi: true,
    });
    setDocumentScrollMetrics({ innerHeight: 600, scrollY: 0, scrollHeight: 2400 });
    mockExternalObjectsApi.getIssueSummaries.mockResolvedValue({ summaries: {} });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it.each([true, false])("keeps status selections after hierarchy loading and refetch (streamlined=%s)", async (streamlined) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: streamlined });
    const parent = createIssue({ id: "human-root", title: "Human parent", createdByUserId: "person" });
    const children = [
      createIssue({ id: "active-child", title: "Active automated child", status: "todo" }),
      createIssue({ id: "done-child", title: "Done automated child", status: "done" }),
      createIssue({ id: "cancelled-child", title: "Cancelled automated child", status: "cancelled" }),
      createIssue({ id: "display-child", title: "Displayed active child", status: "done", displayStatus: "in_progress" }),
    ].map(issue => ({ ...issue, parentId: parent.id, createdByAgentId: "agent-1" }));
    let resolveChildren!: (issues: Issue[]) => void;
    const pending = new Promise<Issue[]>(resolve => { resolveChildren = resolve; });
    let parentReads = 0;
    const refetchedChild = createIssue({ id: "refetched-done", title: "Refetched completed child", status: "done", parentId: parent.id, createdByAgentId: "agent-1" });
    mockIssuesApi.list.mockImplementation(async (_company, filters) => {
      if (filters.parentIds?.includes(parent.id)) {
        parentReads += 1;
        return parentReads === 1 ? pending : [...children, refetchedChild];
      }
      return [];
    });
    const collectionKey = "paperclip:test-tree-status";
    const preferenceKey = taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey });
    const setStatuses = (statuses: string[]) => {
      localStorage.setItem(`${collectionKey}:company-1`, JSON.stringify({ statuses }));
      localStorage.setItem(preferenceKey, JSON.stringify({
        version: 1, companyId: "company-1", collectionKey,
        columns: ["status", "id", "updated"],
        viewState: { statuses, nestingEnabled: true, showAgentCreatedTasks: false },
      }));
      window.dispatchEvent(new StorageEvent("storage", { key: preferenceKey }));
    };
    setStatuses(["todo", "in_progress"]);
    const { root, queryClient } = renderWithQueryClient(<IssuesList
      issues={[parent]} agents={[]} projects={[]} viewStateKey={collectionKey}
      enableAgentCreatedVisibilityFilter onUpdateIssue={() => undefined}
    />, container);
    const titles = () => [...container.querySelectorAll('[data-testid="issue-row"]')].map(row => row.firstElementChild?.textContent);
    const selectPreset = async (label: string) => {
      const filterButton = [...container.querySelectorAll("button")].find(button => button.title === "Filter" || button.title.startsWith("Filters:"));
      await act(() => filterButton!.click());
      await waitForAssertion(() => expect([...document.querySelectorAll("button")].some(button => button.textContent === label)).toBe(true));
      await act(() => [...document.querySelectorAll("button")].find(button => button.textContent === label)!.click());
      await act(() => filterButton!.click());
    };
    try {
      await waitForAssertion(() => {
        expect(titles()).not.toContain("Done automated child");
        expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ parentIds: [parent.id] }), expect.anything());
      });
      await act(async () => { resolveChildren(children); await pending; });
      await waitForAssertion(() => {
        expect(titles()).toContain("Active automated child");
        expect(titles()).toContain("Displayed active child");
        expect(titles()).not.toContain("Done automated child");
        expect(titles()).not.toContain("Cancelled automated child");
      });
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["issues"] }); });
      await waitForAssertion(() => {
        expect(parentReads).toBe(2);
        expect(titles()).toContain("Active automated child");
        expect(titles()).not.toContain("Done automated child");
        expect(titles()).not.toContain("Cancelled automated child");
        expect(titles()).not.toContain(refetchedChild.title);
      });
      await selectPreset("All");
      await waitForAssertion(() => expect(titles()).toHaveLength(6));
      await selectPreset("Done");
      await waitForAssertion(() => expect(titles()).toHaveLength(0));
      await selectPreset("Active");
      await waitForAssertion(() => expect(titles()).toHaveLength(3));
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([true, false])("keeps Done context beyond excluded intermediate tasks (streamlined=%s)", async (streamlined) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: streamlined });
    const parent = createIssue({ id: "done-root", title: "Completed human parent", status: "done", createdByUserId: "person" });
    const child = createIssue({ id: "active-middle", title: "Excluded active middle", parentId: parent.id, createdByAgentId: "agent-1" });
    const grandchild = createIssue({ id: "cancelled-leaf", title: "Cancelled automated leaf", parentId: child.id, status: "cancelled", createdByAgentId: "agent-1" });
    localStorage.setItem("paperclip:test-done-tree:company-1", JSON.stringify({ statuses: ["done", "cancelled"] }));
    mockIssuesApi.list.mockImplementation(async (_company, filters) => {
      if (filters.parentIds?.includes(parent.id)) return [child];
      if (filters.parentIds?.includes(child.id)) return [grandchild];
      return [];
    });
    const { root, queryClient } = renderWithQueryClient(<IssuesList
      issues={[parent]} agents={[]} projects={[]} viewStateKey="paperclip:test-done-tree"
      initialStatuses={["done", "cancelled"]} enableAgentCreatedVisibilityFilter onUpdateIssue={() => undefined}
    />, container);
    try {
      await waitForAssertion(() => {
        const titles = [...container.querySelectorAll('[data-testid="issue-row"]')].map(row => row.firstElementChild?.textContent);
        expect(titles).toContain(parent.title);
        expect(titles).toContain(grandchild.title);
        expect(titles).not.toContain(child.title);
      });
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

});
