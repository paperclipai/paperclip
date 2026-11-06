// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import type { LiveEvent } from "@paperclipai/shared";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "../../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../../lib/live-transcript-interests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

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

describe("useLiveRunTranscripts shared-stream recovery", () => {
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

  it("fetches a consecutive truncated row excluded from an in-flight history response", async () => {
    vi.useFakeTimers();
    let value: ReturnType<typeof useLiveRunTranscripts>;
    function Harness() {
      value = useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: "2026-10-24T00:00:00Z", stream: "stdout", chunk }) + "\n";
    const first = row(1, "first");
    const second = row(2, "complete second output");
    try {
      await act(async () => root.render(<Harness />));
      let finish!: (value: Awaited<ReturnType<typeof logMock>>) => void;
      logMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => negotiate());
      await act(async () => {
        sendEvent({ companyId: "company-1", type: "heartbeat.run.log", createdAt: "2026-10-24T00:00:00Z",
          payload: { runId: "run-1", seq: 1, chunk: "first", stream: "stdout" } });
        sendEvent({ companyId: "company-1", type: "heartbeat.run.log", createdAt: "2026-10-24T00:00:00Z",
          payload: { runId: "run-1", seq: 2, chunk: "short", truncated: true, stream: "stdout" } });
      });
      await act(async () => finish({ runId: "run-1", store: "memory", logRef: "log-1", content: first, nextOffset: first.length }));
      const beforeRetry = logMock.mock.calls.length;
      logMock.mockResolvedValueOnce({ runId: "run-1", store: "memory", logRef: "log-1", content: second, nextOffset: first.length + second.length });
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(logMock.mock.calls.length).toBeGreaterThan(beforeRetry);
      expect(value!.transcriptByRun.get("run-1")).toEqual(expect.arrayContaining([expect.objectContaining({ chunk: "complete second output", seq: 2 })]));
      const settledReads = logMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(logMock).toHaveBeenCalledTimes(settledReads);
    } finally { await act(async () => root.unmount()); }
  });

  it("finishes slow legacy pages while a sibling catches up repeated truncated output", async () => {
    vi.useFakeTimers();
    let value: ReturnType<typeof useLiveRunTranscripts>;
    function Harness() {
      value = useLiveRunTranscripts({ companyId: "company-1", runs: [
        { id: "run-1", status: "running", adapterType: "codex_local" },
        { id: "slow", status: "succeeded", adapterType: "codex_local" },
      ] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    type Result = Awaited<ReturnType<typeof logMock>>;
    const slow: Array<{ resolve: (value: Result) => void; signal: AbortSignal }> = [];
    const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: "2026-10-24T00:00:00Z", stream: "stdout", chunk }) + "\n";
    let seq = 0;
    try {
      await act(async () => root.render(<Harness />));
      logMock.mockImplementation(async (id, offset, _limit, { signal }) => {
        if (id === "slow") return new Promise(resolve => slow.push({ resolve, signal }));
        return { runId: id, store: "memory", logRef: "log-1", content: offset < seq ? row(seq, `complete ${seq}`) : "", nextOffset: seq };
      });
      await act(async () => negotiate());
      for (seq = 1; seq <= 3; seq++) {
        await act(async () => sendEvent({ companyId: "company-1", type: "heartbeat.run.log", createdAt: "2026-10-24T00:00:00Z",
          payload: { runId: "run-1", seq, truncated: true } }));
      }
      expect(slow).toHaveLength(1);
      expect(slow[0].signal.aborted).toBe(false);
      expect(value!.transcriptByRun.get("run-1")).toEqual(expect.arrayContaining([expect.objectContaining({ seq: 3, chunk: "complete 3" })]));
      await act(async () => slow[0].resolve({ runId: "slow", store: "memory", logRef: "log-1", content: row(1, "older output"), nextOffset: 1 }));
      expect(slow).toHaveLength(2);
      expect(slow[1].signal.aborted).toBe(false);
      await act(async () => slow[1].resolve({ runId: "slow", store: "memory", logRef: "log-1", content: "", nextOffset: 1 }));
      expect(value!.transcriptByRun.get("slow")).toEqual(expect.arrayContaining([expect.objectContaining({ chunk: "older output" })]));
      const reads = logMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(logMock).toHaveBeenCalledTimes(reads);
    } finally { await act(async () => root.unmount()); }
  });

  it("coalesces legacy terminal catch-up behind an in-flight read without aborting it", async () => {
    let value: ReturnType<typeof useLiveRunTranscripts>;
    function Harness() {
      value = useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    let finish!: (result: Awaited<ReturnType<typeof logMock>>) => void;
    try {
      await act(async () => root.render(<Harness />));
      logMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => negotiate());
      const reads = logMock.mock.calls.length;
      const signal = logMock.mock.calls.at(-1)![3].signal;
      await act(async () => {
        for (let i = 0; i < 3; i++) sendEvent({ companyId: "company-1", type: "heartbeat.run.status", createdAt: "2026-10-24T00:00:00Z",
          payload: { runId: "run-1", status: "succeeded" } });
      });
      expect(signal.aborted).toBe(false);
      expect(logMock).toHaveBeenCalledTimes(reads);
      logMock.mockResolvedValueOnce({ runId: "run-1", store: "memory", logRef: "log-1", content:
        JSON.stringify({ seq: 1, ts: "2026-10-24T00:00:00Z", stream: "stdout", chunk: "terminal output" }) + "\n", nextOffset: 1 });
      await act(async () => finish({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 }));
      expect(logMock).toHaveBeenCalledTimes(reads + 2);
      expect(value!.transcriptByRun.get("run-1")).toEqual(expect.arrayContaining([expect.objectContaining({ chunk: "terminal output" })]));
    } finally { await act(async () => root.unmount()); }
  });

  it("keeps a legacy catch-up in flight through unrelated interest replacements", async () => {
    vi.useFakeTimers();
    let value: ReturnType<typeof useLiveRunTranscripts>;
    function Harness() {
      value = useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    let finish!: (result: Awaited<ReturnType<typeof logMock>>) => void;
    try {
      await act(async () => root.render(<Harness />));
      logMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => negotiate());
      const reads = logMock.mock.calls.length;
      const signal = logMock.mock.calls.at(-1)![3].signal;
      for (let index = 0; index < 4; index++) {
        let release!: () => void;
        await act(async () => { release = interests.acquire([`native-sibling-${index}`]); });
        expect(signal.aborted).toBe(false);
        await act(async () => acknowledge());
        await act(async () => release());
        await act(async () => acknowledge());
        expect(signal.aborted).toBe(false);
        expect(logMock).toHaveBeenCalledTimes(reads);
      }
      await act(async () => finish({ runId: "run-1", store: "memory", logRef: "log-1", content:
        JSON.stringify({ seq: 1, ts: "2026-10-24T00:00:00Z", stream: "stdout", chunk: "uninterrupted legacy output" }) + "\n", nextOffset: 1 }));
      expect(value!.transcriptByRun.get("run-1")).toEqual(expect.arrayContaining([expect.objectContaining({ chunk: "uninterrupted legacy output" })]));
      const settled = logMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(logMock).toHaveBeenCalledTimes(settled);
    } finally { await act(async () => root.unmount()); }
  });

  it("keeps HTTP polling until interest acknowledgement, then stops recurring reads", async () => {
    vi.useFakeTimers();
    function Harness({ bytes = 0 }: { bytes?: number }) {
      useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local", lastOutputBytes: bytes }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(logMock.mock.calls.length).toBeGreaterThan(1);
      await act(async () => negotiate());
      const afterCatchup = logMock.mock.calls.length;
      await act(async () => root.render(<Harness bytes={512} />));
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(logMock).toHaveBeenCalledTimes(afterCatchup);
      await act(async () => interests.close());
      const afterDisconnect = logMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(logMock.mock.calls.length).toBeGreaterThan(afterDisconnect);
      expect(socketConstructed).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });

  it("reads past a running run's stale byte count after hide/show without another live event", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const line = (seq: number, chunk: string) => JSON.stringify({ seq, chunk, ts: "2026-10-26T00:00:00Z", stream: "stdout" }) + "\n";
    const segments = [line(1, "initial output")];
    const originalBytes = segments[0]!.length;
    logMock.mockImplementation(async (_id, offset) => {
      let cursor = 0;
      for (const segment of segments) {
        if (cursor === offset) return { runId: "run-1", store: "memory", logRef: "log-1", content: segment, nextOffset: offset + segment.length };
        cursor += segment.length;
      }
      return { runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: offset };
    });
    function Harness() {
      useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local", logBytes: originalBytes }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => negotiate());
      await act(async () => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
      segments.push(line(2, "saved during disconnect"), line(3, "last saved page"));
      await act(async () => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => acknowledge());
      const chunks = buildTranscriptMock.mock.calls.at(-1)?.[0];
      expect(chunks).toEqual([
        expect.objectContaining({ chunk: "initial output" }),
        expect.objectContaining({ chunk: "saved during disconnect" }),
        expect.objectContaining({ chunk: "last saved page" }),
      ]);
      const caughtUp = logMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(logMock).toHaveBeenCalledTimes(caughtUp);
    } finally { await act(async () => root.unmount()); }
  });

  it("catches up after resynchronization, hide/show, and terminal status", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    function Harness() {
      useLiveRunTranscripts({ companyId: "company-1", runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }] });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => negotiate());
      const prior = logMock.mock.calls.length;
      await act(async () => { interests.receive({ type: "live.resync", version: 1, revision: sent.at(-1)?.revision }); acknowledge(); });
      expect(logMock.mock.calls.length).toBeGreaterThan(prior);
      await act(async () => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
      expect(sent.at(-1)?.runIds).toEqual([]);
      const hiddenReads = logMock.mock.calls.length;
      await act(async () => acknowledge());
      expect(logMock).toHaveBeenCalledTimes(hiddenReads);
      await act(async () => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => acknowledge());
      expect(sent.at(-1)?.runIds).toEqual(["run-1"]);
      expect(logMock.mock.calls.length).toBeGreaterThan(hiddenReads);
      const beforeTerminal = logMock.mock.calls.length;
      await act(async () => sendEvent({ companyId: "company-1", type: "heartbeat.run.status", createdAt: new Date().toISOString(), payload: { runId: "run-1", status: "succeeded" } }));
      expect(logMock.mock.calls.length).toBeGreaterThan(beforeTerminal);
    } finally { await act(async () => root.unmount()); }
  });
});
