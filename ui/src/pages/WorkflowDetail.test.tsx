// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkflowGraph, WorkflowDetail } from "./WorkflowDetail";
import { queryKeys } from "../lib/queryKeys";
import type { WorkflowHandoff } from "@paperclipai/shared";

const getWorkflowMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const activityMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
let queryClient: QueryClient | null = null;

vi.mock("@/api/workflows", () => ({
  workflowsApi: {
    get: (id: string) => getWorkflowMock(id),
    listSchedules: vi.fn(() => Promise.resolve([])),
    getRun: (id: string) => getRunMock(id),
    activity: (...args: unknown[]) => activityMock(...args),
    update: vi.fn(),
    run: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    approveHandoff: vi.fn(),
    rejectHandoff: vi.fn(),
    respondHandoff: vi.fn(),
  },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "light",
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Test company", issuePrefix: "TES" },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient = client;

  return act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/workflows/:workflowId" element={<WorkflowDetail />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

const workflowDetail = {
  id: "workflow-1",
  companyId: "company-1",
  title: "Brief generator",
  description: "Generate board-ready briefings.",
  status: "active",
  runnerType: "google_adk",
  runnerConfig: {
    agentPath: "/agents/brief-generator",
    cwd: "/tmp/brief-generator",
    command: "python run.py",
    model: "gpt-4.1",
  },
  pipelineDefinition: {
    entrypoint: "main",
    generatedAt: "2026-06-10T09:00:00.000Z",
    phases: [
      {
        key: "phase-1",
        label: "Draft brief",
        kind: "agent",
        filePath: "workflow.py",
        functionName: "draft_brief",
        ordinal: 0,
        parentKey: null,
        depth: 0,
        agentName: "Writer",
        description: "Draft the briefing.",
      },
    ],
  },
  pipelineSourceHash: null,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-06-10T09:00:00.000Z"),
  updatedAt: new Date("2026-06-10T09:00:00.000Z"),
  latestRun: {
    id: "run-latest",
    companyId: "company-1",
    workflowId: "workflow-1",
    status: "succeeded",
    inputMarkdown: "latest input",
    error: null,
    summary: "Latest run summary",
    provider: "openai",
    model: "gpt-4.1",
    usage: null,
    resultJson: null,
    stdoutExcerpt: null,
    stderrExcerpt: "latest stderr",
    consoleEntries: [],
    contextSnapshot: null,
    startedAt: new Date("2026-06-10T10:01:00.000Z"),
    finishedAt: new Date("2026-06-10T10:02:00.000Z"),
    createdAt: new Date("2026-06-10T10:00:00.000Z"),
    updatedAt: new Date("2026-06-10T10:02:00.000Z"),
  },
  runs: [
    {
      id: "run-latest",
      companyId: "company-1",
      workflowId: "workflow-1",
      status: "succeeded",
      inputMarkdown: "latest input",
      error: null,
      summary: "Latest run summary",
      provider: "openai",
      model: "gpt-4.1",
      usage: null,
      resultJson: null,
      stdoutExcerpt: null,
      stderrExcerpt: "latest stderr",
      consoleEntries: [],
      contextSnapshot: null,
      startedAt: new Date("2026-06-10T10:01:00.000Z"),
      finishedAt: new Date("2026-06-10T10:02:00.000Z"),
      createdAt: new Date("2026-06-10T10:00:00.000Z"),
      updatedAt: new Date("2026-06-10T10:02:00.000Z"),
    },
    {
      id: "run-old",
      companyId: "company-1",
      workflowId: "workflow-1",
      status: "failed",
      inputMarkdown: "older input",
      error: "boom",
      summary: "Older run summary",
      provider: "openai",
      model: "gpt-4.1",
      usage: null,
      resultJson: null,
      stdoutExcerpt: null,
      stderrExcerpt: "older stderr",
      consoleEntries: [],
      contextSnapshot: null,
      startedAt: new Date("2026-06-10T09:56:00.000Z"),
      finishedAt: new Date("2026-06-10T09:56:00.000Z"),
      createdAt: new Date("2026-06-10T09:56:00.000Z"),
      updatedAt: new Date("2026-06-10T09:56:00.000Z"),
    },
  ],
  latestDeliverable: null,
};

const workflowDetailAfterRefresh = {
  ...workflowDetail,
  latestRun: {
    ...workflowDetail.latestRun,
    id: "run-new",
    status: "running",
    inputMarkdown: "new input",
    summary: "Newest run summary",
    stderrExcerpt: "new latest stderr",
    startedAt: new Date("2026-06-10T10:10:00.000Z"),
    finishedAt: null,
    createdAt: new Date("2026-06-10T10:10:00.000Z"),
    updatedAt: new Date("2026-06-10T10:10:00.000Z"),
  },
  runs: [
    {
      id: "run-new",
      companyId: "company-1",
      workflowId: "workflow-1",
      status: "running",
      inputMarkdown: "new input",
      error: null,
      summary: "Newest run summary",
      provider: "openai",
      model: "gpt-4.1",
      usage: null,
      resultJson: null,
      stdoutExcerpt: null,
      stderrExcerpt: "new latest stderr",
      consoleEntries: [],
      contextSnapshot: null,
      startedAt: new Date("2026-06-10T10:10:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-06-10T10:10:00.000Z"),
      updatedAt: new Date("2026-06-10T10:10:00.000Z"),
    },
    ...workflowDetail.runs,
  ],
};

const latestRunDetail = {
  ...workflowDetail.latestRun,
  workflow: {
    id: "workflow-1",
    title: "Brief generator",
    status: "active",
    runnerType: "google_adk",
  },
  phases: [
    {
      id: "phase-1-run-latest",
      companyId: "company-1",
      workflowRunId: "run-latest",
      phaseKey: "phase-1",
      label: "Draft brief",
      kind: "agent",
      ordinal: 0,
      status: "succeeded",
      metadata: {
        filePath: "workflow.py",
        functionName: "draft_brief",
        parentKey: null,
        depth: 0,
        agentName: "Writer",
        description: "Draft the briefing.",
      },
      startedAt: new Date("2026-06-10T10:01:00.000Z"),
      finishedAt: new Date("2026-06-10T10:02:00.000Z"),
      createdAt: new Date("2026-06-10T10:00:00.000Z"),
      updatedAt: new Date("2026-06-10T10:02:00.000Z"),
    },
  ],
  handoffs: [],
  deliverables: [
    {
      id: "deliverable-latest",
      title: "Latest brief",
      audience: "human",
      contentType: "text/markdown",
      contentPath: "/api/deliverables/deliverable-latest/content",
      byteSize: 123,
      originalFilename: "latest.md",
      createdAt: "2026-06-10T10:02:00.000Z",
    },
  ],
  stderrExcerpt: "latest stderr",
  consoleEntries: [],
  resultJson: null,
  stdoutExcerpt: null,
  error: null,
};

const latestRunDetailWithHandoff = {
  ...latestRunDetail,
  handoffs: [
    {
      id: "handoff-latest",
      companyId: "company-1",
      workflowRunId: "run-latest",
      phaseKey: "phase-ghost",
      kind: "response",
      status: "closed",
      promptMarkdown: "Please review the brief.",
      responseMarkdown: "Looks good.",
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-06-10T10:02:30.000Z"),
      updatedAt: new Date("2026-06-10T10:02:30.000Z"),
      bridgeStatus: "closed",
    },
  ],
};

const olderRunDetail = {
  ...workflowDetail.runs[1],
  workflow: {
    id: "workflow-1",
    title: "Brief generator",
    status: "active",
    runnerType: "google_adk",
  },
  phases: [
    {
      id: "phase-1-run-old",
      companyId: "company-1",
      workflowRunId: "run-old",
      phaseKey: "phase-1",
      label: "Draft brief",
      kind: "agent",
      ordinal: 0,
      status: "failed",
      metadata: {
        filePath: "workflow.py",
        functionName: "draft_brief",
        parentKey: null,
        depth: 0,
        agentName: "Writer",
        description: "Draft the briefing.",
      },
      startedAt: new Date("2026-06-10T09:56:00.000Z"),
      finishedAt: new Date("2026-06-10T09:56:00.000Z"),
      createdAt: new Date("2026-06-10T09:56:00.000Z"),
      updatedAt: new Date("2026-06-10T09:56:00.000Z"),
    },
  ],
  handoffs: [],
  deliverables: [
    {
      id: "deliverable-old",
      title: "Older brief",
      audience: "human",
      contentType: "text/markdown",
      contentPath: "/api/deliverables/deliverable-old/content",
      byteSize: 111,
      originalFilename: "old.md",
      createdAt: "2026-06-10T09:56:00.000Z",
    },
  ],
  stderrExcerpt: "older stderr",
  consoleEntries: [],
  resultJson: null,
  stdoutExcerpt: null,
  error: "boom",
};

describe("WorkflowDetail page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getWorkflowMock.mockResolvedValue(workflowDetail);
    getRunMock.mockImplementation((runId: string) =>
      runId === "run-old" ? Promise.resolve(olderRunDetail) : Promise.resolve(latestRunDetail),
    );
    activityMock.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    queryClient?.clear();
    queryClient = null;
    vi.clearAllMocks();
  });

  it("shows the latest run by default and switches to a clicked history item", async () => {
    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Latest run summary");
    expect(container.textContent).toContain("latest stderr");
    expect(container.textContent).toContain("Latest brief");

    const olderHistoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Older run summary"));

    expect(olderHistoryButton).toBeTruthy();

    await act(async () => {
      olderHistoryButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Older run summary");
    expect(container.textContent).toContain("boom");
    expect(container.textContent).toContain("older stderr");
    expect(container.textContent).toContain("Older brief");
    expect(container.textContent).not.toContain("latest stderr");
    expect(container.textContent).not.toContain("Latest brief");
  });

  it("includes active run handoff ids in the activity query", async () => {
    getRunMock.mockResolvedValue(latestRunDetailWithHandoff);

    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    expect(activityMock).toHaveBeenCalledWith("company-1", "workflow-1", {
      runIds: ["run-latest", "run-old"],
      handoffIds: ["handoff-latest"],
    });
  });

  it("returns to the latest run when the latest history row is clicked", async () => {
    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    const olderHistoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Older run summary"));

    expect(olderHistoryButton).toBeTruthy();

    await act(async () => {
      olderHistoryButton!.click();
    });
    await flushReact();
    await flushReact();

    const latestHistoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Latest run summary"));

    expect(latestHistoryButton).toBeTruthy();

    await act(async () => {
      latestHistoryButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Latest run summary");
    expect(container.textContent).toContain("latest stderr");
    expect(container.textContent).toContain("Latest brief");
  });

  it("keeps a selected historical run pinned when workflow data refreshes", async () => {
    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    const olderHistoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Older run summary"));

    expect(olderHistoryButton).toBeTruthy();

    await act(async () => {
      olderHistoryButton!.click();
    });
    await flushReact();
    await flushReact();

    getWorkflowMock.mockResolvedValueOnce(workflowDetailAfterRefresh);

    await act(async () => {
      await queryClient!.invalidateQueries({
        queryKey: queryKeys.workflows.detail("workflow-1"),
      });
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Older run summary");
    expect(container.textContent).toContain("boom");
    expect(container.textContent).toContain("older stderr");
    expect(container.textContent).toContain("Newest run summary");
    expect(container.textContent).not.toContain("new latest stderr");
  });

  it("shows stderr details by default and still lets the user collapse them", async () => {
    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    const olderHistoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Older run summary"));

    expect(olderHistoryButton).toBeTruthy();

    await act(async () => {
      olderHistoryButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("older stderr");
    expect(container.textContent).toContain("boom");

    const expandStderrButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.getAttribute("aria-label") === "Collapse stderr details");

    expect(expandStderrButton).toBeTruthy();

    await act(async () => {
      expandStderrButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("older stderr");
    expect(container.textContent).not.toContain("boom");

    const reExpandStderrButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.getAttribute("aria-label") === "Expand stderr details");

    expect(reExpandStderrButton).toBeTruthy();

    await act(async () => {
      reExpandStderrButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("older stderr");
    expect(container.textContent).toContain("boom");
  });

  it("shows invocation metadata for routine-linked runs", async () => {
    getRunMock.mockResolvedValueOnce({
      ...latestRunDetail,
      invocation: {
        id: "invocation-1",
        contractVersion: "workflow-invocation/v1",
        inputKind: "json",
        sourceRoutineId: "routine-1",
        sourceRoutineTitle: "Brief intake",
        sourceRoutineRunId: "routine-run-1",
        sourceRoutineRunSource: "manual",
        targetWorkflowId: "workflow-1",
        targetWorkflowKey: "brief-generator",
        targetCapability: "briefing",
      },
    });

    await renderAt(container, "/workflows/workflow-1");
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Invocation bridge");
    expect(container.textContent).toContain("Brief intake");
    expect(container.textContent).toContain("workflow-invocation/v1");
    expect(container.textContent).toContain("JSON");
    expect(container.textContent).toContain("brief-generator");
    expect(container.textContent).toContain("briefing");
  });
});

describe("buildWorkflowGraph", () => {
  const makePhase = (
    phaseKey: string,
    {
      label,
      kind,
      ordinal,
      parentKey,
      depth,
    }: {
      label: string;
      kind: "agent" | "loop" | "tool" | "validator" | "phase";
      ordinal: number;
      parentKey: string | null;
      depth: number;
    },
  ) => ({
    id: `${phaseKey}-id`,
    companyId: "company-1",
    workflowRunId: "run-1",
    phaseKey,
    label,
    kind,
    ordinal,
    status: "succeeded",
    metadata: {
      parentKey,
      depth,
    },
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    updatedAt: new Date("2026-06-10T09:00:00.000Z"),
  });

  it("keeps structural siblings ahead of helper tools and compacts tool nodes", () => {
    const graph = buildWorkflowGraph(
      [
        makePhase("root", {
          label: "Content Strategist",
          kind: "agent",
          ordinal: 0,
          parentKey: null,
          depth: 0,
        }),
        makePhase("article_feedback_editor", {
          label: "Article feedback editor",
          kind: "validator",
          ordinal: 10,
          parentKey: "root",
          depth: 1,
        }),
        makePhase("fetch_articles", {
          label: "Fetch articles",
          kind: "tool",
          ordinal: 1,
          parentKey: "root",
          depth: 5,
        }),
      ],
      new Map(),
      null,
    );

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const reviewNode = byId.get("phase:article_feedback_editor");
    const helperNode = byId.get("phase:fetch_articles");

    expect(reviewNode).toBeTruthy();
    expect(helperNode).toBeTruthy();
    expect(reviewNode!.y).toBeLessThan(helperNode!.y);
    expect(helperNode!.width).toBeLessThan(reviewNode!.width);
  });

  it("centers a handoff-heavy parent chain over a taller child subtree", () => {
    const graph = buildWorkflowGraph(
      [
        makePhase("root", {
          label: "Content Strategist",
          kind: "agent",
          ordinal: 0,
          parentKey: null,
          depth: 0,
        }),
        makePhase("child", {
          label: "Child phase",
          kind: "agent",
          ordinal: 1,
          parentKey: "root",
          depth: 1,
        }),
      ],
      new Map([
        [
          "root",
          [
            {
              id: "handoff-root",
              companyId: "company-1",
              workflowRunId: "run-1",
              phaseKey: "root",
              kind: "response",
              status: "closed",
              promptMarkdown: "",
              responseMarkdown: null,
              decidedByUserId: null,
              decidedAt: null,
              createdAt: new Date("2026-06-10T09:00:00.000Z"),
              updatedAt: new Date("2026-06-10T09:00:00.000Z"),
              bridgeStatus: "closed",
            } satisfies WorkflowHandoff,
          ],
        ],
        [
          "child",
          [
            {
              id: "handoff-child-1",
              companyId: "company-1",
              workflowRunId: "run-1",
              phaseKey: "child",
              kind: "response",
              status: "closed",
              promptMarkdown: "",
              responseMarkdown: null,
              decidedByUserId: null,
              decidedAt: null,
              createdAt: new Date("2026-06-10T09:01:00.000Z"),
              updatedAt: new Date("2026-06-10T09:01:00.000Z"),
              bridgeStatus: "closed",
            },
            {
              id: "handoff-child-2",
              companyId: "company-1",
              workflowRunId: "run-1",
              phaseKey: "child",
              kind: "response",
              status: "closed",
              promptMarkdown: "",
              responseMarkdown: null,
              decidedByUserId: null,
              decidedAt: null,
              createdAt: new Date("2026-06-10T09:02:00.000Z"),
              updatedAt: new Date("2026-06-10T09:02:00.000Z"),
              bridgeStatus: "closed",
            },
            {
              id: "handoff-child-3",
              companyId: "company-1",
              workflowRunId: "run-1",
              phaseKey: "child",
              kind: "response",
              status: "closed",
              promptMarkdown: "",
              responseMarkdown: null,
              decidedByUserId: null,
              decidedAt: null,
              createdAt: new Date("2026-06-10T09:03:00.000Z"),
              updatedAt: new Date("2026-06-10T09:03:00.000Z"),
              bridgeStatus: "closed",
            },
          ] satisfies WorkflowHandoff[],
        ],
      ]),
      null,
    );

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const rootNode = byId.get("phase:root");
    const childNode = byId.get("phase:child");

    expect(rootNode).toBeTruthy();
    expect(childNode).toBeTruthy();
    expect(rootNode!.y - childNode!.y).toBe(198);
  });

  it("keeps a start to terminal edge when there are no phases", () => {
    const graph = buildWorkflowGraph([], new Map(), null);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          id: "graph:start->graph:terminal",
          from: "graph:start",
          to: "graph:terminal",
        },
      ]),
    );
  });

  it("keeps deliverables within the visible canvas when there are multiple items", () => {
    const graph = buildWorkflowGraph(
      [],
      new Map(),
      {
        status: "succeeded",
        deliverables: [
          {
            id: "deliverable-1",
            title: "First brief",
          },
          {
            id: "deliverable-2",
            title: "Second brief",
          },
        ],
      } as never,
    );

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const firstDeliverable = byId.get("deliverable:deliverable-1");
    const secondDeliverable = byId.get("deliverable:deliverable-2");

    expect(firstDeliverable).toBeTruthy();
    expect(secondDeliverable).toBeTruthy();
    expect(firstDeliverable!.y).toBeGreaterThanOrEqual(24);
    expect(secondDeliverable!.y).toBeGreaterThan(firstDeliverable!.y);
  });

  it("renders handoffs without a matching phase as a visible terminal approval", () => {
    const handoff = {
      id: "handoff-entrypoint",
      companyId: "company-1",
      workflowRunId: "run-1",
      phaseKey: "entrypoint",
      kind: "approval",
      status: "pending",
      promptMarkdown: "Please review the package.",
      responseMarkdown: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-06-10T09:00:00.000Z"),
      updatedAt: new Date("2026-06-10T09:00:00.000Z"),
      bridgeStatus: "waiting_for_human",
    } satisfies WorkflowHandoff;

    const graph = buildWorkflowGraph(
      [
        makePhase("root", {
          label: "Content Strategist",
          kind: "agent",
          ordinal: 0,
          parentKey: null,
          depth: 0,
        }),
      ],
      new Map([["entrypoint", [handoff]]]),
      null,
    );

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const terminalNode = byId.get("graph:terminal");
    const handoffNode = byId.get("handoff:handoff-entrypoint");

    expect(terminalNode).toBeTruthy();
    expect(handoffNode).toBeTruthy();
    expect(handoffNode!.kind).toBe("human");
    expect(handoffNode!.x).toBeGreaterThan(terminalNode!.x);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          id: "graph:terminal->handoff:handoff-entrypoint",
          from: "graph:terminal",
          to: "handoff:handoff-entrypoint",
        },
      ]),
    );
  });
});
