// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DashboardIssueActivityDay, HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueStatusChart, PriorityChart, RunActivityChart, SuccessRateChart } from "./ActivityCharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  act(() => {
    root.render(ui);
  });
}

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-04-20T11:58:00.000Z"),
    finishedAt: new Date("2026-04-20T11:59:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date("2026-04-20T11:58:00.000Z"),
    updatedAt: new Date("2026-04-20T11:59:00.000Z"),
    ...overrides,
  };
}

describe("ActivityCharts", () => {
  it("renders empty run charts when dashboard aggregate data is temporarily missing", () => {
    render(<RunActivityChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");

    render(<SuccessRateChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");
  });

  it("still aggregates raw agent runs for detail charts", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({ id: "run-failed", status: "failed" }),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("No runs yet");
    expect(container.querySelector("[title='2026-04-20: 2 runs']")).not.toBeNull();
  });

  // ----- PriorityChart / IssueStatusChart discriminated-union props -----

  function emptyPriorityBuckets() {
    return { critical: 0, high: 0, medium: 0, low: 0 };
  }
  function emptyStatusBuckets() {
    return { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, cancelled: 0 };
  }

  it("PriorityChart renders pre-aggregated activity", () => {
    const activity: DashboardIssueActivityDay[] = [
      {
        date: "2026-04-20",
        total: 3,
        byPriority: { ...emptyPriorityBuckets(), critical: 1, high: 2 },
        byStatus: emptyStatusBuckets(),
      },
    ];
    render(<PriorityChart activity={activity} />);
    expect(container.textContent).not.toContain("No issues");
    expect(container.querySelector("[title='2026-04-20: 3 issues']")).not.toBeNull();
  });

  it("PriorityChart still aggregates raw issues for AgentDetail-style callers", () => {
    render(
      <PriorityChart
        issues={[
          { priority: "critical", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { priority: "high", createdAt: new Date("2026-04-20T11:00:00.000Z") },
        ]}
      />,
    );
    expect(container.textContent).not.toContain("No issues");
    expect(container.querySelector("[title='2026-04-20: 2 issues']")).not.toBeNull();
  });

  it("PriorityChart shows empty state when activity has no tasks", () => {
    const activity: DashboardIssueActivityDay[] = [
      { date: "2026-04-20", total: 0, byPriority: emptyPriorityBuckets(), byStatus: emptyStatusBuckets() },
    ];
    render(<PriorityChart activity={activity} />);
    expect(container.textContent).toContain("No tasks");
  });

  it("IssueStatusChart renders pre-aggregated activity", () => {
    const activity: DashboardIssueActivityDay[] = [
      {
        date: "2026-04-20",
        total: 4,
        byPriority: emptyPriorityBuckets(),
        byStatus: { ...emptyStatusBuckets(), in_progress: 3, blocked: 1 },
      },
    ];
    render(<IssueStatusChart activity={activity} />);
    expect(container.textContent).not.toContain("No issues");
    expect(container.querySelector("[title='2026-04-20: 4 issues']")).not.toBeNull();
  });

  it("IssueStatusChart still aggregates raw issues", () => {
    render(
      <IssueStatusChart
        issues={[
          { status: "todo", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "in_progress", createdAt: new Date("2026-04-20T11:00:00.000Z") },
        ]}
      />,
    );
    expect(container.textContent).not.toContain("No issues");
    expect(container.querySelector("[title='2026-04-20: 2 issues']")).not.toBeNull();
  });
});
