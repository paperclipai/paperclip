// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivityEvent } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const activityListMock = vi.fn<(companyId: string, filters?: unknown) => Promise<ActivityEvent[]>>();

vi.mock("@/api/activity", () => ({
  activityApi: {
    list: (companyId: string, filters?: unknown) => activityListMock(companyId, filters),
  },
}));

import { RunsTimelinePage } from "./RunsTimelinePage";

function makeEvent(overrides: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    id: overrides.id,
    companyId: "company-1",
    actorType: overrides.actorType ?? "agent",
    actorId: overrides.actorId ?? "agent-1",
    action: overrides.action ?? "run.started",
    entityType: overrides.entityType ?? "run",
    entityId: overrides.entityId ?? "run-1",
    agentId: overrides.agentId ?? "agent-1",
    runId: overrides.runId ?? null,
    details: overrides.details ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-19T12:00:00Z"),
  };
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  activityListMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
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

async function renderRuns() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const now = new Date("2026-05-19T16:00:00.000Z");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/runs"]}>
          <Routes>
            <Route path="/eaos/runs" element={<RunsTimelinePage now={now} />} />
            <Route path="/eaos/missions/:missionRef" element={<div data-testid="mission-detail-stub" />} />
            <Route path="/issues/:issueId" element={<div data-testid="kernel-issue-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("RunsTimelinePage (LET-484 working-product slice)", () => {
  it("renders the runs surface (not the EaosZonePlaceholder)", async () => {
    activityListMock.mockResolvedValue([]);
    await renderRuns();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-runs-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("labels the timeline as backend-backed once the activity feed resolves", async () => {
    activityListMock.mockResolvedValue([
      makeEvent({ id: "1", runId: "run-a", action: "run.started" }),
    ]);
    await renderRuns();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-runs-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Timeline · BACKEND-BACKED");
      expect(text).toContain("Replay · PREVIEW");
    });
  });

  it("collapses activity events into per-run rows with backend-derived counts", async () => {
    activityListMock.mockResolvedValue([
      makeEvent({
        id: "1",
        runId: "run-a",
        agentId: "agent-eng",
        entityType: "issue",
        entityId: "issue-42",
        action: "run.completed",
        createdAt: new Date("2026-05-19T15:00:00Z"),
        details: { identifier: "LET-42", title: "Wire approvals queue" },
      }),
      makeEvent({
        id: "2",
        runId: "run-a",
        agentId: "agent-eng",
        entityType: "run",
        entityId: "run-a",
        action: "run.tool_call",
        createdAt: new Date("2026-05-19T14:55:00Z"),
      }),
      makeEvent({
        id: "3",
        runId: "run-b",
        agentId: "agent-qa",
        entityType: "issue",
        entityId: "issue-43",
        action: "run.started",
        createdAt: new Date("2026-05-19T13:00:00Z"),
        details: { identifier: "LET-43", title: "QA cycle" },
      }),
    ]);
    await renderRuns();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-runs-summary-runs"]')?.textContent).toContain("2");
      expect(container?.querySelector('[data-testid="eaos-runs-summary-events"]')?.textContent).toContain("3");
      expect(container?.querySelector('[data-testid="eaos-runs-summary-agents"]')?.textContent).toContain("2");
      expect(container?.querySelector('[data-testid="eaos-runs-summary-issues"]')?.textContent).toContain("2");

      const rows = container?.querySelectorAll('[data-testid="eaos-runs-row"]');
      expect(rows?.length).toBe(2);
      // Newest run sorts first.
      expect(rows?.[0].getAttribute("data-run-id")).toBe("run-a");

      // Mission detail link uses the issue identifier (LET-42).
      const missionLink = rows?.[0].querySelector('[data-testid="eaos-runs-row-mission-link"]');
      expect(missionLink?.getAttribute("href")).toBe("/eaos/missions/LET-42");

      // Kernel link uses the raw issue id (/LET prefix is applied by router for board routes).
      const kernelLink = rows?.[0].querySelector('[data-testid="eaos-runs-row-kernel-link"]');
      expect(kernelLink?.getAttribute("href")).toBe("/LET/issues/issue-42");
    });
  });

  it("does NOT render any live action buttons", async () => {
    activityListMock.mockResolvedValue([
      makeEvent({ id: "1", runId: "run-a", action: "run.started" }),
    ]);
    await renderRuns();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-runs-row"]')).not.toBeNull();
    });
    expect(container?.querySelectorAll("button").length).toBe(0);
  });

  it("redacts secret-looking text in row titles", async () => {
    activityListMock.mockResolvedValue([
      makeEvent({
        id: "1",
        runId: "run-leak",
        agentId: "agent-1",
        entityType: "issue",
        entityId: "issue-leak",
        details: {
          title: "Wired ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII into the run config",
          identifier: "LET-LEAK",
        },
      }),
    ]);
    await renderRuns();
    await waitForMicrotaskAssertion(() => {
      const titleNode = container?.querySelector('[data-testid="eaos-runs-row-title"]');
      const text = titleNode?.textContent ?? "";
      expect(text).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
    });
  });
});
