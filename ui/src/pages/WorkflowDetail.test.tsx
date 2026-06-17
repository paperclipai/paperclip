// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDetail } from "./WorkflowDetail";
import { queryKeys } from "../lib/queryKeys";

const getWorkflowMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const activityMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
let queryClient: QueryClient | null = null;

vi.mock("@/api/workflows", () => ({
  workflowsApi: {
    get: (id: string) => getWorkflowMock(id),
    getRun: (id: string) => getRunMock(id),
    activity: (...args: unknown[]) => activityMock(...args),
    update: vi.fn(),
    run: vi.fn(),
    approveHandoff: vi.fn(),
    rejectHandoff: vi.fn(),
    respondHandoff: vi.fn(),
  },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
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
});
