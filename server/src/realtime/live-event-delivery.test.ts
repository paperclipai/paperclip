import { afterEach, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createLiveEventDelivery, LIVE_DELIVERY_MAX_BYTES, LIVE_DELIVERY_MAX_ITEMS } from "./live-event-delivery.js";

const event = (seq = 1, runId = "run-1"): LiveEvent => ({ id: seq, companyId: "company", type: "heartbeat.run.log",
  createdAt: "2026-10-24T00:00:00Z", payload: { runId, agentId: "agent", seq, chunk: "output" } });
function fixture(authorize = vi.fn(async (value: LiveEvent) => value as LiveEvent | null)) {
  const frames: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn((text: string, callback?: (error?: Error) => void) => {
    frames.push(JSON.parse(text)); callback?.();
  }), close: vi.fn() };
  const decorate = vi.fn(async (value: LiveEvent) => ({ ...value, toastEligible: true }));
  const onError = vi.fn();
  const delivery = createLiveEventDelivery({ socket, authorize, decorate, onError });
  const subscribe = (runIds: string[], revision = 1) => delivery.receive(JSON.stringify({ type: "live.interests", version: 1, revision, runIds }));
  return { socket, frames, delivery, subscribe, authorize, decorate, onError };
}
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it("leaves older clients on the full stream and negotiates only after a client hello", async () => {
  const f = fixture();
  expect(f.frames).toEqual([]);
  f.delivery.enqueue(event()); await settle();
  expect(f.frames[0].payload.chunk).toBe("output");
  f.delivery.receive(JSON.stringify({ type: "live.hello", version: 1 }));
  expect(f.frames.at(-1)).toMatchObject({ type: "live.capabilities", capabilities: ["run-interests"] });
  f.delivery.dispose();
});
it("filters full transcripts before authorization while keeping bounded authorized activity and lifecycle", async () => {
  const f = fixture(); f.subscribe([]);
  const original = event();
  for (let i = 0; i < 512; i++) f.delivery.enqueue({ ...original, id: i });
  f.delivery.enqueue({ ...event(), type: "heartbeat.run.status", payload: { runId: "run-1", status: "succeeded" } });
  await settle();
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toEqual([]);
  expect(f.frames.find(frame => frame.type === "heartbeat.run.activity").payload).toEqual({ runId: "run-1", agentId: "agent", lastOutputAt: original.createdAt });
  expect(f.frames.at(-1)).toMatchObject({ type: "heartbeat.run.status", toastEligible: true });
  expect(original.payload.chunk).toBe("output");
  f.delivery.dispose();
});
it("reauthorizes each interested delivery and rechecks interests after an asynchronous permission lookup", async () => {
  let release!: (event: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  f.subscribe(["run-1"]); f.delivery.enqueue(event());
  f.subscribe([], 2); release(event()); await settle();
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toEqual([]);
  expect(f.frames.at(-1)).toMatchObject({ type: "live.subscribed", revision: 2 });
  f.delivery.dispose();
});
it("cannot turn run interest into authorization or bypass delivery redaction", async () => {
  const f = fixture(vi.fn(async value => value.payload.seq === 1 ? { ...value, payload: { ...value.payload, chunk: "redacted" } } : null));
  f.subscribe(["run-1"]); f.delivery.enqueue(event()); f.delivery.enqueue(event(2)); await settle();
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log").map(frame => frame.payload.chunk)).toEqual(["redacted"]);
  f.delivery.dispose();
});
it.each(["items", "bytes"])("bounds queued %s, notifies resynchronization and resumes only after a new revision", async kind => {
  let release!: (event: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  f.subscribe(["run-1"]); f.delivery.enqueue(event());
  if (kind === "items") for (let i = 0; i < LIVE_DELIVERY_MAX_ITEMS; i++) f.delivery.enqueue(event(i + 2));
  else f.delivery.enqueue({ ...event(2), payload: { ...event(2).payload, chunk: "x".repeat(LIVE_DELIVERY_MAX_BYTES) } });
  expect(f.delivery.metrics()).toMatchObject({ needsResync: true });
  expect(f.delivery.metrics().retainedBytes).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_BYTES);
  expect(f.delivery.metrics().retainedItems).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_ITEMS);
  expect(f.frames.filter(frame => frame.type === "live.resync")).toHaveLength(1);
  release(event()); await settle();
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toHaveLength(0);
  f.subscribe(["run-1"], 2);
  expect(f.delivery.metrics().needsResync).toBe(false);
  f.delivery.dispose();
});
it("closes persistent congestion on its pending-work deadline without another source event", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.subscribe(["run-1"]); f.socket.bufferedAmount = LIVE_DELIVERY_MAX_BYTES;
  f.delivery.enqueue(event()); await vi.advanceTimersByTimeAsync(5_000);
  expect(f.socket.close).toHaveBeenCalledWith(1013, "persistent event backlog");
  f.delivery.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps an unsent gap notice through unrelated interest changes after the socket drains", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    f.subscribe(["run-1"]);
    f.socket.bufferedAmount = LIVE_DELIVERY_MAX_BYTES;
    f.delivery.enqueue(event());
    expect(f.frames.some(frame => frame.type === "live.resync")).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    f.socket.bufferedAmount = 0;
    f.subscribe(["run-1", "run-2"], 2);
    expect(f.frames.at(-1)).toMatchObject({ type: "live.resync", revision: 2 });
    expect(f.delivery.metrics().needsResync).toBe(true);
    f.delivery.enqueue(event(2)); await settle();
    expect(f.frames.some(frame => frame.type === "heartbeat.run.log")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.socket.close).toHaveBeenCalledWith(1013, "persistent event backlog");
  } finally { f.delivery.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])("preserves the overflow deadline across resubscription until delivery settles: %s", async settled => {
  vi.useFakeTimers();
  let release!: (event: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  try {
    f.subscribe(["run-1"]); f.delivery.enqueue(event());
    f.delivery.enqueue({ ...event(2), payload: { ...event(2).payload, chunk: "x".repeat(LIVE_DELIVERY_MAX_BYTES) } });
    expect(f.frames.at(-1)).toMatchObject({ type: "live.resync", revision: 1 });
    await vi.advanceTimersByTimeAsync(4_000);
    f.subscribe(["run-1"], 2);
    expect(f.frames.at(-1)).toMatchObject({ type: "live.subscribed", revision: 2 });
    expect(f.delivery.metrics().needsResync).toBe(false);
    if (settled) { release(event()); await settle(); }
    await vi.advanceTimersByTimeAsync(1_000);
    if (settled) expect(f.socket.close).not.toHaveBeenCalled();
    else expect(f.socket.close).toHaveBeenCalledWith(1013, "persistent event backlog");
  } finally { f.delivery.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});
it("recovers failed delivery reads through resync rather than silently claiming healthy streaming", async () => {
  const f = fixture(vi.fn(async () => { throw new Error("permission database unavailable"); }));
  f.subscribe(["run-1"]); f.delivery.enqueue(event()); await settle();
  expect(f.frames.at(-1)).toMatchObject({ type: "live.resync" });
  expect(f.onError).toHaveBeenCalledOnce(); f.delivery.dispose();
});
it("keeps older clients connected after a failed permission read and authorizes the next event", async () => {
  const authorize = vi.fn(async (value: LiveEvent) => value);
  authorize.mockRejectedValueOnce(new Error("permission database unavailable"));
  const f = fixture(authorize);
  f.delivery.enqueue(event()); f.delivery.enqueue(event(2)); await settle();
  expect(f.frames.map(frame => frame.payload.seq)).toEqual([2]);
  expect(f.socket.close).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledOnce();
  f.delivery.dispose();
});
it("rejects unbounded interest sets and stale revision commands", () => {
  const f = fixture(); f.subscribe(["run-1"]); f.subscribe([], 1);
  expect(f.socket.close).toHaveBeenCalledWith(1008, "invalid run interests");
  const other = fixture(); other.subscribe(Array.from({ length: 1001 }, (_, i) => `run-${i}`));
  expect(other.socket.close).toHaveBeenCalled();
  f.delivery.dispose(); other.delivery.dispose();
});

it.each([false, true].flatMap(negotiated => ["authorize", "decorate"].map(stage => ({ negotiated, stage }))))(
  "closes a stalled $stage read below the queue bound (negotiated=$negotiated)", async ({ negotiated, stage }) => {
    vi.useFakeTimers();
    let release!: (value: LiveEvent) => void;
    const pending = new Promise<LiveEvent>(resolve => { release = resolve; });
    const f = fixture(stage === "authorize" ? vi.fn(() => pending) : undefined);
    const other = fixture();
    try {
      if (stage === "decorate") f.decorate.mockImplementationOnce(async () => ({ ...await pending, toastEligible: true }));
      if (negotiated) f.subscribe(["run-1"]);
      const source = stage === "authorize" ? event() : { ...event(), type: "heartbeat.run.status" as const };
      f.delivery.enqueue(source);
      f.delivery.enqueue(event(2));
      other.delivery.enqueue(event());
      await settle();
      expect(other.frames).toHaveLength(1);
      expect(f.delivery.metrics()).toMatchObject({ retainedItems: 2, needsResync: false });
      await vi.advanceTimersByTimeAsync(4_000);
      if (negotiated) f.subscribe(["run-1"], 2);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.socket.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.socket.close).toHaveBeenCalledWith(1013, "persistent event backlog");
      expect(f.delivery.metrics().retainedItems).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      release(source); await settle();
      expect(f.delivery.metrics()).toMatchObject({ retainedItems: 0, retainedBytes: 0 });
      expect(f.frames.filter(frame => frame.type.startsWith("heartbeat."))).toEqual([]);
      expect(f.authorize).toHaveBeenCalledOnce();
    } finally { f.delivery.dispose(); other.delivery.dispose(); }
  });

it.each(["resolve", "dispose"])("clears a pending-read deadline on %s without idle work", async ending => {
  vi.useFakeTimers();
  let release!: (value: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  try {
    f.subscribe(["run-1"]); f.delivery.enqueue(event());
    await vi.advanceTimersByTimeAsync(4_999);
    if (ending === "dispose") f.delivery.dispose();
    release(event()); await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(f.socket.close).not.toHaveBeenCalled();
    expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toHaveLength(ending === "resolve" ? 1 : 0);
  } finally { f.delivery.dispose(); }
});

it("cannot restart recovery timers when a timed-out read later rejects", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>((_resolve, rejectRead) => { reject = rejectRead; })));
  try {
    f.subscribe(["run-1"]); f.delivery.enqueue(event());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.socket.close).toHaveBeenCalledOnce();
    reject(new Error("late permission failure")); await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.frames.some(frame => frame.type === "live.resync")).toBe(false);
    expect(f.authorize).toHaveBeenCalledOnce();
  } finally { f.delivery.dispose(); }
});
