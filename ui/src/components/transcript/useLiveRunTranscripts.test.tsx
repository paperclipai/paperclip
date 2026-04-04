// @vitest-environment jsdom

import { StrictMode, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

const getGeneralMock = vi.fn(async () => ({ censorUsernameInLogs: false }));
const logMock = vi.fn();

vi.mock("../../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: () => getGeneralMock(),
  },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    log: (runId: string, offset = 0, limitBytes = 256000) => logMock(runId, offset, limitBytes),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createRun(id: string): LiveRunForIssue {
  return {
    id,
    status: "succeeded",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-04T00:00:00.000Z",
    finishedAt: "2026-04-04T00:01:00.000Z",
    createdAt: "2026-04-04T00:00:00.000Z",
    agentId: `agent-${id}`,
    agentName: `Agent ${id}`,
    adapterType: "process",
    issueId: `issue-${id}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function HookProbe({
  runs,
  onSnapshot,
}: {
  runs: LiveRunForIssue[];
  onSnapshot: (value: Record<string, boolean>) => void;
}) {
  const { hasOutputForRun } = useLiveRunTranscripts({
    runs,
    companyId: "company-1",
  });

  useEffect(() => {
    onSnapshot(
      Object.fromEntries(runs.map((run) => [run.id, hasOutputForRun(run.id)])),
    );
  }, [hasOutputForRun, onSnapshot, runs]);

  return null;
}

describe("useLiveRunTranscripts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getGeneralMock.mockClear();
    logMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("retains persisted transcript output for multiple runs after StrictMode remounts", async () => {
    const runA = createRun("run-a");
    const runB = createRun("run-b");
    const runAFirst = deferred<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>();
    const runBFirst = deferred<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>();
    const snapshots: Array<Record<string, boolean>> = [];

    logMock.mockImplementation((runId: string) => {
      if (runId === runA.id) {
        return runAFirst.promise;
      }
      if (runId === runB.id) {
        return runBFirst.promise;
      }
      return Promise.resolve({
        runId,
        store: "inline",
        logRef: `${runId}-log`,
        content: "",
      });
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
        },
      },
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <HookProbe runs={[runA, runB]} onSnapshot={(value) => snapshots.push(value)} />
          </QueryClientProvider>
        </StrictMode>,
      );
    });

    await act(async () => {
      runBFirst.resolve({
        runId: runB.id,
        store: "inline",
        logRef: "log-b",
        content: `${JSON.stringify({ ts: "2026-04-04T00:00:02.000Z", stream: "stdout", chunk: "second run line\\n" })}\n`,
      });
      runAFirst.resolve({
        runId: runA.id,
        store: "inline",
        logRef: "log-a",
        content: `${JSON.stringify({ ts: "2026-04-04T00:00:01.000Z", stream: "stdout", chunk: "first run line\\n" })}\n`,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(logMock).toHaveBeenCalledWith(runA.id, 0, 256000);
    expect(logMock).toHaveBeenCalledWith(runB.id, 0, 256000);
    expect(snapshots.some((snapshot) => snapshot[runA.id] && snapshot[runB.id])).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
