import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute } from "../src/gateway/server/execute.js";
import {
  adapterExecutionControls,
  captureAdapterStopOwnership,
  createAdapterExecutionControl,
  registerAdapterExecutionControl,
  waitForAdapterStop,
} from "../../../../server/src/services/adapter-execution-control.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Uses the production ownership/registration barriers called by board Stop.
// Only persistence is in memory: readiness reads terminal state after registering,
// and Stop waits for settlement then requires the host's acknowledgment field.
function host() {
  const runId = "offline-host-stop";
  const control = createAdapterExecutionControl();
  let terminal = false;
  let result: AdapterExecutionResult | undefined;
  const config = { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "offline-key", timeoutSec: 0 };
  const ctx: AdapterExecutionContext = {
    runId,
    agent: { id: "agent", companyId: "company", name: "test", adapterType: "hermes_gateway", adapterConfig: config },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    context: {}, config, signal: control.controller.signal,
    onLog: vi.fn(async () => undefined), onDispatch: vi.fn(),
    onCancellationReady: vi.fn(async () => {
      await registerAdapterExecutionControl(runId, control);
      if (terminal) control.controller.abort();
    }),
  };
  return {
    ctx,
    async start() {
      try { result = await execute(ctx); return result; }
      finally { terminal = true; control.finish(); adapterExecutionControls.delete(runId); }
    },
    async stop(persist = Promise.resolve()) {
      const owner = captureAdapterStopOwnership(runId);
      try {
        if (!owner.control) { await persist; terminal = true; return; }
        owner.control.controller.abort();
        await waitForAdapterStop(owner.control.settled);
        if ((result?.resultJson?.executionCancellation as { state?: string })?.state !== "acknowledged") {
          throw new Error("provider termination unverified");
        }
      } finally { owner.release(); }
    },
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const acknowledged = { resultJson: { stop_confirmed: true, executionCancellation: { state: "acknowledged" } } };
const requested = { resultJson: { stop_confirmed: false, executionCancellation: { state: "requested" } } };

describe("board Stop / Hermes host contract (offline)", () => {
  it("waits for an earlier unregistered Stop to persist before dispatch", async () => {
    vi.useFakeTimers();
    const h = host();
    const persisted = deferred();
    const stop = h.stop(persisted.promise);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ctx.onCancellationReady).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.ctx.onDispatch).not.toHaveBeenCalled();
    persisted.resolve();
    await stop;
    expect(await execution).toMatchObject(acknowledged);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles Stop after ownership registration but before readiness resolves", async () => {
    const h = host();
    const ready = h.ctx.onCancellationReady!;
    let stop!: Promise<void>;
    h.ctx.onCancellationReady = async () => { await ready(); stop = h.stop(); };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await h.start()).toMatchObject(acknowledged);
    await stop;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.ctx.onDispatch).not.toHaveBeenCalled();
  });

  it("awaits asynchronous readiness and cleans up when registration fails", async () => {
    vi.useFakeTimers();
    const h = host();
    const gate = deferred();
    const remove = vi.spyOn(h.ctx.signal!, "removeEventListener");
    h.ctx.onCancellationReady = async () => { await gate.promise; throw new Error("registration unavailable"); };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    gate.resolve();
    expect((await execution).exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.ctx.onDispatch).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["abort", "run deadline", "readiness deadline"] as const)(
    "bounds never-settling readiness on %s without dispatch", async (cause) => {
      vi.useFakeTimers();
      const h = host();
      const abort = new AbortController();
      h.ctx.signal = abort.signal;
      h.ctx.config.timeoutSec = cause === "run deadline" ? 0.001 : 0;
      const gate = deferred();
      h.ctx.onCancellationReady = () => gate.promise;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const execution = h.start();
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "abort") abort.abort();
      await vi.advanceTimersByTimeAsync(cause === "readiness deadline" ? 30_001 : 2);
      expect(await execution).toMatchObject({
        exitCode: 1, timedOut: cause !== "abort",
        errorCode: cause === "abort" ? "hermes_gateway_cancelled" : "hermes_gateway_readiness_timeout",
      });
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.ctx.onDispatch).not.toHaveBeenCalled();
      expect(adapterExecutionControls.has(h.ctx.runId)).toBe(false);
    },
  );

  it("does not republish ownership when an earlier Stop settles after readiness times out", async () => {
    vi.useFakeTimers();
    const h = host();
    const persisted = deferred();
    const stop = h.stop(persisted.promise);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await execution).toMatchObject({ errorCode: "hermes_gateway_readiness_timeout" });
    persisted.resolve();
    await stop;
    await vi.advanceTimersByTimeAsync(0);
    expect(adapterExecutionControls.has(h.ctx.runId)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("observes a late readiness rejection after returning", async () => {
    vi.useFakeTimers();
    const h = host();
    let reject!: (error: Error) => void;
    h.ctx.onCancellationReady = () => new Promise<void>((_, fail) => { reject = fail; });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await execution).toMatchObject({ errorCode: "hermes_gateway_readiness_timeout" });
    reject(new Error("late registration failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapterExecutionControls.has(h.ctx.runId)).toBe(false);
  });

  it("rechecks Stop synchronously raised by the dispatch callback", async () => {
    const h = host();
    let stop!: Promise<void>;
    h.ctx.onDispatch = () => { stop = h.stop(); };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await h.start()).toMatchObject(acknowledged);
    await stop;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["create", "observation"])("acknowledges Stop during %s only after terminal proof", async (phase) => {
    vi.useFakeTimers();
    const h = host();
    const terminal = deferred<Response>();
    let stop: Promise<void> | undefined;
    let stopSettled = false;
    let stops = 0;
    const trigger = () => { stop = h.stop().then(() => { stopSettled = true; }); };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(h.ctx.onCancellationReady).toHaveBeenCalledOnce();
        if (phase === "create") trigger();
        return Response.json({ run_id: "remote" });
      }
      if (url.endsWith("/events")) {
        if (phase === "observation") trigger();
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) { stops++; return Response.json({ status: "stopping" }); }
      return stops ? terminal.promise : Response.json({ status: "running" });
    }));
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(stops).toBe(1);
    expect(stopSettled).toBe(false);
    terminal.resolve(Response.json({ status: "cancelled", output: "retained", usage: { input_tokens: 7 } }));
    expect(await execution).toMatchObject({ ...acknowledged, summary: "retained", usage: { inputTokens: 7 } });
    await stop;
    expect(stopSettled).toBe(true);
  });

  it.each(["create", "observation"])("rejects host acknowledgment for unconfirmed Stop during %s", async (phase) => {
    vi.useFakeTimers();
    const h = host();
    let stop!: Promise<unknown>;
    let creates = 0;
    const trigger = () => { stop = h.stop().catch((error: Error) => error.message); };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        creates++;
        if (phase === "create") { trigger(); return new Promise<Response>(() => {}); }
        return Response.json({ run_id: "remote" });
      }
      if (url.endsWith("/run-reservations/stop")) return new Response("unsupported", { status: 404 });
      if (url.endsWith("/events")) { trigger(); return new Promise<Response>(() => {}); }
      return Response.json({ status: "stopping" });
    }));
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await execution).toMatchObject({ ...requested, exitCode: 1 });
    expect(await stop).toBe("provider termination unverified");
    expect(creates).toBe(1);
  });

  it.each([
    ["headers", true], ["body", true], ["headers", false], ["body", false],
  ] as const)("reservation recovery during stalled %s requires terminal proof (%s)", async (phase, confirmed) => {
    vi.useFakeTimers();
    const h = host();
    let stop!: Promise<unknown>;
    let creates = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        creates++;
        stop = h.stop().catch((error: Error) => error.message);
        if (phase === "headers") return new Promise<Response>(() => {});
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }
      if (url.endsWith("/run-reservations/stop")) {
        return Response.json({ run_id: "recovered", reservation_cancelled: true });
      }
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      return Response.json({ status: confirmed ? "cancelled" : "stopping" });
    }));
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await execution).toMatchObject(confirmed ? acknowledged : requested);
    expect(await stop).toBe(confirmed ? undefined : "provider termination unverified");
    expect(creates).toBe(1);
  });

  it.each([true, false])("a Stop racing terminal reconciliation requires final proof (%s)", async (confirmed) => {
    vi.useFakeTimers();
    const h = host();
    let stop!: Promise<unknown>;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return Response.json({ run_id: "remote" });
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      if (++reads === 1) return Response.json({ status: "completed", output: "saved" });
      if (reads === 2) stop = h.stop().catch((error: Error) => error.message);
      return Response.json({ status: confirmed ? "completed" : "running", output: "saved" });
    }));
    const execution = h.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await execution).toMatchObject(confirmed ? acknowledged : requested);
    expect(await stop).toBe(confirmed ? undefined : "provider termination unverified");
  });
});
