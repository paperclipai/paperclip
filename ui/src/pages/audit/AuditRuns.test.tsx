// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun, RoutineRunSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditRuns } from "./AuditRuns";

const listAgentsMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const listRoutineRunsMock = vi.hoisted(() => vi.fn());
const searchRunsMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
let currentSearch = "";

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    list: (companyId: string, agentId?: string, limit?: number, options?: unknown) =>
      listRunsMock(companyId, agentId, limit, options),
    searchRuns: (companyId: string, params: unknown) => searchRunsMock(companyId, params),
  },
}));

vi.mock("@/api/routines", () => ({
  routinesApi: {
    listRuns: (routineId: string, limit?: number) => listRoutineRunsMock(routineId, limit),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useSearchParams: () => [new URLSearchParams(currentSearch), setSearchParamsMock],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-12345678",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "manual",
    status: "succeeded",
    startedAt: new Date("2026-08-31T18:00:00.000Z"),
    finishedAt: new Date("2026-08-31T18:01:05.000Z"),
    resultJson: { summary: "Reviewed the release checklist" },
    error: null,
    createdAt: new Date("2026-08-31T18:00:00.000Z"),
    ...overrides,
  } as HeartbeatRun;
}

function routineRun(overrides: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  return {
    id: "routine-run-1",
    companyId: "company-1",
    routineId: "routine-1",
    triggerId: "trigger-1",
    source: "schedule",
    status: "succeeded",
    triggeredAt: new Date("2026-08-31T18:00:00.000Z"),
    idempotencyKey: null,
    triggerPayload: null,
    dispatchFingerprint: null,
    linkedIssueId: "issue-1",
    coalescedIntoRunId: null,
    failureReason: null,
    completedAt: new Date("2026-08-31T18:01:05.000Z"),
    createdAt: new Date("2026-08-31T18:00:00.000Z"),
    updatedAt: new Date("2026-08-31T18:01:05.000Z"),
    linkedIssue: { id: "issue-1", identifier: "TES-42", title: "Publish forecast" },
    trigger: { id: "trigger-1", kind: "schedule", label: "Daily forecast" },
    ...overrides,
  } as RoutineRunSummary;
}

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("AuditRuns", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    currentSearch = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable" }]);
    listRunsMock.mockResolvedValue([run()]);
    listRoutineRunsMock.mockResolvedValue([routineRun()]);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(routineId?: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuditRuns companyId="company-1" routineId={routineId} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders a filterable flat run list with existing run-detail links", async () => {
    await render();

    expect(listRunsMock).toHaveBeenCalledWith("company-1", undefined, 200, { summary: true });
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Reviewed the release checklist");
    expect(container.textContent).toContain("1m 5s");
    const list = container.querySelector('ul[aria-label="Recent runs"]');
    expect(list).toBeTruthy();
    expect(list?.closest('[data-slot="card"]')).toBeFalsy();
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-12345678"]')).toBeTruthy();
  });

  it("uses the agent deep-link filter for both the query key and request", async () => {
    currentSearch = "agentId=agent-1&runStatus=succeeded";
    await render();

    expect(listRunsMock).toHaveBeenCalledWith("company-1", "agent-1", 200, { summary: true });
    expect(container.textContent).toContain("Clear filters");
  });

  it("loads routine runs directly when the Audit scope is a routine", async () => {
    await render("routine-1");

    expect(listRoutineRunsMock).toHaveBeenCalledWith("routine-1", 200);
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(listRunsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Publish forecast");
    expect(container.textContent).toContain("Daily forecast");
    expect(container.querySelector('a[href="/issues/TES-42"]')).toBeTruthy();
  });

  it("searches runs and activity when q has 2 or more characters", async () => {
    currentSearch = "q=release";
    searchRunsMock.mockResolvedValue({
      query: "release",
      runs: [
        {
          runId: "run-12345678",
          status: "failed",
          agentId: "agent-1",
          agentName: "Fable",
          issueId: "issue-1",
          issueIdentifier: "TES-42",
          issueTitle: "Publish forecast",
          startedAt: "2026-08-31T18:00:00.000Z",
          finishedAt: "2026-08-31T18:01:05.000Z",
          createdAt: "2026-08-31T18:00:00.000Z",
          matchedField: "error",
          snippet: "connection reset while pushing the release artifact",
        },
      ],
      activity: [
        {
          id: "activity-1",
          action: "heartbeat.run_failed",
          entityType: "heartbeat_run",
          entityId: "run-12345678",
          actorType: "agent",
          actorId: "agent-1",
          agentId: "agent-1",
          runId: "run-12345678",
          createdAt: "2026-08-31T18:01:05.000Z",
        },
      ],
    });
    await render();

    expect(searchRunsMock).toHaveBeenCalledWith("company-1", {
      q: "release",
      agentId: undefined,
      status: undefined,
    });
    expect(container.textContent).toContain("connection reset while pushing the release artifact");
    expect(container.textContent).toContain("matched error");
    expect(container.textContent).toContain("TES-42");
    expect(container.textContent).toContain("Matching activity");
    expect(container.textContent).toContain("heartbeat.run_failed");
    expect(container.textContent).toContain("JSON");
    expect(container.querySelector('ul[aria-label="Recent runs"]')).toBeFalsy();
  });

  it("keeps the flat list for single-character queries", async () => {
    currentSearch = "q=x";
    await render();

    expect(searchRunsMock).not.toHaveBeenCalled();
    expect(container.querySelector('ul[aria-label="Recent runs"]')).toBeTruthy();
  });
});
