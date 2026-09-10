// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Issues } from "./Issues";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listCompact: vi.fn(),
  listLabels: vi.fn(),
  update: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

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
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
  useToast: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: mockOpenNewIssue }),
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: "/issues", search: "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(""), vi.fn()],
  Link: ({
    children,
    to,
  }: {
    children: ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
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

vi.mock("../hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true }),
}));

vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }),
  usePublishSharedQueryData: () => undefined,
}));

vi.mock("../components/IssueRow", () => ({
  IssueRow: ({ issue, statusSlot }: { issue: Issue; statusSlot?: ReactNode }) => (
    <div data-testid="issue-row">
      <span>{issue.title}</span>
      {statusSlot}
    </div>
  ),
}));

vi.mock("../components/KanbanBoard", () => ({
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD: 100,
  KANBAN_COLD_STATUSES: ["backlog", "done", "cancelled"],
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE: 10,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS: [10, 25, 50],
  KanbanBoard: () => <div data-testid="kanban-board" />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mountedRoots: Root[] = [];


async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 40) {
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
    workMode: overrides.workMode ?? "standard",
  };
}

function renderIssuesPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
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
          <Issues />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Issues status errors", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    mockPushToast.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listCompact.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockIssuesApi.update.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockExternalObjectsApi.getIssueSummaries.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listCompact.mockResolvedValue([createIssue()]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
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
    mockExternalObjectsApi.getIssueSummaries.mockResolvedValue({ summaries: {} });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("surfaces a rejected Done transition instead of snapping back silently", async () => {
    mockIssuesApi.update.mockRejectedValue(new Error("Done blocked by the delivery gate"));
    const container = renderIssuesPage();

    await waitForAssertion(() => {
      expect(container.querySelector('button[aria-label^="Change status"]')).toBeTruthy();
    });

    click(container.querySelector('button[aria-label^="Change status"]')!);

    await waitForAssertion(() => {
      const doneOption = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.endsWith("Done"),
      );
      expect(doneOption).toBeTruthy();
    });

    click(
      Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.endsWith("Done"),
      )!,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.update).toHaveBeenCalledWith("issue-1", { status: "done" });
    });

    await waitForAssertion(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Task update failed", tone: "error" }),
      );
    });
    const toastBody = String(mockPushToast.mock.calls[0]?.[0]?.body ?? "");
    expect(toastBody).toContain("Done blocked by the delivery gate");
  });
});
