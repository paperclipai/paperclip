// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeRunTranscripts } from "./useNativeRunTranscripts";
import { TRANSCRIPT_REQUEST_TIMEOUT_MS } from "./read-transcript-request";

const eventsMock = vi.hoisted(() => vi.fn());
const contextMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { events: eventsMock, eventContext: contextMock },
}));

function Probe() {
  const { errorsByRun } = useNativeRunTranscripts([
    { id: "native-run", status: "succeeded", runtimeMode: "native" },
  ]);
  return (
    <div data-testid="errors">
      {[...errorsByRun.keys()].join(",")}
    </div>
  );
}

function MultiRunProbe() {
  useNativeRunTranscripts([
    { id: "failed-run", status: "succeeded", runtimeMode: "native" },
    { id: "healthy-run", status: "succeeded", runtimeMode: "native" },
  ]);
  return null;
}

describe("useNativeRunTranscripts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    eventsMock.mockReset();
    contextMock.mockReset().mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("exposes event transport failures and retries terminal runs until recovery", async () => {
    eventsMock
      .mockRejectedValueOnce(new Error("event endpoint unavailable"))
      .mockResolvedValue([]);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("native-run");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(eventsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });

  it("retries only terminal runs whose event request failed", async () => {
    eventsMock.mockImplementation((runId: string) => (
      runId === "failed-run"
        ? Promise.reject(new Error("event endpoint unavailable"))
        : Promise.resolve([])
    ));

    await act(async () => {
      root.render(<MultiRunProbe />);
      await Promise.resolve();
    });
    expect(eventsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(eventsMock).toHaveBeenCalledTimes(3);
    expect(eventsMock.mock.calls.at(-1)?.[0]).toBe("failed-run");
  });
});

// Initial readiness is separate from an empty transcript: the task shell must
// not reveal empty history while the first durable page is still in flight.
describe("native history readiness and stable projection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useNativeRunTranscripts>;
  function StateProbe({ runs = [{ id: "one", status: "running", runtimeMode: "native" as const }] }) {
    latest = useNativeRunTranscripts(runs);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    eventsMock.mockReset();
    contextMock.mockReset().mockResolvedValue([]);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("distinguishes pending, loaded-empty and failed, and supports explicit retry", async () => {
    let resolve!: (rows: never[]) => void;
    eventsMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { root.render(<StateProbe />); });
    expect(latest.isInitialHydrating).toBe(true);
    await act(async () => { resolve([]); });
    expect(latest.isInitialHydrating).toBe(false);
    expect(latest.hydratedRunIds.has("one")).toBe(true);
    eventsMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.errorsByRun.has("one")).toBe(true);
    expect(latest.isInitialHydrating).toBe(false);
    eventsMock.mockResolvedValue([]);
    await act(async () => { latest.retry(); });
    expect(latest.errorsByRun.size).toBe(0);
  });

  it("does not rebuild unchanged history on empty polls", async () => {
    eventsMock.mockResolvedValueOnce([{ seq: 1, payload: {}, eventType: "log" }]).mockResolvedValue([]);
    await act(async () => { root.render(<StateProbe />); });
    const projection = latest.transcriptByRun;
    const rows = projection.get("one");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.transcriptByRun).toBe(projection);
    expect(latest.transcriptByRun.get("one")).toBe(rows);
  });

  it("times out stalled history, aborts its request, and ignores a late response before retry", async () => {
    let resolveLate!: (rows: never[]) => void;
    eventsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    await act(async () => { root.render(<StateProbe />); });
    const signal = eventsMock.mock.calls[0][3].signal as AbortSignal;
    expect(latest.isInitialHydrating).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS); });
    expect(signal.aborted).toBe(true);
    expect(latest.isInitialHydrating).toBe(false);
    expect(latest.errorsByRun.get("one")?.message).toContain("too long");
    await act(async () => { resolveLate([]); });
    expect(latest.errorsByRun.has("one")).toBe(true);
    eventsMock.mockResolvedValue([]);
    await act(async () => { latest.retry(); });
    expect(latest.errorsByRun.size).toBe(0);
    expect(eventsMock.mock.calls[1][3].signal.aborted).toBe(false);
  });

  it("commits a resolved run independently of a stalled sibling and retains its cursor", async () => {
    const rows = [{ seq: 7, payload: {}, eventType: "log" }];
    eventsMock.mockImplementation((id) => id === "slow" ? new Promise(() => {}) : Promise.resolve(rows));
    const one = { id: "one", status: "succeeded", runtimeMode: "native" as const };
    await act(async () => { root.render(<StateProbe runs={[one, { ...one, id: "slow" }]} />); });
    expect(latest.hydratedRunIds.has("one")).toBe(true);
    expect(latest.hydratedRunIds.has("slow")).toBe(false);
    expect(latest.transcriptByRun.has("one")).toBe(true);
    await act(async () => { root.render(<StateProbe runs={[one]} />); });
    expect(eventsMock.mock.calls.filter(([id]) => id === "one").map(([, cursor]) => cursor)).toEqual(["tail", 7]);
    expect(latest.isInitialHydrating).toBe(false);
  });
  it("loads only the recent page and exposes collapsed history without draining old pages", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => ({
      seq: 90_001 + index, payload: {}, eventType: "log",
      ...(index === 0 ? { historyBefore: true } : {}),
      ...(index === 999 ? { historyAfter: false } : {}),
    }));
    eventsMock.mockResolvedValue(page);
    await act(async () => { root.render(<StateProbe />); });
    expect(eventsMock).toHaveBeenCalledTimes(1);
    expect(eventsMock.mock.calls[0][1]).toBe("tail");
    expect(latest.historyCollapsedRunIds.has("one")).toBe(true);
    expect(latest.isInitialHydrating).toBe(false);
  });

  it("jumps to the current tail after bounded catch-up and keeps the final response", async () => {
    let catchup = false;
    let forwardPages = 0;
    const final = {
      id: 1_000_000, runId: "one", seq: 1_000_000, eventType: "item.completed",
      createdAt: "2026-09-30T12:00:00Z", historyBefore: true, historyAfter: false,
      payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "one",
        eventType: "item.completed", itemId: "answer",
        payload: { kind: "agentMessage", text: "Latest final answer", channel: "final" },
      } },
    };
    eventsMock.mockImplementation((_id, cursor) => {
      if (!catchup) return Promise.resolve([{ seq: 1, payload: {}, eventType: "log", historyAfter: false }]);
      if (cursor === "tail") return Promise.resolve([final]);
      forwardPages += 1;
      return Promise.resolve([{ seq: cursor + 1, payload: {}, eventType: "log", historyAfter: true }]);
    });
    await act(async () => { root.render(<StateProbe />); });
    catchup = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(forwardPages).toBe(4);
    expect(eventsMock).toHaveBeenCalledTimes(6);
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Latest final answer" }));
    expect(latest.historyCollapsedRunIds.has("one")).toBe(true);
    eventsMock.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(eventsMock.mock.calls.at(-1)?.[1]).toBe(1_000_000);
  });

  it("keeps pending requests and the final answer outside the scrollback window, then drops resolved context", async () => {
    const contextEvent = (seq: number, eventType: string, payload: Record<string, unknown>) => ({
      id: seq, seq, runId: "one", eventType, createdAt: "2026-09-30T12:00:00Z",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        runId: "one", eventType, payload } },
    });
    const question = contextEvent(1, "runtime_request.created", { request: {
      requestId: "old-permission", requestKind: "permission_approval", type: "permission",
      status: "pending", prompt: "Allow this operation?",
    } });
    const answer = contextEvent(2, "item.completed", {
      kind: "agentMessage", text: "Preserved final answer", channel: "final",
    });
    contextMock.mockResolvedValue([question, answer]);
    eventsMock.mockResolvedValueOnce([{ seq: 100_000, payload: {}, eventType: "log", historyBefore: true, historyAfter: false }]).mockResolvedValue([]);
    await act(async () => { root.render(<StateProbe />); });
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "runtime_request", requestId: "old-permission", status: "pending" }));
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Preserved final answer" }));
    contextMock.mockResolvedValue([answer]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.transcriptByRun.get("one")?.some((entry) => entry.kind === "runtime_request")).toBe(false);
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Preserved final answer" }));
  });

  it("keeps successful event pages visible when context fails and retries a settled run", async () => {
    const final = {
      id: 99, seq: 99, runId: "one", eventType: "item.completed", historyAfter: false,
      createdAt: "2026-09-30T12:00:00Z",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        runId: "one", eventType: "item.completed",
        payload: { kind: "agentMessage", text: "Visible despite the context outage", channel: "final" },
      } },
    };
    eventsMock.mockResolvedValueOnce([final]).mockResolvedValue([]);
    contextMock.mockRejectedValueOnce(new Error("context unavailable")).mockResolvedValue([]);
    await act(async () => { root.render(<StateProbe runs={[{ id: "one", status: "succeeded", runtimeMode: "native" }]} />); });
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Visible despite the context outage" }));
    expect(latest.errorsByRun.get("one")?.message).toBe("context unavailable");
    expect(latest.isInitialHydrating).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(eventsMock.mock.calls.at(-1)?.[1]).toBe(99);
    expect(contextMock).toHaveBeenCalledTimes(2);
    expect(latest.errorsByRun.size).toBe(0);
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Visible despite the context outage" }));
  });

  it("treats the current context as authoritative for requests in older event windows", async () => {
    const question = { id: 1, seq: 1, runId: "one", eventType: "runtime_request.created",
      createdAt: "2026-09-30T12:00:00Z", payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "one",
        eventType: "runtime_request.created", payload: { request: {
          requestId: "old-permission", requestKind: "permission_approval", status: "pending",
        } },
      } } };
    eventsMock.mockResolvedValueOnce([question]).mockResolvedValue([]);
    contextMock.mockResolvedValueOnce([question]).mockResolvedValue([]);
    await act(async () => { root.render(<StateProbe />); });
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "runtime_request", status: "pending" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.errorsByRun.size).toBe(0);
    expect(latest.transcriptByRun.get("one")?.some((entry) => entry.kind === "runtime_request" && entry.status === "pending")).toBe(false);
  });

  it("does not reopen stale pending requests while context is unavailable", async () => {
    const event = (seq: number, eventType: string, payload: Record<string, unknown>) => ({
      id: seq, seq, runId: "one", eventType, createdAt: "2026-09-30T12:00:00Z",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        runId: "one", eventType, payload } },
    });
    const question = event(1, "runtime_request.created", { request: {
      requestId: "old-permission", requestKind: "permission_approval", status: "pending",
    } });
    const answer = event(2, "item.completed", {
      kind: "agentMessage", channel: "final", text: "Keep the existing answer visible",
    });
    contextMock.mockResolvedValueOnce([question, answer])
      .mockRejectedValueOnce(new Error("context unavailable"))
      .mockResolvedValue([answer]);
    eventsMock.mockResolvedValueOnce([{ seq: 100, payload: {}, eventType: "log", historyBefore: true, historyAfter: false }])
      .mockResolvedValueOnce([{ ...event(101, "runtime_request.resolved", { requestId: "old-permission" }), historyAfter: true }])
      .mockResolvedValueOnce([{ seq: 102, eventType: "log", payload: { text: "x".repeat(2 * 1024 * 1024) }, historyAfter: false }])
      .mockResolvedValue([]);
    await act(async () => { root.render(<StateProbe />); });
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "runtime_request", status: "pending" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.errorsByRun.has("one")).toBe(true);
    expect(latest.transcriptByRun.get("one")?.some((entry) => entry.kind === "runtime_request" && entry.status === "pending")).toBe(false);
    expect(latest.transcriptByRun.get("one")).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Keep the existing answer visible" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(latest.errorsByRun.size).toBe(0);
    expect(latest.transcriptByRun.get("one")?.some((entry) => entry.kind === "runtime_request" && entry.status === "pending")).toBe(false);
  });

});
