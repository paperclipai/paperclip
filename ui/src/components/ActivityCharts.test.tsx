// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { HeartbeatRunStats } from "../api/heartbeats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunActivityChart, SuccessRateChart } from "./ActivityCharts";

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
  describe("stats prop path", () => {
    // The mock system time is 2026-04-20T12:00:00Z so today (UTC) is 2026-04-20.
    // getLast14Days() returns 2026-04-07 … 2026-04-20.
    function makeStats(overrides: Partial<HeartbeatRunStats>[]): HeartbeatRunStats[] {
      return overrides.map((o) => ({ date: "2026-04-20", status: "succeeded", count: 1, ...o }));
    }

    it("RunActivityChart renders stats across two UTC days", () => {
      const stats = makeStats([
        { date: "2026-04-19", status: "succeeded", count: 3 },
        { date: "2026-04-19", status: "failed", count: 1 },
        { date: "2026-04-20", status: "succeeded", count: 2 },
        { date: "2026-04-20", status: "timed_out", count: 1 },
        { date: "2026-04-20", status: "other", count: 5 },
      ]);

      render(<RunActivityChart stats={stats} />);

      expect(container.textContent).not.toContain("No runs yet");
      // Apr 19 total = 4 runs, Apr 20 total = 8 runs
      expect(container.querySelector("[title='2026-04-19: 4 runs']")).not.toBeNull();
      expect(container.querySelector("[title='2026-04-20: 8 runs']")).not.toBeNull();
    });

    it("SuccessRateChart renders stats and shows correct success ratio tooltip", () => {
      const stats = makeStats([
        { date: "2026-04-18", status: "succeeded", count: 8 },
        { date: "2026-04-18", status: "failed", count: 2 },
      ]);

      render(<SuccessRateChart stats={stats} />);

      expect(container.textContent).not.toContain("No runs yet");
      // 8/10 = 80% success
      expect(container.querySelector("[title='2026-04-18: 80% (8/10)']")).not.toBeNull();
    });

    it("drops rows outside the 14-day window", () => {
      const stats = makeStats([
        // Too old — not in window
        { date: "2026-03-01", status: "succeeded", count: 99 },
        // In window
        { date: "2026-04-20", status: "succeeded", count: 1 },
      ]);

      render(<RunActivityChart stats={stats} />);

      expect(container.querySelector("[title='2026-03-01: 99 runs']")).toBeNull();
      expect(container.querySelector("[title='2026-04-20: 1 runs']")).not.toBeNull();
    });

    it("dedupes succeeded and failed+timed_out into correct buckets", () => {
      const stats = makeStats([
        { date: "2026-04-15", status: "succeeded", count: 4 },
        { date: "2026-04-15", status: "failed", count: 1 },
        { date: "2026-04-15", status: "timed_out", count: 2 },
        { date: "2026-04-15", status: "other", count: 3 },
      ]);

      render(<RunActivityChart stats={stats} />);

      // total = 4+1+2+3 = 10
      expect(container.querySelector("[title='2026-04-15: 10 runs']")).not.toBeNull();
    });
  });

});
