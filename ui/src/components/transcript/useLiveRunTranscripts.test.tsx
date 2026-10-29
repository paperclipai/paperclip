// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import type { LiveEvent } from "@paperclipai/shared";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "../../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../../lib/live-transcript-interests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";
import { TRANSCRIPT_REQUEST_TIMEOUT_MS } from "./read-transcript-request";

const { useQueryMock, logMock, buildTranscriptMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(() => ({ data: { censorUsernameInLogs: false } })),
  logMock: vi.fn(async (_runId: string, _offset: number, _limit: number, _options: { signal: AbortSignal }) =>
    ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 })),
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

const { LiveEventSubscriptionContext } = __liveUpdatesTestUtils;
let listeners: Set<CompanyLiveEventHandler>;
let interests: LiveTranscriptInterests;
let sent: Array<{ type: string; revision?: number; runIds?: string[] }>;
let socketConstructed: ReturnType<typeof vi.fn<() => void>>;
function createRoot(container: HTMLDivElement) {
  const root = createReactRoot(container);
  const subscription = {
    companyId: "company-1", transcripts: interests,
    subscribe(handler: CompanyLiveEventHandler) {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
  };
  return {
    unmount: () => root.unmount(),
    render: (children: ReactNode) => root.render(
      <LiveEventSubscriptionContext.Provider value={subscription}>{children}</LiveEventSubscriptionContext.Provider>,
    ),
  };
}
function sendEvent(event: Omit<LiveEvent, "id">) {
  for (const listener of listeners) listener({ ...event, id: 1 });
}
function negotiate() {
  interests.open({ send: data => sent.push(JSON.parse(data)) });
  interests.receive({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
  acknowledge();
}
function acknowledge() {
  interests.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveRunTranscripts", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    listeners = new Set(); interests = new LiveTranscriptInterests(); sent = [];
    socketConstructed = vi.fn();
    useQueryMock.mockClear();
    logMock.mockReset();
    logMock.mockImplementation(async (_id, offset) => ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: offset }));
    buildTranscriptMock.mockClear();
    globalThis.WebSocket = class { constructor() { socketConstructed(); } } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("pauses hidden-tab reads and resumes at the retained log offset", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    logMock.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 42 });
    const runs = [{ id: "run-1", status: "running", adapterType: "codex_local" }];
    function Harness() {
      useLiveRunTranscripts({ companyId: "company-1", runs, enableRealtimeUpdates: false });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(logMock).not.toHaveBeenCalled();
      expect(socketConstructed).not.toHaveBeenCalled();
      await act(async () => {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(logMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(logMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(logMock).toHaveBeenLastCalledWith("run-1", 42, 256_000, expect.anything());
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("expands a compact log tail without hiding or duplicating the latest output", async () => {
    let truncatedRunIds: ReadonlySet<string> = new Set();
    const row = (seq: number, chunk: string) => JSON.stringify({ seq, chunk, ts: `2026-10-24T00:00:0${seq}Z`, stream: "stdout" });
    const result = (content: string) => ({ runId: "run-1", store: "memory", logRef: "log-1", content, nextOffset: 100_000 });
    let resolveExpanded!: (value: ReturnType<typeof result>) => void;
    logMock.mockResolvedValueOnce(result(`${row(2, "Latest answer")}\n`));
    logMock.mockResolvedValueOnce(result(""));
    logMock.mockImplementationOnce(() => new Promise(resolve => { resolveExpanded = resolve; }));
    function Harness({ limit, bytes = 100_000 }: { limit: number; bytes?: number }) {
      ({ truncatedRunIds } = useLiveRunTranscripts({
        runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local", logBytes: bytes }],
        enableRealtimeUpdates: false,
        logReadLimitBytes: limit,
      }));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const chunks = () => buildTranscriptMock.mock.calls.at(-1)?.[0];
    try {
      await act(async () => root.render(<Harness limit={32_000} />));
      expect(logMock).toHaveBeenNthCalledWith(1, "run-1", 68_000, 32_000, expect.objectContaining({ alignStartToRecord: true }));
      expect(truncatedRunIds.has("run-1")).toBe(true);
      expect(chunks()).toEqual([expect.objectContaining({ chunk: "Latest answer" })]);
      await act(async () => root.render(<Harness limit={256_000} />));
      expect(logMock).toHaveBeenLastCalledWith("run-1", 0, 256_000, expect.anything());
      expect(chunks()).toEqual([expect.objectContaining({ chunk: "Latest answer" })]);
      await act(async () => resolveExpanded(result(`${row(1, "Earlier activity")}\n${row(2, "Latest answer")}\n`)));
      expect(truncatedRunIds.has("run-1")).toBe(false);
      expect(chunks()).toEqual([
        expect.objectContaining({ chunk: "Earlier activity" }),
        expect.objectContaining({ chunk: "Latest answer" }),
      ]);
      await act(async () => root.render(<Harness limit={256_000} bytes={120_000} />));
      expect(logMock).toHaveBeenLastCalledWith("run-1", 100_000, 256_000, expect.anything());
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not report omitted output when a run grows beyond the window after reading from the start", async () => {
    let truncatedRunIds: ReadonlySet<string> = new Set();
    const row = (seq: number) => `${JSON.stringify({ seq, chunk: `Output ${seq}`, stream: "stdout", ts: "2026-10-24T00:00:00Z" })}\n`;
    const response = { runId: "run-1", store: "memory", logRef: "log-1" };
    logMock.mockResolvedValueOnce({ ...response, content: row(1), nextOffset: 100 });
    logMock.mockResolvedValueOnce({ ...response, content: "", nextOffset: 100 });
    logMock.mockResolvedValueOnce({ ...response, content: row(2), nextOffset: 100_000 });
    logMock.mockResolvedValueOnce({ ...response, content: "", nextOffset: 100_000 });
    function Harness({ bytes }: { bytes: number }) {
      ({ truncatedRunIds } = useLiveRunTranscripts({
        runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local", logBytes: bytes }],
        enableRealtimeUpdates: false, logReadLimitBytes: 32_000,
      }));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness bytes={100} />));
      expect(logMock).toHaveBeenNthCalledWith(1, "run-1", 0, 32_000, expect.anything());
      expect(truncatedRunIds.has("run-1")).toBe(false);
      await act(async () => root.render(<Harness bytes={100_000} />));
      expect(logMock).toHaveBeenNthCalledWith(3, "run-1", 100, 32_000, expect.anything());
      expect(truncatedRunIds.has("run-1")).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });

  it("keeps record alignment pending when an expanded log read needs retry", async () => {
    const row = (seq: number, chunk: string) => JSON.stringify({ seq, chunk, ts: `2026-10-24T00:00:0${seq}Z`, stream: "stdout" });
    const result = (content: string) => ({ runId: "run-1", store: "memory", logRef: "log-1", content, nextOffset: 500_000 });
    const earlier = row(1, "Earlier activity");
    const recent = row(2, "Latest answer");
    logMock.mockResolvedValueOnce(result(`${recent}\n`));
    logMock.mockResolvedValueOnce(result(""));
    logMock.mockRejectedValueOnce(new Error("Temporary storage failure"));
    logMock.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { alignStartToRecord?: boolean };
      return result(`${options.alignStartToRecord ? earlier : earlier.slice(15)}\n${recent}\n`);
    });
    let latest!: ReturnType<typeof useLiveRunTranscripts>;
    function Harness({ limit, bytes = 500_000 }: { limit: number; bytes?: number }) {
      latest = useLiveRunTranscripts({
        runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local", logBytes: bytes }],
        enableRealtimeUpdates: false,
        logReadLimitBytes: limit,
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const chunks = () => buildTranscriptMock.mock.calls.at(-1)?.[0];
    try {
      await act(async () => root.render(<Harness limit={32_000} />));
      await act(async () => root.render(<Harness limit={256_000} />));
      expect(latest.errorsByRun.get("run-1")?.message).toBe("Temporary storage failure");
      expect(chunks()).toEqual([expect.objectContaining({ chunk: "Latest answer" })]);
      await act(async () => latest.retry());
      expect(chunks()).toEqual([
        expect.objectContaining({ chunk: "Earlier activity" }),
        expect.objectContaining({ chunk: "Latest answer" }),
      ]);
      expect(logMock).toHaveBeenCalledWith("run-1", 244_000, 256_000, expect.objectContaining({ alignStartToRecord: true }));
      expect(latest.errorsByRun.size).toBe(0);
      await act(async () => root.render(<Harness limit={256_000} bytes={520_000} />));
      expect(logMock).toHaveBeenLastCalledWith("run-1", 500_000, 256_000, expect.not.objectContaining({ alignStartToRecord: true }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("registers interests on the shared connection without creating a socket", async () => {
    function Harness() {
      useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => negotiate());
    expect(sent.at(-1)?.runIds).toEqual(["run-1"]);
    expect(socketConstructed).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(sent.at(-1)?.runIds).toEqual([]);
    expect(listeners.size).toBe(0);
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

  it("releases stalled log hydration and permits a fresh retry without accepting late data", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    let latest!: ReturnType<typeof useLiveRunTranscripts>;
    let resolveLate!: (result: Awaited<ReturnType<typeof logMock>>) => void;
    const empty = { runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 };
    logMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    function Harness() {
      latest = useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local" }] });
      return null;
    }
    try {
      await act(async () => { root.render(<Harness />); });
      expect(latest.isInitialHydrating).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS); });
      expect(latest.isInitialHydrating).toBe(false);
      expect(latest.errorsByRun.get("run-1")?.message).toContain("too long");
      await act(async () => { resolveLate(empty); });
      expect(latest.errorsByRun.has("run-1")).toBe(true);
      logMock.mockResolvedValue(empty);
      await act(async () => { latest.retry(); });
      expect(latest.errorsByRun.size).toBe(0);
      expect(logMock).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
    }
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

  it("does not request persisted logs until a queued run starts", async () => {
    function Harness({ status }: { status: "queued" | "running" }) {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-queued", status, adapterType: "codex_local" }],
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness status="queued" />);
      await Promise.resolve();
    });

    expect(logMock).not.toHaveBeenCalled();
    expect(socketConstructed).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Harness status="running" />);
      await Promise.resolve();
    });

    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith("run-queued", 0, 256_000, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(socketConstructed).not.toHaveBeenCalled();

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

    expect(socketConstructed).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("run-1", 0, 64_000, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("starts persisted-log hydration from the newest bytes when the visible window is truncated", async () => {
    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "codex_local", lastOutputBytes: 100_000 }],
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

    expect(logMock).toHaveBeenCalledWith("run-1", 36_000, 64_000, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps identical same-timestamp log records that carry distinct seq values", async () => {
    const ts = "2026-04-20T00:00:00.000Z";
    const tokenRow = (seq: number) =>
      JSON.stringify({ ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq });
    logMock.mockImplementationOnce(async () => ({
      runId: "run-1",
      store: "memory",
      logRef: "log-1",
      content: `${tokenRow(1)}\n${tokenRow(2)}\n${tokenRow(3)}\n`,
      nextOffset: 300,
    }));

    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "gemini_local" }],
        enableRealtimeUpdates: false,
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

    const lastCall = buildTranscriptMock.mock.calls.at(-1) as unknown[] | undefined;
    expect(lastCall?.[0]).toEqual([
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: 1 },
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: 2 },
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: 3 },
    ]);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps repeated unsequenced structured text deltas instead of content-deduping tokens", async () => {
    const ts = "2026-04-20T00:00:00.000Z";
    const tokenRow = JSON.stringify({
      ts,
      stream: "stdout",
      chunk: '{"type":"acpx.text_delta","text":" the"}\n',
    });
    logMock.mockImplementationOnce(async () => ({
      runId: "run-1",
      store: "memory",
      logRef: "log-1",
      content: `${tokenRow}\n${tokenRow}\n${tokenRow}\n`,
      nextOffset: 300,
    }));

    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "gemini_local" }],
        enableRealtimeUpdates: false,
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

    const lastCall = buildTranscriptMock.mock.calls.at(-1) as unknown[] | undefined;
    expect(lastCall?.[0]).toEqual([
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: undefined },
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: undefined },
      { ts, stream: "stdout", chunk: '{"type":"acpx.text_delta","text":" the"}\n', seq: undefined },
    ]);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("orders and dedupes sequenced chunks across websocket and persisted-log delivery", async () => {
    type RunLogResult = { runId: string; store: string; logRef: string; content: string; nextOffset: number };
    let resolveLog: ((value: RunLogResult) => void) | null = null;
    logMock.mockImplementationOnce(
      () =>
        new Promise<RunLogResult>((resolve) => {
          resolveLog = resolve;
        }),
    );

    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "gemini_local" }],
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

    expect(socketConstructed).not.toHaveBeenCalled();

    const sendLogEvent = (seq: number, chunk: string) => {
      sendEvent({
        companyId: "company-1", type: "heartbeat.run.log", createdAt: "2026-04-20T00:00:01.000Z",
        payload: { runId: "run-1", ts: "2026-04-20T00:00:01.000Z", stream: "stdout", chunk, seq },
      });
    };

    // The websocket races ahead of the poller and its seq-2 chunk arrives
    // tail-truncated.
    await act(async () => {
      sendLogEvent(2, "rld\n");
      sendLogEvent(3, "!\n");
      await Promise.resolve();
    });

    const persistedRow = (seq: number, chunk: string) =>
      JSON.stringify({ ts: "2026-04-20T00:00:00.500Z", stream: "stdout", chunk, seq });
    await act(async () => {
      resolveLog?.({
        runId: "run-1",
        store: "memory",
        logRef: "log-1",
        content: `${persistedRow(1, "hello\n")}\n${persistedRow(2, "world\n")}\n${persistedRow(3, "!\n")}\n`,
        nextOffset: 300,
      });
      await Promise.resolve();
    });

    const lastCall = buildTranscriptMock.mock.calls.at(-1) as unknown[] | undefined;
    expect(lastCall?.[0]).toEqual([
      { ts: "2026-04-20T00:00:00.500Z", stream: "stdout", chunk: "hello\n", seq: 1 },
      { ts: "2026-04-20T00:00:00.500Z", stream: "stdout", chunk: "world\n", seq: 2 },
      { ts: "2026-04-20T00:00:01.000Z", stream: "stdout", chunk: "!\n", seq: 3 },
    ]);

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

    expect(socketConstructed).not.toHaveBeenCalled();
    expect(buildTranscriptMock).toHaveBeenCalledTimes(2);
    buildTranscriptMock.mockClear();

    await act(async () => {
      sendEvent({
        companyId: "company-1", type: "heartbeat.run.log", createdAt: "2026-04-20T00:00:00.000Z",
        payload: { runId: "run-1", ts: "2026-04-20T00:00:00.000Z", stream: "stdout", chunk: "hello from run 1\n" },
      });
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

  it("retains an accumulated buffer through a transient empty poll (PAP-462 B3)", async () => {
    const ts = "2026-08-08T00:00:00.000Z";
    const row = JSON.stringify({
      ts,
      stream: "stdout",
      chunk: '{"type":"acpx.text_delta","text":"hello"}\n',
      seq: 1,
    });
    // Serve the buffered chunk on the FIRST persisted-log read only; every later
    // read (including after the run reappears) returns nothing new. So the chunk
    // can only be present the second time if the buffer survived the gap.
    logMock.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 100 });
    logMock.mockResolvedValueOnce({ runId: "run-1", store: "memory", logRef: "log-1", content: `${row}\n`, nextOffset: 100 });

    const captured: { value: ReturnType<typeof useLiveRunTranscripts> | null } = { value: null };
    function Harness({ runs }: { runs: Array<{ id: string; status: string; adapterType: string }> }) {
      captured.value = useLiveRunTranscripts({ companyId: "company-1", runs, enableRealtimeUpdates: false });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const runList = [{ id: "run-1", status: "running", adapterType: "gemini_local" }];

    await act(async () => {
      root.render(<Harness runs={runList} />);
      await Promise.resolve();
    });
    expect(captured.value?.transcriptByRun.get("run-1")).toHaveLength(1);

    // Transient empty poll: run momentarily absent from the list.
    await act(async () => {
      root.render(<Harness runs={[]} />);
      await Promise.resolve();
    });

    // Run reappears within the grace window — the buffer must survive rather than
    // re-hydrate from a (now empty) truncated read.
    await act(async () => {
      root.render(<Harness runs={runList} />);
      await Promise.resolve();
    });
    expect(captured.value?.transcriptByRun.get("run-1")).toHaveLength(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("prunes a buffer once a run stays absent past the grace window (PAP-462 B3)", async () => {
    vi.useFakeTimers();
    try {
      const ts = "2026-08-08T00:00:00.000Z";
      const row = JSON.stringify({
        ts,
        stream: "stdout",
        chunk: '{"type":"acpx.text_delta","text":"hello"}\n',
        seq: 1,
      });
      logMock.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 100 });
      logMock.mockResolvedValueOnce({ runId: "run-1", store: "memory", logRef: "log-1", content: `${row}\n`, nextOffset: 100 });

      const captured: { value: ReturnType<typeof useLiveRunTranscripts> | null } = { value: null };
      function Harness({ runs }: { runs: Array<{ id: string; status: string; adapterType: string }> }) {
        captured.value = useLiveRunTranscripts({ companyId: "company-1", runs, enableRealtimeUpdates: false });
        return null;
      }

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const runList = [{ id: "run-1", status: "running", adapterType: "gemini_local" }];

      await act(async () => {
        root.render(<Harness runs={runList} />);
        await Promise.resolve();
      });
      expect(captured.value?.transcriptByRun.get("run-1")).toHaveLength(1);

      await act(async () => {
        root.render(<Harness runs={[]} />);
        await Promise.resolve();
      });

      // Stay absent long enough for the grace window to lapse and the deferred
      // prune to fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });

      // On reappear the buffer is gone, so the (now empty) read rebuilds nothing.
      await act(async () => {
        root.render(<Harness runs={runList} />);
        await Promise.resolve();
      });
      expect(captured.value?.transcriptByRun.get("run-1") ?? []).toHaveLength(0);

      act(() => {
        root.unmount();
      });
      container.remove();
    } finally {
      vi.useRealTimers();
    }
  });

});
