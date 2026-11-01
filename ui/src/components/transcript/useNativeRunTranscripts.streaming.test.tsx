// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HeartbeatRunEvent, LiveEvent } from "@paperclipai/shared";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "../../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../../lib/live-transcript-interests";
import { useNativeRunTranscripts } from "./useNativeRunTranscripts";
import { nativeRunEventsToTranscript } from "./native-run-events";

const events = vi.hoisted(() => vi.fn());
const conversationEvents = vi.hoisted(() => vi.fn());
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { events, conversationEvents } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { LiveEventSubscriptionContext } = __liveUpdatesTestUtils;
let root: Root;
let store: LiveTranscriptInterests;
let listeners: Set<CompanyLiveEventHandler>;
let sent: Array<{ revision?: number; runIds?: string[] }>;
let latest: ReturnType<typeof useNativeRunTranscripts>;
let subscription: { companyId: string; transcripts: LiveTranscriptInterests; subscribe: (fn: CompanyLiveEventHandler) => () => void };
const row = (seq: number, message = `row ${seq}`, runId = "run-1"): HeartbeatRunEvent => ({
  id: seq, seq, runId, companyId: "company-1", agentId: "agent-1", eventType: "item.completed",
  stream: null, level: null, color: null, message, payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `event-${seq}`,
    sourceSeq: seq, sourceInstanceId: "runner-1", sourceKind: "runner", runId,
    normalizedSessionId: "session-1", eventType: "item.completed", itemId: `message-${seq}`,
    emittedAt: "2026-10-24T00:00:00Z", payload: { kind: "agentMessage", channel: "progress", text: message },
  } }, createdAt: new Date("2026-10-24T00:00:00Z"),
});
function emit(seq: number, signalOnly = false, kind = "agentMessage") {
  const value = row(seq);
  const envelope = value.payload!.prpEvent as { payload: Record<string, unknown> };
  envelope.payload = { ...envelope.payload, kind };
  const event: LiveEvent = { id: seq, companyId: value.companyId, type: "heartbeat.run.event", createdAt: value.createdAt.toISOString(), payload: signalOnly
    ? { runId: value.runId, agentId: value.agentId, eventType: value.eventType, seq }
    : { ...value } };
  for (const listener of listeners) listener(event);
}
function Probe({ companyId = "company-1", enabled = true, older = false, compact = false }: { companyId?: string; enabled?: boolean; older?: boolean; compact?: boolean }) {
  latest = useNativeRunTranscripts([
    { id: "run-1", status: "running", runtimeMode: "native", conversationOnly: compact },
    ...(older ? [{ id: "older", status: "succeeded", runtimeMode: "native" as const }] : []),
  ], { companyId, enabled });
  return null;
}
async function render(companyId = "company-1", enabled = true, older = false, compact = false) {
  await act(async () => root.render(<LiveEventSubscriptionContext.Provider value={subscription}><Probe companyId={companyId} enabled={enabled} older={older} compact={compact} /></LiveEventSubscriptionContext.Provider>));
}
async function negotiate() {
  await act(async () => {
    store.open({ send: text => sent.push(JSON.parse(text)) });
    store.receive({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
    store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision });
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  events.mockReset().mockResolvedValue([]);
  conversationEvents.mockReset().mockResolvedValue([]);
  root = createRoot(document.createElement("div"));
  store = new LiveTranscriptInterests(); listeners = new Set(); sent = [];
  subscription = { companyId: "company-1", transcripts: store, subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); });

it("merges history arriving after live output without losing rows or duplicating a sequence", async () => {
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  events.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render();
  await act(async () => emit(3));
  expect(events).toHaveBeenCalledTimes(1);
  await act(async () => complete([row(1), row(2), row(3, "canonical row 3")]));
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2), row(3, "canonical row 3")]));
});

it.each(["agentMessage", "reasoning"])("streams %s deltas after hydration without recurring history reads", async kind => {
  events.mockResolvedValueOnce([row(1)]);
  await render(); await negotiate();
  const reads = events.mock.calls.length;
  const delta = row(2, "still writing");
  delta.eventType = "item.delta";
  const envelope = delta.payload!.prpEvent as Record<string, unknown>;
  envelope.eventType = "item.delta";
  envelope.payload = { kind, text: "still writing" };
  await act(async () => {
    for (const listener of listeners) listener({ id: 2, companyId: delta.companyId,
      type: "heartbeat.run.event", createdAt: delta.createdAt.toISOString(), payload: { ...delta } });
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(JSON.stringify(latest.transcriptByRun.get("run-1"))).toContain("still writing");
  expect(events).toHaveBeenCalledTimes(reads);
});

it("fetches a consecutive native commit signal and never replaces its complete row with a delayed signal", async () => {
  events.mockResolvedValueOnce([row(1)]);
  await render(); await negotiate();
  const reads = events.mock.calls.length;
  events.mockResolvedValueOnce([row(2, "completed output")]);
  await act(async () => emit(2, true));
  expect(events).toHaveBeenCalledTimes(reads + 1);
  expect(events.mock.calls.at(-1)?.slice(0, 3)).toEqual(["run-1", 1, 1_000]);
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2, "completed output")]));
  await act(async () => { emit(2, true); emit(1, true); await vi.advanceTimersByTimeAsync(90_000); });
  expect(events).toHaveBeenCalledTimes(reads + 1);
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2, "completed output")]));
});

it("retains a signal arriving during an older catch-up until its canonical row is visible", async () => {
  await render(); await negotiate();
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  events.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => emit(1, true));
  const reads = events.mock.calls.length;
  await act(async () => emit(2, true));
  expect(events).toHaveBeenCalledTimes(reads);
  await act(async () => complete([row(1)]));
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1)]));
  events.mockRejectedValueOnce(new Error("history temporarily unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(latest.errorsByRun.has("run-1")).toBe(true);
  events.mockResolvedValueOnce([row(2)]);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(latest.errorsByRun.size).toBe(0);
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2)]));
  const recoveredReads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(recoveredReads);
});

it("renders complete live PRP rows without initiating or scheduling history reads", async () => {
  await render(); await negotiate();
  const reads = events.mock.calls.length;
  await act(async () => { emit(1); emit(2); await vi.advanceTimersByTimeAsync(90_000); });
  expect(events).toHaveBeenCalledTimes(reads);
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2)]));
});

function emitTerminal() {
  const event: LiveEvent = { id: 100, companyId: "company-1", type: "heartbeat.run.status",
    createdAt: new Date().toISOString(), payload: { runId: "run-1", status: "succeeded" } };
  for (const listener of listeners) listener(event);
}

it("finishes slow historical pages while a sibling receives repeated commit and terminal notifications", async () => {
  await render(); await negotiate();
  const olderReads: Array<{ cursor: number; signal: AbortSignal; resolve: (rows: HeartbeatRunEvent[]) => void }> = [];
  events.mockImplementation((runId: string, cursor: number, _limit: number, { signal }: { signal: AbortSignal }) => {
    if (runId === "older") return new Promise(resolve => olderReads.push({ cursor, signal, resolve }));
    return Promise.resolve([row(cursor + 1)]);
  });
  await render("company-1", true, true);
  expect(olderReads).toHaveLength(1);
  await act(async () => emit(2, true));
  expect(olderReads[0].signal.aborted).toBe(false);
  expect(olderReads).toHaveLength(1);
  const firstPage = Array.from({ length: 1_000 }, (_, i) => row(i + 1, `historical ${i + 1}`, "older"));
  await act(async () => olderReads[0].resolve(firstPage));
  expect(olderReads).toHaveLength(2);
  expect(olderReads[1].cursor).toBe(1_000);
  expect(latest.hydratedRunIds.has("older")).toBe(false);
  await act(async () => emit(3, true));
  await act(async () => emit(4, true));
  await act(async () => emitTerminal());
  expect(olderReads[1].signal.aborted).toBe(false);
  expect(olderReads).toHaveLength(2);
  const lastRow = row(1_001, "last historical output", "older");
  await act(async () => olderReads[1].resolve([lastRow]));
  expect(latest.hydratedRunIds.has("older")).toBe(true);
  expect(latest.transcriptByRun.get("older")).toEqual(nativeRunEventsToTranscript([...firstPage, lastRow]));
  const reads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(reads);
});

it("queues one terminal catch-up behind an in-flight read without aborting or overlapping it", async () => {
  await render(); await negotiate();
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  let activeSignal!: AbortSignal;
  events.mockImplementationOnce((_runId, _cursor, _limit, { signal }) => {
    activeSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  });
  await act(async () => emit(1, true));
  const reads = events.mock.calls.length;
  await act(async () => { emitTerminal(); emitTerminal(); });
  expect(activeSignal.aborted).toBe(false);
  expect(events).toHaveBeenCalledTimes(reads);
  events.mockResolvedValueOnce([row(2, "terminal output")]);
  await act(async () => complete([row(1)]));
  expect(events).toHaveBeenCalledTimes(reads + 1);
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1), row(2, "terminal output")]));
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(reads + 1);
});

it("performs no recurring history reads after an acknowledged catch-up, and retries a failed catch-up", async () => {
  await render(); await negotiate();
  const reads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(reads);
  events.mockRejectedValueOnce(new Error("temporary history outage"));
  await act(async () => {
    store.receive({ type: "live.resync", version: 1, revision: sent.at(-1)?.revision });
    store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision });
  });
  expect(latest.errorsByRun.has("run-1")).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(latest.errorsByRun.size).toBe(0);
  const recoveredReads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(recoveredReads);
});

it("withdraws disabled views and rejects events from the previous company", async () => {
  await render(); await negotiate();
  await act(async () => emit(1));
  expect(latest.transcriptByRun.get("run-1")).toHaveLength(1);
  await render("company-1", false);
  expect(sent.at(-1)?.runIds).toEqual([]);
  const reads = events.mock.calls.length;
  await act(async () => { emit(2); await vi.advanceTimersByTimeAsync(30_000); });
  expect(events).toHaveBeenCalledTimes(reads);
  expect(latest.transcriptByRun.get("run-1")).toHaveLength(1);
  await render("company-2");
  await act(async () => emit(3));
  expect(latest.transcriptByRun.get("run-1") ?? []).toEqual([]);
});


it("finishes catch-up while unrelated consumers repeatedly replace shared interests", async () => {
  await render(); await negotiate();
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  events.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => emit(1, true));
  const reads = events.mock.calls.length;
  const signal = events.mock.calls.at(-1)![3].signal as AbortSignal;
  for (let index = 0; index < 4; index++) {
    let release!: () => void;
    await act(async () => { release = store.acquire([`unrelated-${index}`]); });
    expect(signal.aborted).toBe(false);
    await act(async () => store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision }));
    await act(async () => { release(); });
    await act(async () => store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision }));
    expect(signal.aborted).toBe(false);
    expect(events).toHaveBeenCalledTimes(reads);
  }
  await act(async () => complete([row(1, "uninterrupted catch-up")]));
  expect(latest.transcriptByRun.get("run-1")).toEqual(nativeRunEventsToTranscript([row(1, "uninterrupted catch-up")]));
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(reads);
});

it.each([false, true])("settles compact recovery through filtered-out activity without recurring reads (signal only: %s)", async signalOnly => {
  conversationEvents.mockResolvedValueOnce([row(2, "Saved answer")]);
  await render("company-1", true, false, true);
  await negotiate();
  await act(async () => store.close());
  conversationEvents.mockImplementation((_runId, after: number) => Promise.resolve(after < 6 ? [row(6, "Recovered answer")] : []));
  await negotiate();
  await act(async () => emit(10, signalOnly, "reasoning"));
  const settledReads = conversationEvents.mock.calls.length;
  expect(latest.transcriptByRun.get("run-1")?.filter(entry => entry.kind === "assistant").map(entry => entry.text))
    .toEqual(["Saved answer", "Recovered answer"]);
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(conversationEvents).toHaveBeenCalledTimes(settledReads);
  expect(events).not.toHaveBeenCalled();
});

it("does not skip compact conversation rows committed during an older catch-up", async () => {
  conversationEvents.mockResolvedValueOnce([row(2, "Saved answer")]);
  await render("company-1", true, false, true);
  await negotiate();
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  conversationEvents.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => emit(4, true, "reasoning"));
  const reads = conversationEvents.mock.calls.length;
  await act(async () => emit(6, true, "reasoning"));
  expect(conversationEvents).toHaveBeenCalledTimes(reads);
  conversationEvents.mockImplementation((_runId, after: number) => Promise.resolve(after < 5 ? [row(5, "Answer committed during catch-up")] : []));
  await act(async () => complete([]));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(conversationEvents.mock.calls.at(-1)?.slice(0, 3)).toEqual(["run-1", 4, 1_000]);
  expect(latest.transcriptByRun.get("run-1")?.filter(entry => entry.kind === "assistant").map(entry => entry.text))
    .toEqual(["Saved answer", "Answer committed during catch-up"]);
  const settledReads = conversationEvents.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(conversationEvents).toHaveBeenCalledTimes(settledReads);
});
