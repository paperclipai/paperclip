// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, RoutineListItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Routines, buildRoutineGroups, sortRoutines } from "./Routines";

let currentSearch = "";

const navigateMock = vi.fn();
const routinesListMock = vi.fn<(companyId: string) => Promise<RoutineListItem[]>>();
const issuesListMock = vi.fn<(companyId: string, filters?: Record<string, unknown>) => Promise<Issue[]>>();
const markdownEditorRenderMock = vi.fn((props: { mentions?: Array<{ id: string; name: string }> }) => props);
const issuesListRenderMock = vi.fn(({ issues }: { issues: Issue[] }) => (
  <div data-testid="issues-list">{issues.map((issue) => issue.title).join(", ")}</div>
));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/routines", search: currentSearch ? `?${currentSearch}` : "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(currentSearch), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/routines", () => ({
  routinesApi: {
    list: (companyId: string) => routinesListMock(companyId),
    create: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters?: Record<string, unknown>) => issuesListMock(companyId, filters),
    update: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
        role: "engineer",
        title: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "process",
        adapterConfig: {},
        contextMode: "thin",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        icon: "code",
        metadata: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        urlKey: "agent-one",
        pauseReason: null,
        pausedAt: null,
        permissions: null,
      },
      {
        id: "agent-2",
        companyId: "company-1",
        name: "Agent Two",
        role: "engineer",
        title: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "process",
        adapterConfig: {},
        contextMode: "thin",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        icon: "code",
        metadata: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        urlKey: "agent-two",
        pauseReason: null,
        pausedAt: null,
        permissions: null,
      },
    ]),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "project-1",
        companyId: "company-1",
        urlKey: "project-alpha",
        goalId: null,
        goalIds: [],
        goals: [],
        name: "Project Alpha",
        description: null,
        status: "in_progress",
        leadAgentId: null,
        targetDate: null,
        color: "#22c55e",
        pauseReason: null,
        pausedAt: null,
        archivedAt: null,
        executionWorkspacePolicy: null,
        codebase: null,
        workspaces: [],
        primaryWorkspace: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "project-2",
        companyId: "company-1",
        urlKey: "project-beta",
        goalId: null,
        goalIds: [],
        goals: [],
        name: "Project Beta",
        description: null,
        status: "in_progress",
        leadAgentId: null,
        targetDate: null,
        color: "#38bdf8",
        pauseReason: null,
        pausedAt: null,
        archivedAt: null,
        executionWorkspacePolicy: null,
        codebase: null,
        workspaces: [],
        primaryWorkspace: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn(async () => ({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: {
            name: "Taylor",
            email: "taylor@example.com",
            image: null,
          },
        },
      ],
    })),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: vi.fn(async () => []),
  },
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: { issues: Issue[] }) => issuesListRenderMock(props),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => (
    <div>{items.map((item) => item.label).join(", ")}</div>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: (props: { mentions?: Array<{ id: string; name: string }> }) => {
    markdownEditorRenderMock(props);
    return <div data-testid="markdown-editor" />;
  },
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: () => <button type="button">selector</button>,
}));

vi.mock("../components/RoutineRunVariablesDialog", () => ({
  RoutineRunVariablesDialog: () => null,
  routineRunNeedsConfiguration: () => false,
}));

vi.mock("../components/RoutineVariablesEditor", () => ({
  RoutineVariablesEditor: () => null,
  RoutineVariablesHint: () => null,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createRoutine(overrides: Partial<RoutineListItem>): RoutineListItem {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: "project-1",
    goalId: null,
    parentIssueId: null,
    title: "Routine title",
    description: null,
    assigneeAgentId: "agent-1",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1000",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Routine execution issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1000,
    originKind: "routine_execution",
    originId: "routine-1",
    originRunId: null,
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
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: new Date("2026-04-01T00:00:00.000Z"),
    isUnreadForMe: false,
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("Routines page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSearch = "";
    navigateMock.mockReset();
    routinesListMock.mockReset();
    issuesListMock.mockReset();
    markdownEditorRenderMock.mockClear();
    issuesListRenderMock.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("groups routines by project using project names for the section labels", () => {
    const groups = buildRoutineGroups(
      [
        createRoutine({ id: "routine-1", title: "Morning sync", projectId: "project-1" }),
        createRoutine({ id: "routine-2", title: "Weekly digest", projectId: "project-2", assigneeAgentId: "agent-2" }),
      ],
      "project",
      new Map([
        ["project-1", { name: "Project Alpha" }],
        ["project-2", { name: "Project Beta" }],
      ]),
      new Map([
        ["agent-1", { name: "Agent One" }],
        ["agent-2", { name: "Agent Two" }],
      ]),
    );

    expect(groups.map((group) => group.label)).toEqual(["Project Alpha", "Project Beta"]);
    expect(groups[0]?.items.map((item) => item.title)).toEqual(["Morning sync"]);
    expect(groups[1]?.items.map((item) => item.title)).toEqual(["Weekly digest"]);
  });

  it("sorts routines by selected field and direction without mutating the source list", () => {
    const routines = [
      createRoutine({
        id: "routine-1",
        title: "Weekly digest",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-03T00:00:00.000Z"),
        lastRun: {
          id: "run-1",
          companyId: "company-1",
          routineId: "routine-1",
          triggerId: null,
          source: "manual",
          status: "succeeded",
          triggeredAt: new Date("2026-04-02T00:00:00.000Z"),
          idempotencyKey: null,
          triggerPayload: null,
          dispatchFingerprint: null,
          linkedIssueId: null,
          coalescedIntoRunId: null,
          failureReason: null,
          completedAt: null,
          createdAt: new Date("2026-04-02T00:00:00.000Z"),
          updatedAt: new Date("2026-04-02T00:00:00.000Z"),
          linkedIssue: null,
          trigger: null,
        },
      }),
      createRoutine({
        id: "routine-2",
        title: "Morning sync",
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
        updatedAt: new Date("2026-04-04T00:00:00.000Z"),
        lastRun: null,
      }),
    ];

    expect(sortRoutines(routines, "title", "asc").map((routine) => routine.title)).toEqual([
      "Morning sync",
      "Weekly digest",
    ]);
    expect(sortRoutines(routines, "updated", "desc").map((routine) => routine.id)).toEqual([
      "routine-2",
      "routine-1",
    ]);
    expect(sortRoutines(routines, "lastRun", "desc").map((routine) => routine.id)).toEqual([
      "routine-1",
      "routine-2",
    ]);
    expect(routines.map((routine) => routine.id)).toEqual(["routine-1", "routine-2"]);
  });

  it("renders the routines sort control before the group control", async () => {
    routinesListMock.mockResolvedValue([]);
    issuesListMock.mockResolvedValue([]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Routines />
        </QueryClientProvider>,
      );
      await flush();
    });

    let sortButton = container.querySelector<HTMLButtonElement>('button[title="Sort"]');
    let groupButton = container.querySelector<HTMLButtonElement>('button[title="Group"]');
    for (let attempts = 0; attempts < 5 && (!sortButton || !groupButton); attempts += 1) {
      await act(async () => {
        await flush();
      });
      sortButton = container.querySelector<HTMLButtonElement>('button[title="Sort"]');
      groupButton = container.querySelector<HTMLButtonElement>('button[title="Group"]');
    }

    expect(sortButton).not.toBeNull();
    expect(groupButton).not.toBeNull();
    expect(sortButton!.compareDocumentPosition(groupButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("passes company mention options to the routine description editor", async () => {
    routinesListMock.mockResolvedValue([]);
    issuesListMock.mockResolvedValue([]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Routines />
        </QueryClientProvider>,
      );
      await flush();
    });

    let createButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create routine"),
    );
    for (let attempts = 0; attempts < 5 && !createButton; attempts += 1) {
      await act(async () => {
        await flush();
      });
      createButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Create routine"),
      );
    }

    expect(createButton).toBeTruthy();

    await act(async () => {
      createButton?.click();
      await flush();
    });

    for (let attempts = 0; attempts < 5; attempts += 1) {
      const hasMentionOptions = markdownEditorRenderMock.mock.calls.some(([props]) => (props.mentions ?? []).length > 0);
      if (hasMentionOptions) break;
      await act(async () => {
        await flush();
      });
    }

    const callsWithMentions = markdownEditorRenderMock.mock.calls
      .map(([props]) => props.mentions ?? [])
      .filter((mentions) => mentions.length > 0);

    expect(callsWithMentions.at(-1)?.map((mention) => mention.id)).toEqual([
      "user:user-1",
      "agent:agent-1",
      "agent:agent-2",
      "project:project-1",
      "project:project-2",
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows recent runs through the issues list scoped to routine execution issues", async () => {
    currentSearch = "tab=runs";
    routinesListMock.mockResolvedValue([createRoutine({ id: "routine-1" })]);
    issuesListMock.mockResolvedValue([
      createIssue({ id: "issue-1", title: "Routine execution A" }),
      createIssue({ id: "issue-2", title: "Routine execution B", identifier: "PAP-1001", issueNumber: 1001 }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Routines />
        </QueryClientProvider>,
      );
      await flush();
    });

    expect(issuesListMock).toHaveBeenCalledWith("company-1", { originKind: "routine_execution" });

    await act(async () => {
      root.unmount();
    });
  });
});
