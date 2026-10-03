import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const PAPERCLIP_RUN_ID = "11111111-2222-3333-4444-555555555555";

type Harness = {
  ctx: AdapterExecutionContext;
  logs: string[];
  events: AdapterRuntimeEvent[];
  onDispatch: ReturnType<typeof vi.fn>;
};

function makeHarness(config: Record<string, unknown> = {}, extra: Partial<AdapterExecutionContext> = {}): Harness {
  const logs: string[] = [];
  const events: AdapterRuntimeEvent[] = [];
  const onDispatch = vi.fn();
  const fullConfig = {
    apiBaseUrl: "http://127.0.0.1:8642",
    apiKey: "secret-key",
    timeoutSec: 5,
    pollIntervalMs: 250,
    eventReconnectMs: 250,
    ...config,
  };
  const ctx: AdapterExecutionContext = {
    runId: PAPERCLIP_RUN_ID,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: fullConfig,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: fullConfig,
    context: { issueId: "issue-1", paperclipWake: null },
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
    onMeta: async () => undefined,
    onEvent: async (event) => {
      events.push(event);
    },
    onDispatch,
    ...extra,
  };
  return { ctx, logs, events, onDispatch };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function networkError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });
}

type CreateStep = () => Response | Promise<Response>;

type GatewayPlan = {
  create: CreateStep;
  status?: Record<string, unknown> | ((stops: number) => Record<string, unknown> | Response);
  stop?: (init: RequestInit | undefined) => Response | Promise<Response>;
};

/** A request the gateway accepts but never answers; only the caller's signal ends it. */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

/** Records every create and stop call so "exactly one run" is observable. */
function stubGateway(plan: GatewayPlan) {
  const creates: Array<{ body: string; key: string | undefined }> = [];
  let stops = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/v1/runs") && init?.method === "POST") {
      creates.push({ body: String(init.body), key: headers["Idempotency-Key"] });
      return plan.create();
    }
    if (/\/v1\/runs\/[^/]+\/stop$/.test(url) && init?.method === "POST") {
      stops += 1;
      return plan.stop ? plan.stop(init) : jsonResponse(200, { ok: true });
    }
    if (/\/v1\/runs\/[^/]+$/.test(url)) {
      const status = typeof plan.status === "function" ? plan.status(stops) : plan.status;
      if (status instanceof Response) return status;
      return jsonResponse(200, status ?? { status: "completed", result: { text: "OK" } });
    }
    return new Response("", { status: 404 });
  }));
  return {
    creates,
    get stops() {
      return stops;
    },
  };
}

/** Drives fake timers until the execution settles (backoff and stop grace are real-time waits). */
async function runToCompletion(promise: Promise<AdapterExecutionResult>, maxMs = 60_000): Promise<AdapterExecutionResult> {
  let settled = false;
  promise.then(() => (settled = true), () => (settled = true));
  for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(settled).toBe(true);
  return promise;
}

function dispatchEvidence(result: AdapterExecutionResult): Record<string, any> | undefined {
  return result.resultJson?.hermesDispatch as Record<string, any> | undefined;
}

function cancellation(result: AdapterExecutionResult): Record<string, any> | undefined {
  return result.resultJson?.executionCancellation as Record<string, any> | undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("execute dispatch re-emission", () => {
  it("never claims non-delivery after ambiguous 502s and re-emits the same bytes under the same key", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 });
    const gateway = stubGateway({ create: () => jsonResponse(502, { error: "bad gateway" }) });
    const startedAt = Date.now();

    const result = await runToCompletion(execute(ctx));

    expect(result.executionRecovery).toBeUndefined();
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(gateway.creates).toHaveLength(3);
    expect(new Set(gateway.creates.map((call) => call.body)).size).toBe(1);
    expect(gateway.creates.every((call) => call.key === PAPERCLIP_RUN_ID)).toBe(true);
    expect(dispatchEvidence(result)).toMatchObject({
      phase: "create",
      provenUndelivered: false,
      attempts: 3,
      maxAttempts: 3,
      probe: { method: "POST", path: "/v1/runs", reuseIdempotencyKey: true },
    });
    // Backoff 1.5s then 6s between the three attempts.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_500);
  });

  it("labels a replay after a lost acceptance and tracks exactly one Hermes run", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 });
    let calls = 0;
    const gateway = stubGateway({
      create: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(502, { error: "bad gateway" })
          : jsonResponse(202, { run_id: "run-same", status: "started" });
      },
    });

    const result = await runToCompletion(execute(ctx));

    expect(result.exitCode).toBe(0);
    expect(gateway.creates).toHaveLength(2);
    expect(dispatchEvidence(result)).toMatchObject({
      phase: "created",
      proof: "idempotent_replay",
      hermesRunId: "run-same",
      attempts: 2,
    });
  });

  it("reports bootstrap recovery on a proven refusal and does not re-emit it", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 });
    const gateway = stubGateway({ create: () => jsonResponse(401, { error: "unauthorized" }) });

    const result = await runToCompletion(execute(ctx));

    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(gateway.creates).toHaveLength(1);
    expect(dispatchEvidence(result)).toMatchObject({ provenUndelivered: true, attempts: 1 });
    expect(dispatchEvidence(result)?.probe).toBeUndefined();
  });

  it("reports bootstrap recovery when no attempt was ever accepted by the transport", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 });
    const gateway = stubGateway({
      create: () => {
        throw networkError("ECONNREFUSED");
      },
    });

    const result = await runToCompletion(execute(ctx));

    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(gateway.creates).toHaveLength(3);
    expect(dispatchEvidence(result)?.failures).toEqual([
      { code: "hermes_gateway_connect_failed", transportCode: "ECONNREFUSED" },
      { code: "hermes_gateway_connect_failed", transportCode: "ECONNREFUSED" },
      { code: "hermes_gateway_connect_failed", transportCode: "ECONNREFUSED" },
    ]);
  });

  it("lets one ambiguous attempt forbid bootstrap recovery for the whole series", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 });
    let calls = 0;
    stubGateway({
      create: () => {
        calls += 1;
        if (calls === 1) return jsonResponse(502, { error: "bad gateway" });
        throw networkError("ECONNREFUSED");
      },
    });

    const result = await runToCompletion(execute(ctx));

    expect(result.executionRecovery).toBeUndefined();
    expect(dispatchEvidence(result)?.provenUndelivered).toBe(false);
  });

  it("keeps a single POST by default", async () => {
    const { ctx } = makeHarness();
    const gateway = stubGateway({ create: () => jsonResponse(502, { error: "bad gateway" }) });

    const result = await runToCompletion(execute(ctx));

    expect(gateway.creates).toHaveLength(1);
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(dispatchEvidence(result)).toMatchObject({ attempts: 1, maxAttempts: 1 });
  });

  it("caps dispatchRetryAttempts at three attempts", async () => {
    const { ctx } = makeHarness({ dispatchRetryAttempts: 10 });
    const gateway = stubGateway({ create: () => jsonResponse(503, { error: "unavailable" }) });

    const result = await runToCompletion(execute(ctx));

    expect(gateway.creates).toHaveLength(3);
    expect(dispatchEvidence(result)?.maxAttempts).toBe(3);
  });

  it("correlates Paperclip run, idempotency key, and Hermes run without logging secrets", async () => {
    const { ctx, logs } = makeHarness({ dispatchRetryAttempts: 3 });
    stubGateway({ create: () => jsonResponse(202, { run_id: "run-corr", status: "started" }) });

    const result = await runToCompletion(execute(ctx));
    const logText = logs.join("");

    expect(logText).toContain(`paperclip_run=${PAPERCLIP_RUN_ID}`);
    expect(logText).toContain(`idempotency_key=${PAPERCLIP_RUN_ID}`);
    expect(logText).toContain("hermes_run=run-corr");
    expect(logText).not.toContain("secret-key");
    expect(dispatchEvidence(result)).toMatchObject({
      phase: "created",
      proof: "first_attempt",
      hermesRunId: "run-corr",
      idempotencyKey: PAPERCLIP_RUN_ID,
    });
  });

  it("emits a durable run checkpoint before observing the Hermes run", async () => {
    const { ctx, events } = makeHarness({ dispatchRetryAttempts: 3 });
    stubGateway({ create: () => jsonResponse(202, { run_id: "run-ckpt", status: "started" }) });

    await runToCompletion(execute(ctx));

    const checkpoint = events.find((event) => event.eventType === "hermes.run.created");
    expect(checkpoint?.payload).toMatchObject({
      hermesRunId: "run-ckpt",
      idempotencyKey: PAPERCLIP_RUN_ID,
      canonicalBodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("execute cancellation", () => {
  it("stops the same Hermes run and acknowledges on a terminal receipt", async () => {
    const abort = new AbortController();
    const onCancellationReady = vi.fn(async () => undefined);
    const { ctx } = makeHarness({ dispatchRetryAttempts: 3 }, { signal: abort.signal, onCancellationReady });
    const gateway = stubGateway({
      create: () => jsonResponse(202, { run_id: "run-live", status: "started" }),
      status: (stops) => ({ status: stops > 0 ? "cancelled" : "running" }),
    });
    setTimeout(() => abort.abort(new Error("operator stop")), 600);

    const result = await runToCompletion(execute(ctx));

    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    expect(gateway.stops).toBe(1);
    expect(gateway.creates).toHaveLength(1);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(cancellation(result)?.state).toBe("acknowledged");
    expect(result.resultJson?.run_id).toBe("run-live");
    expect(result.executionRecovery).toBeUndefined();
  });

  it("leaves the Stop requested when Hermes never reports a terminal status", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({
      create: () => jsonResponse(202, { run_id: "run-stuck", status: "started" }),
      status: { status: "running" },
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(gateway.stops).toBe(1);
    expect(cancellation(result)).toMatchObject({
      state: "requested",
      unverifiedReason: expect.stringContaining("run-stuck"),
    });
  });

  it("sends nothing when stopped before dispatch", async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx, onDispatch } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({ create: () => jsonResponse(202, { run_id: "never", status: "started" }) });

    const result = await runToCompletion(execute(ctx));

    expect(gateway.creates).toHaveLength(0);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(cancellation(result)?.state).toBe("acknowledged");
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
  });

  it("does not acknowledge a Stop during backoff after an ambiguous attempt", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({ create: () => jsonResponse(502, { error: "bad gateway" }) });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(gateway.creates).toHaveLength(1);
    expect(cancellation(result)?.state).toBe("requested");
    expect(result.executionRecovery).toBeUndefined();
    expect(dispatchEvidence(result)?.provenUndelivered).toBe(false);
  });

  it("acknowledges a Stop during backoff when every attempt proved non-delivery", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({
      create: () => {
        throw networkError("ECONNREFUSED");
      },
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(gateway.creates).toHaveLength(1);
    expect(cancellation(result)?.state).toBe("acknowledged");
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
  });

  it("bounds a /stop request that Hermes accepts but never answers", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3, timeoutSec: 0 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({
      create: () => jsonResponse(202, { run_id: "run-mute", status: "started" }),
      status: { status: "running" },
      stop: hangUntilAborted,
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx), 15_000);

    expect(gateway.stops).toBe(1);
    expect(result.resultJson?.stop_requested).toBe(false);
    expect(cancellation(result)?.state).toBe("requested");
  });

  it("keeps verifying the Stop after a transient status failure", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    let polls = 0;
    const gateway = stubGateway({
      create: () => jsonResponse(202, { run_id: "run-flaky", status: "started" }),
      status: (stops) => {
        if (stops === 0) return { status: "running" };
        polls += 1;
        return polls === 1 ? jsonResponse(503, { error: "unavailable" }) : { status: "cancelled" };
      },
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(gateway.stops).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(cancellation(result)?.state).toBe("acknowledged");
  });

  it("keeps the real outcome when the run completes while the Stop is in flight", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    const gateway = stubGateway({
      create: () => jsonResponse(202, { run_id: "run-done", status: "started" }),
      status: (stops) => (stops > 0 ? { status: "completed", result: { text: "finished" } } : { status: "running" }),
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(gateway.stops).toBe(1);
    expect(result.errorCode).not.toBe("hermes_gateway_cancelled");
    expect(result.exitCode).toBe(0);
    expect(cancellation(result)).toBeUndefined();
    expect(result.resultJson?.stop_requested).toBe(true);
    expect(dispatchEvidence(result)).toBeDefined();
  });

  it("keeps a failure outcome when the run fails while the Stop is in flight", async () => {
    const abort = new AbortController();
    const { ctx } = makeHarness(
      { dispatchRetryAttempts: 3 },
      { signal: abort.signal, onCancellationReady: async () => undefined },
    );
    stubGateway({
      create: () => jsonResponse(202, { run_id: "run-failed", status: "started" }),
      status: (stops) => (stops > 0 ? { status: "failed", error: "boom" } : { status: "running" }),
    });
    setTimeout(() => abort.abort(), 300);

    const result = await runToCompletion(execute(ctx));

    expect(result.errorCode).not.toBe("hermes_gateway_cancelled");
    expect(result.exitCode).not.toBe(0);
    expect(cancellation(result)).toBeUndefined();
  });
});
