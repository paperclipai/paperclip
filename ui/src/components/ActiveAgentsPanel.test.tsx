// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel, AgentRunCard } from "./ActiveAgentsPanel";

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

function createRun(index: number) {
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
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([1, 2, 3, 4, 5].map(createRun));
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
    expect(container.textContent).not.toContain("Run output");

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
    expect(container.textContent).not.toContain("Run output");

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
      expect(issueLink?.textContent).toContain("Phase 4B: Implement LLM Wiki distillation UI");
      expect(issueLink?.textContent).toContain("PAP-3562");
      expect(issueLink?.getAttribute("href")).toBe("/issues/PAP-3562");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps run outcomes distinct from the linked task status", async () => {
    const root = createRoot(container);
    const statuses = ["running", "queued", "succeeded", "failed", "timed_out", "cancelled", "interrupted"];
    await act(async () => {
      root.render(<>{statuses.map((status, index) => (
        <AgentRunCard
          key={status}
          companyId="company-1"
          run={{ ...createIssueRun(index, "issue-1"), status }}
          issue={{ title: "Review release notes", identifier: "PAP-559", status: "in_review" }}
        />
      ))}</>);
    });
    const headers = [...container.querySelectorAll('a[aria-label$=". View run"]')];
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual([
      "Agent 0 — Running. View run", "Agent 1 — Queued. View run",
      "Agent 2 — Succeeded. View run", "Agent 3 — Failed. View run",
      "Agent 4 — Timed out. View run", "Agent 5 — Cancelled. View run",
      "Agent 6 — Interrupted. View run",
    ]);
    expect(headers.every((header) => header.querySelector("svg") === null)).toBe(true);
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelectorAll('[aria-label="Task in review"]')).toHaveLength(7);
    expect(container.querySelectorAll(".motion-safe\\:animate-spin")).toHaveLength(0);
    expect(container.querySelector('a[aria-label="Agent 0 — Running. View run"]')?.getAttribute("href"))
      .toBe("/agents/agent-0/runs/run-0");
    await act(async () => root.unmount());
  });

  it("keeps a failed task lookup navigable and shows a clear error", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentRunCard companyId="company-1" run={createIssueRun(1, "issue-missing")} issueLoadFailed />);
    });
    expect(container.textContent).toContain("Task unavailable");
    expect(container.querySelector('a[href="/issues/issue-missing"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("does not animate running records while execution is reconnecting", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentRunCard
        companyId="company-1"
        run={{
          ...createRun(0),
          execution: {
            phase: "reconnecting", label: "Reconnecting", cause: null,
            lastConfirmedActivityAt: null, retryAt: null, attempt: 1, maxAttempts: 3,
            recoveryOwner: "agent", nextAction: null, permittedActions: ["inspect_run"],
            predecessorRunId: null, successorRunId: null,
          },
        }}
      />);
    });
    expect(container.querySelector('a[aria-label="Agent 0 — Running. View run"]')).not.toBeNull();
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelectorAll(".motion-safe\\:animate-spin")).toHaveLength(0);
    await act(async () => root.unmount());
  });
});
