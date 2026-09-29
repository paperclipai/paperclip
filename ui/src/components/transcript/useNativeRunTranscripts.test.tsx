// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeRunTranscripts } from "./useNativeRunTranscripts";
import { TRANSCRIPT_REQUEST_TIMEOUT_MS } from "./read-transcript-request";

const eventsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { events: eventsMock },
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

  it("marks older durable history when the tail page reports earlier events", async () => {
    eventsMock.mockResolvedValueOnce([{
      id: "event-tail", companyId: "company", runId: "one", agentId: "agent", seq: 4,
      eventEpoch: "epoch-b", cursor: "e:epoch-b:4", historyBefore: true,
      eventType: "turn.started", stream: null, level: null, color: null,
      message: null, payload: null, createdAt: new Date(0),
    }]);
    await act(async () => { root.render(<StateProbe runs={[{ id: "one", status: "succeeded", runtimeMode: "native" }]} />); });
    expect(eventsMock).toHaveBeenCalledWith("one", "tail", 1_000, expect.any(Object));
    expect(latest.historyCollapsedRunIds.has("one")).toBe(true);
  });

  it("continues a short page when its last row reports more history after the byte budget", async () => {
    const event = (id: string, cursor: string) => ({
      id, companyId: "company", runId: "one", agentId: "agent", seq: 1,
      eventEpoch: "epoch", cursor, eventType: "turn.started", stream: null,
      level: null, color: null, message: null, payload: null, createdAt: new Date(0),
    });
    eventsMock
      .mockResolvedValueOnce([{ ...event("first", "cursor-1"), historyAfter: true }])
      .mockResolvedValueOnce([event("second", "cursor-2")]);
    await act(async () => {
      root.render(<StateProbe runs={[{ id: "one", status: "succeeded", runtimeMode: "native" }]} />);
    });
    expect(eventsMock.mock.calls.map(([, cursor]) => cursor)).toEqual(["tail", "cursor-1"]);
    expect(latest.transcriptByRun.has("one")).toBe(true);
  });

  it("caps automatic backlog catch-up and jumps to the latest tail", async () => {
    const fullPage = (page: number) => Array.from({ length: 1_000 }, (_, index) => ({
      id: `event-${page}-${index}`,
      companyId: "company", runId: "one", agentId: "agent", seq: page * 1_000 + index,
      eventEpoch: "epoch", cursor: `cursor-${page}-${index}`,
      eventType: "unknown.event", stream: null, level: null, color: null,
      message: null, payload: null, createdAt: new Date(0),
    }));
    eventsMock
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce(fullPage(2))
      .mockResolvedValueOnce(fullPage(3))
      .mockResolvedValueOnce(fullPage(4))
      .mockResolvedValueOnce([{ ...fullPage(5)[999], historyBefore: true }]);

    await act(async () => {
      root.render(<StateProbe runs={[{ id: "one", status: "succeeded", runtimeMode: "native" }]} />);
    });

    expect(eventsMock.mock.calls.map(([, cursor]) => cursor)).toEqual([
      "tail", "cursor-1-999", "cursor-2-999", "cursor-3-999", "tail",
    ]);
    expect(latest.historyCollapsedRunIds.has("one")).toBe(true);
    expect(latest.hydratedRunIds.has("one")).toBe(true);
  });
});
