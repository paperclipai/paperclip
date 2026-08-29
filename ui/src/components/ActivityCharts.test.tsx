// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueStatusChart,
  PriorityChart,
  RunActivityChart,
  SuccessRateChart,
} from "./ActivityCharts";

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
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  flushSync(() => {
    root.render(ui);
  });
}

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    responsibleUserId: null,
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

function renderedDotColors() {
  return Array.from(container.querySelectorAll<HTMLElement>("[style]"))
    .map((node) => node.style.backgroundColor)
    .filter(Boolean);
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
          createRun({ id: "run-failed", status: "failed", errorCode: "provider_quota" }),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("No runs yet");
    // Tooltip now carries the per-day breakdown (incl. failure error codes).
    const dayCell = container.querySelector("[title^='2026-04-20: 2 runs']");
    expect(dayCell).not.toBeNull();
    expect(dayCell?.getAttribute("title")).toContain("provider_quota: 1");
  });

  it("renders a distinct recovered segment and legend for recovered restart kills", () => {
    render(
      <RunActivityChart
        activity={[
          {
            date: "2026-04-20",
            succeeded: 3,
            failed: 1,
            recovered: 4,
            other: 0,
            total: 8,
            failedByErrorCode: { process_lost: 1 },
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Recovered");
    const dayCell = container.querySelector("[title*='recovered: 4']");
    expect(dayCell).not.toBeNull();
  });

  it("keeps run activity colors semantic and does not paint zero-count segments", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({ id: "run-failed", status: "failed" }),
        ]}
      />,
    );

    const dayCell = container.querySelector<HTMLElement>("[title^='2026-04-20: 2 runs']");
    const colors = Array.from(dayCell?.querySelectorAll<HTMLElement>("[style*='background-color']") ?? [])
      .map((node) => node.style.backgroundColor);
    expect(colors).toContain("var(--dashboard-positive)");
    expect(colors).toContain("var(--dashboard-danger)");
    expect(colors).not.toContain("var(--dashboard-neutral)");
  });

  it("renders priority bars with critical/high/medium semantic colors and neutral low color", () => {
    render(
      <PriorityChart
        issues={[
          { priority: "critical", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { priority: "high", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { priority: "medium", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { priority: "low", createdAt: new Date("2026-04-20T10:00:00.000Z") },
        ]}
      />,
    );

    const colors = renderedDotColors();
    expect(colors).toContain("var(--dashboard-danger)");
    expect(colors).toContain("var(--dashboard-warning)");
    expect(colors).toContain("var(--dashboard-neutral-strong)");
    expect(colors).toContain("var(--dashboard-neutral)");
  });

  it("renders issue status bars with workflow semantic colors", () => {
    render(
      <IssueStatusChart
        issues={[
          { status: "todo", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "in_progress", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "in_review", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "done", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "blocked", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "cancelled", createdAt: new Date("2026-04-20T10:00:00.000Z") },
          { status: "backlog", createdAt: new Date("2026-04-20T10:00:00.000Z") },
        ]}
      />,
    );

    expect(container.querySelectorAll("[style*='--dot-color']")).toHaveLength(0);
    expect(container.querySelector<HTMLElement>("[data-status-segment='todo']")?.style.backgroundColor)
      .toBe("var(--dashboard-warning)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='in_progress']")?.style.backgroundColor)
      .toBe("var(--dashboard-accent)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='in_review']")?.style.backgroundColor)
      .toBe("var(--dashboard-neutral-strong)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='done']")?.style.backgroundColor)
      .toBe("var(--dashboard-positive)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='blocked']")?.style.backgroundColor)
      .toBe("var(--dashboard-danger)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='cancelled']")?.style.backgroundColor)
      .toBe("var(--dashboard-neutral)");
    expect(container.querySelector<HTMLElement>("[data-status-segment='backlog']")?.style.backgroundColor)
      .toBe("var(--dashboard-neutral)");
  });
});
