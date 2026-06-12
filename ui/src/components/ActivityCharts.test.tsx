// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chartSemanticColors,
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

function renderedDotColors() {
  return Array.from(container.querySelectorAll<HTMLElement>("[style*='--dot-color']"))
    .map((node) => node.style.getPropertyValue("--dot-color"));
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgb(${red}, ${green}, ${blue})`;
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

  it("keeps run activity colors semantic and does not paint zero-count segments", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({ id: "run-failed", status: "failed" }),
        ]}
      />,
    );

    const colors = renderedDotColors();
    expect(colors).toContain(chartSemanticColors.success);
    expect(colors).toContain(chartSemanticColors.danger);
    expect(colors).not.toContain(chartSemanticColors.other);
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
    expect(colors).toContain(chartSemanticColors.danger);
    expect(colors).toContain(chartSemanticColors.high);
    expect(colors).toContain(chartSemanticColors.warning);
    expect(colors).toContain("var(--foreground)");
    expect(colors).not.toContain(chartSemanticColors.info);
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

    expect(renderedDotColors()).toHaveLength(0);
    expect(container.querySelector<HTMLElement>("[data-status-segment='todo']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.info));
    expect(container.querySelector<HTMLElement>("[data-status-segment='in_progress']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.warning));
    expect(container.querySelector<HTMLElement>("[data-status-segment='in_review']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.review));
    expect(container.querySelector<HTMLElement>("[data-status-segment='done']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.success));
    expect(container.querySelector<HTMLElement>("[data-status-segment='blocked']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.danger));
    expect(container.querySelector<HTMLElement>("[data-status-segment='cancelled']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.cancelled));
    expect(container.querySelector<HTMLElement>("[data-status-segment='backlog']")?.style.backgroundColor)
      .toBe(hexToRgb(chartSemanticColors.backlog));
  });
});
