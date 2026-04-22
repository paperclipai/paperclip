// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

const { useQueryMock, logMock, buildTranscriptMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(() => ({ data: { censorUsernameInLogs: false } })),
  logMock: vi.fn(async () => ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 })),
  buildTranscriptMock: vi.fn((chunks: unknown[]) => chunks),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("../../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: vi.fn(),
  },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    log: logMock,
  },
}));

vi.mock("../../adapters", () => ({
  buildTranscript: buildTranscriptMock,
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSING;
  }

  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveRunTranscripts", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    useQueryMock.mockClear();
    logMock.mockReset();
    logMock.mockImplementation(async () => ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 }));
    buildTranscriptMock.mockClear();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("waits for a connecting socket to open before closing it during cleanup", async () => {
    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }],
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.closeCalls).toHaveLength(0);

    act(() => {
      root.unmount();
    });

    expect(socket.closeCalls).toHaveLength(0);

    act(() => {
      socket.triggerOpen();
    });

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "live_run_transcripts_unmount" }]);
    container.remove();
  });

  it("treats stored run output as available before transcript chunks finish loading", async () => {
    let latestHasOutput = false;

    function Harness() {
      const { hasOutputForRun } = useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local", hasStoredOutput: true }],
      });
      latestHasOutput = hasOutputForRun("run-1");
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(latestHasOutput).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("reports initial hydration until the first persisted-log read completes", async () => {
    let latestIsInitialHydrating = false;
    type RunLogResult = { runId: string; store: string; logRef: string; content: string; nextOffset: number };
    let resolveLog: ((value: RunLogResult | PromiseLike<RunLogResult>) => void) | null = null;
    logMock.mockImplementationOnce(
      () =>
        new Promise<RunLogResult>((resolve) => {
          resolveLog = resolve;
        }),
    );

    function Harness() {
      const { isInitialHydrating } = useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local" }],
      });
      latestIsInitialHydrating = isInitialHydrating;
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(latestIsInitialHydrating).toBe(true);

    await act(async () => {
      resolveLog?.({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 });
      await Promise.resolve();
    });

    expect(latestIsInitialHydrating).toBe(false);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("stops retrying terminal runs whose persisted log never existed", async () => {
    logMock.mockReset();
    logMock.mockRejectedValue(new ApiError("Run log not found", 404, { error: "Run log not found" }));

    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-404", status: "failed", adapterType: "codex_local" }],
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(logMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(logMock).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("can hydrate active runs without opening the live event socket", async () => {
    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }],
        enableRealtimeUpdates: false,
        logReadLimitBytes: 64_000,
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(logMock).toHaveBeenCalledWith("run-1", 0, 64_000);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("rebuilds only the transcript for the run that receives live output", async () => {
    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [
          { id: "run-1", status: "running", adapterType: "codex_local" },
          { id: "run-2", status: "running", adapterType: "codex_local" },
        ],
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(buildTranscriptMock).toHaveBeenCalledTimes(2);
    buildTranscriptMock.mockClear();

    await act(async () => {
      FakeWebSocket.instances[0]!.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            companyId: "company-1",
            type: "heartbeat.run.log",
            createdAt: "2026-04-20T00:00:00.000Z",
            payload: {
              runId: "run-1",
              ts: "2026-04-20T00:00:00.000Z",
              stream: "stdout",
              chunk: "hello from run 1\n",
            },
          }),
        }),
      );
      await Promise.resolve();
    });

    expect(buildTranscriptMock).toHaveBeenCalledTimes(1);
    expect(buildTranscriptMock).toHaveBeenCalledWith(
      [{ ts: "2026-04-20T00:00:00.000Z", stream: "stdout", chunk: "hello from run 1\n" }],
      null,
      { censorUsernameInLogs: false },
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
