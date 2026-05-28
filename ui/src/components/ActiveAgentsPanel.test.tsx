// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createRun(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `run-${index}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: null,
    createdAt: `2026-04-24T12:00:0${index}.000Z`,
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    adapterType: "codex_local",
    issueId: null,
    ...overrides,
  };
}

function createIssueRun(index: number, issueId: string) {
  return {
    ...createRun(index),
    issueId,
  };
}

function createIssue(id: string, identifier: string, title: string) {
  return {
    id,
    companyId: "company-1",
    identifier,
    title,
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    goalId: null,
    labels: [],
    blockedByIssueIds: [],
    blocksIssueIds: [],
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
  };
}

describe("ActiveAgentsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([1, 2, 3, 4, 5].map((index) => createRun(index)));
    mockIssuesApi.get.mockRejectedValue(new Error("Issue not found"));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("links hidden active/recent runs to the full live dashboard", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 4,
      limit: undefined,
    });

    const moreLink = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("more active/recent"),
    );
    expect(moreLink?.getAttribute("href")).toBe("/dashboard/live");

    await act(async () => {
      root.unmount();
    });
  });

  it("can request the full live dashboard page limit without a hidden-runs link", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel
            companyId="company-1"
            minRunCount={50}
            fetchLimit={50}
            cardLimit={50}
            queryScope="dashboard-live"
            showMoreLink={false}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 50,
      limit: 50,
    });
    expect(container.textContent).not.toContain("more active/recent");

    await act(async () => {
      root.unmount();
    });
  });

  it("loads exact visible run issues so task names render even when the issue list page would miss them", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createIssueRun(1, "65274215-0000-4000-8000-000000000000"),
    ]);
    mockIssuesApi.get.mockResolvedValue(createIssue(
      "65274215-0000-4000-8000-000000000000",
      "PAP-3562",
      "Phase 4B: Implement LLM Wiki distillation UI",
    ));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await waitForMicrotaskAssertion(() => {
      expect(mockIssuesApi.get).toHaveBeenCalledWith("65274215-0000-4000-8000-000000000000");
      const issueLink = [...container.querySelectorAll("a")].find((anchor) =>
        anchor.textContent?.includes("Phase 4B"),
      );
      expect(issueLink?.textContent).toBe("PAP-3562 - Phase 4B: Implement LLM Wiki distillation UI");
      expect(issueLink?.getAttribute("href")).toBe("/issues/PAP-3562");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("explains queued, running, failed, blocked, and completed run states", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createRun(1, { status: "queued" }),
      createRun(2, { status: "running" }),
      createRun(3, {
        status: "failed",
        finishedAt: "2026-04-24T12:02:00.000Z",
        livenessReason: "Process exited with code 1",
      }),
      createRun(4, {
        status: "succeeded",
        finishedAt: "2026-04-24T12:03:00.000Z",
        livenessState: "blocked",
        livenessReason: "Waiting for approval_id",
      }),
      createRun(5, {
        status: "succeeded",
        finishedAt: "2026-04-24T12:04:00.000Z",
        livenessState: "advanced",
      }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" cardLimit={5} minRunCount={5} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("has not started yet");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("worker is acting now");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Process exited with code 1");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Waiting for approval_id");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("finished and produced progress evidence");

    await act(async () => {
      root.unmount();
    });
  });
});
