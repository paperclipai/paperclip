// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentServiceHealth } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { AgentServiceHealthBanner } from "./AgentServiceHealthBanner";

const agentServiceHealthApiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/agentServiceHealth", () => ({
  agentServiceHealthApi: agentServiceHealthApiMock,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function health(overrides: Partial<AgentServiceHealth> = {}): AgentServiceHealth {
  return {
    status: "healthy",
    reason: null,
    message: "AI agent service is healthy.",
    checkedAt: "2026-04-19T12:00:00.000Z",
    scheduler: {
      enabled: true,
      intervalMs: 30_000,
    },
    counts: {
      activeCompanyCount: 1,
      eligibleAgentCount: 1,
      schedulerActiveAgentCount: 1,
      liveRunCount: 0,
      stuckQueuedRunCount: 0,
      recentHealthyRunCount: 1,
      recentRuntimeFailureAgentCount: 0,
    },
    latestHeartbeatAt: "2026-04-19T11:59:00.000Z",
    failureExamples: [],
    ...overrides,
  };
}

async function renderBanner() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentServiceHealthBanner />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  agentServiceHealthApiMock.get.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("AgentServiceHealthBanner", () => {
  it("hides when the agent service is healthy", async () => {
    agentServiceHealthApiMock.get.mockResolvedValue(health());

    await renderBanner();

    expect(container?.textContent).not.toContain("AI Agent Service Down");
  });

  it("renders a red operational banner and recovery link when the service is down", async () => {
    agentServiceHealthApiMock.get.mockResolvedValue(health({
      status: "down",
      reason: "no_scheduler_active_agents",
      message: "AI agent service is down: no scheduler-active heartbeats are enabled across active companies.",
      counts: {
        activeCompanyCount: 4,
        eligibleAgentCount: 20,
        schedulerActiveAgentCount: 0,
        liveRunCount: 0,
        stuckQueuedRunCount: 0,
        recentHealthyRunCount: 0,
        recentRuntimeFailureAgentCount: 0,
      },
    }));

    await renderBanner();

    expect(container?.textContent).toContain("AI Agent Service Down");
    expect(container?.textContent).toContain("no scheduler-active heartbeats");
    const link = container?.querySelector("a") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("/instance/settings/heartbeats");
  });

  it("includes the latest runtime failure summary", async () => {
    agentServiceHealthApiMock.get.mockResolvedValue(health({
      status: "down",
      reason: "recent_runtime_failures",
      message: "AI agent service is down: recent agent runtime failures are preventing scheduled agents from progressing.",
      failureExamples: [{
        runId: "run-1",
        companyId: "company-1",
        companyName: "AI Second Brain",
        agentId: "agent-1",
        agentName: "CEO",
        adapterType: "codex_local",
        status: "failed",
        error: 'Command not found in PATH: "codex"',
        errorCode: "adapter_failed",
        createdAt: "2026-04-19T11:59:00.000Z",
        finishedAt: "2026-04-19T11:59:10.000Z",
      }],
    }));

    await renderBanner();

    expect(container?.textContent).toContain('Latest failure: CEO: Command not found in PATH: "codex"');
  });

  it("hides silently when the admin-only endpoint returns 403", async () => {
    agentServiceHealthApiMock.get.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));

    await renderBanner();

    expect(container?.textContent).not.toContain("AI Agent Service Down");
  });
});
