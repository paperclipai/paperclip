// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, RoutineListItem } from "@paperclipai/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let Routines: typeof import("./Routines").Routines;
let buildRoutineGroups: typeof import("./Routines").buildRoutineGroups;

let currentSearch = "";

const navigateMock = vi.fn();
const routinesListMock = vi.fn<(companyId: string) => Promise<RoutineListItem[]>>();
const issuesListMock = vi.fn<(companyId: string, filters?: Record<string, unknown>) => Promise<Issue[]>>();
const issuesListRenderMock = vi.fn(({ issues }: { issues: Issue[] }) => (
  <div data-testid="issues-list">{issues.map((issue) => issue.title).join(", ")}</div>
));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: React.ReactNode;
    to?: string | { pathname?: string };
  } & Record<string, unknown>) => (
    <a href={typeof to === "string" ? to : to?.pathname ?? "#"} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/routines", search: currentSearch ? `?${currentSearch}` : "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(currentSearch), vi.fn()],
  useParams: () => ({}),
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

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");
  return {
    MDXEditor: React.forwardRef(function MockMdxEditor(_props, _ref) {
      return <div data-testid="mdx-editor" />;
    }),
    CodeMirrorEditor: () => null,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    headingsPlugin: () => ({}),
    imagePlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
    createRootEditorSubscription$: () => ({}),
    realmPlugin: (plugin: unknown) => () => plugin ?? ({}),
  };
});

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
  TabsList: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsTrigger: ({ children }: { children: unknown }) => <button type="button">{children as never}</button>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div />,
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

const localStorageEntries = new Map<string, string>();

function ensureLocalStorageMock() {
  if (
    typeof globalThis.localStorage?.getItem === "function"
    && typeof globalThis.localStorage?.setItem === "function"
    && typeof globalThis.localStorage?.removeItem === "function"
    && typeof globalThis.localStorage?.clear === "function"
  ) {
    return;
  }

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageEntries.set(key, value);
      },
      removeItem: (key: string) => {
        localStorageEntries.delete(key);
      },
      clear: () => {
        localStorageEntries.clear();
      },
    },
  });
}

type TestGlobals = typeof globalThis & {
  __PAPERCLIP_TEST_COMPANY_CONTEXT__?: {
    selectedCompanyId?: string;
  };
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(async () => {
  ({ Routines, buildRoutineGroups } = await import("./Routines"));
});

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

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }

  throw lastError;
}

describe("Routines page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    ensureLocalStorageMock();
    const testGlobals = globalThis as TestGlobals;
    testGlobals.__PAPERCLIP_TEST_COMPANY_CONTEXT__ = {
      selectedCompanyId: "company-1",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const parsedUrl = new URL(url, "http://localhost");

      if (parsedUrl.pathname === "/api/companies/company-1/routines") {
        return jsonResponse(await routinesListMock("company-1"));
      }

      if (parsedUrl.pathname === "/api/companies/company-1/issues") {
        return jsonResponse(await issuesListMock("company-1", {
          originKind: parsedUrl.searchParams.get("originKind") ?? undefined,
        }));
      }

      if (parsedUrl.pathname === "/api/companies/company-1/agents") {
        return jsonResponse([
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
        ]);
      }

      if (parsedUrl.pathname === "/api/companies/company-1/projects") {
        return jsonResponse([
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
        ]);
      }

      if (parsedUrl.pathname === "/api/instance/settings/experimental") {
        return jsonResponse({ enableIsolatedWorkspaces: false });
      }

      if (parsedUrl.pathname === "/api/companies/company-1/live-runs") {
        return jsonResponse([]);
      }

      throw new Error(`Unhandled fetch in Routines.test.tsx: ${method} ${parsedUrl.pathname}${parsedUrl.search}`);
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSearch = "";
    navigateMock.mockReset();
    routinesListMock.mockReset();
    issuesListMock.mockReset();
    issuesListRenderMock.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    const testGlobals = globalThis as TestGlobals;
    delete testGlobals.__PAPERCLIP_TEST_COMPANY_CONTEXT__;
    vi.unstubAllGlobals();
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

    await waitForAssertion(() => {
      expect(issuesListMock).toHaveBeenCalledWith("company-1", { originKind: "routine_execution" });
    });

    await act(async () => {
      root.unmount();
    });
  });
});
