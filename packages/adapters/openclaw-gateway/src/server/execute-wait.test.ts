import type { AdapterExecutionContext, AdapterExecutionResult, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayReply = Record<string, unknown> | "drop";

const gateway = vi.hoisted(() => ({
  connections: 0,
  agentRequests: [] as Array<Record<string, unknown>>,
  waitRequests: [] as Array<Record<string, unknown>>,
  timeline: [] as string[],
  accept: { status: "accepted", runId: "oc-run-1" } as Record<string, unknown> | "drop",
  wait: (_call: number): Record<string, unknown> | "drop" => ({ status: "ok" }),
}));

// Scripted gateway: `gateway.wait(n)` answers the n-th agent.wait (1-based), or
// "drop" closes the socket abnormally (1006) the way a gateway restart does.
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;

    constructor() {
      super();
      gateway.connections++;
      queueMicrotask(() => {
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }));
      });
    }

    send(payload: string) {
      const request = JSON.parse(payload) as { id: string; method: string; params?: Record<string, unknown> };
      gateway.timeline.push(`send:${request.method}`);
      let reply: GatewayReply = {};
      if (request.method === "connect") {
        reply = { protocol: 3 };
      } else if (request.method === "agent") {
        gateway.agentRequests.push(request.params ?? {});
        reply = gateway.accept;
      } else if (request.method === "agent.wait") {
        gateway.waitRequests.push(request.params ?? {});
        reply = gateway.wait(gateway.waitRequests.length);
      }
      queueMicrotask(() => {
        if (reply === "drop") {
          this.emit("close", 1006, Buffer.from(""));
          return;
        }
        this.emit("message", JSON.stringify({ type: "res", id: request.id, ok: true, payload: reply }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

const PAPERCLIP_RUN_ID = "22222222-3333-4444-5555-666666666666";

function createContext(config: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const events: AdapterRuntimeEvent[] = [];
  const ctx: AdapterExecutionContext = {
    runId: PAPERCLIP_RUN_ID,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "ws://127.0.0.1:18789",
      disableDeviceAuth: true,
      timeoutSec: 5,
      ...config,
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_assigned",
    },
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
    onEvent: async (event) => {
      gateway.timeline.push(`event:${event.eventType}`);
      events.push(event);
    },
    onDispatch: () => {},
  };
  return { ctx, logs, events };
}

/** Drives fake time (backoffs, run budget) until execute() settles. */
async function runExecute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let settled = false;
  const promise = execute(ctx).finally(() => {
    settled = true;
  });
  for (let step = 0; !settled; step++) {
    if (step > 10_000) throw new Error("execute() did not settle");
    await vi.advanceTimersByTimeAsync(250);
  }
  return promise;
}

function dispatchOf(result: AdapterExecutionResult) {
  return result.resultJson?.openclawDispatch as Record<string, unknown> | undefined;
}

describe("openclaw_gateway execute wait loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gateway.connections = 0;
    gateway.agentRequests = [];
    gateway.waitRequests = [];
    gateway.timeline = [];
    gateway.accept = { status: "accepted", runId: "oc-run-1" };
    gateway.wait = () => ({ status: "ok" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting on the same run through observation timeouts", async () => {
    gateway.wait = (n) => (n < 4 ? { status: "timeout" } : { status: "ok", summary: "done" });
    const { ctx, events } = createContext({ runBudgetMs: 20_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(result).toMatchObject({ exitCode: 0, summary: "done" });
    expect(gateway.agentRequests).toHaveLength(1);
    expect(gateway.agentRequests[0]).toMatchObject({ timeout: 20, idempotencyKey: PAPERCLIP_RUN_ID });
    expect(gateway.waitRequests).toEqual(Array(4).fill({ runId: "oc-run-1", timeoutMs: 200 }));
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "openclaw.run.accepted",
      payload: expect.objectContaining({
        acceptedRunId: "oc-run-1",
        idempotencyKey: PAPERCLIP_RUN_ID,
        runIdSource: "acceptance",
      }),
    }));
    // The checkpoint is recorded before the first observation.
    expect(gateway.timeline.indexOf("event:openclaw.run.accepted"))
      .toBeLessThan(gateway.timeline.indexOf("send:agent.wait"));
    expect(dispatchOf(result)).toMatchObject({ phase: "completed", acceptedRunId: "oc-run-1", waitCalls: 4 });
  });

  it.each([
    ["stopReason and endedAt", { stopReason: "timeout", endedAt: "2026-01-01T00:00:00Z" }],
    ["timeoutPhase=gateway_draining", { timeoutPhase: "gateway_draining" }],
    ["timeoutPhase=hard_timeout", { timeoutPhase: "hard_timeout" }],
    ["a settled livenessState", { livenessState: "dead" }],
  ])("does not loop on a terminal timeout (%s)", async (_label, fields) => {
    gateway.wait = () => ({ status: "timeout", ...fields });
    const { ctx } = createContext({ runBudgetMs: 20_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(gateway.waitRequests).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "openclaw_gateway_wait_timeout" });
    expect(dispatchOf(result)).toMatchObject({ phase: "terminal_wait_timeout", acceptedRunId: "oc-run-1" });
  });

  it("stops at maxWaitCalls and names the run that may still be running", async () => {
    gateway.wait = () => ({ status: "timeout" });
    const { ctx } = createContext({ runBudgetMs: 60_000, waitWindowMs: 100, maxWaitCalls: 3 });

    const result = await runExecute(ctx);

    expect(gateway.waitRequests).toHaveLength(3);
    expect(gateway.agentRequests).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "openclaw_gateway_wait_budget_exhausted" });
    expect(result.errorMessage).toContain("oc-run-1");
    expect(dispatchOf(result)).toMatchObject({
      phase: "wait_budget_exhausted",
      acceptedRunId: "oc-run-1",
      providerWorkStarted: true,
      waitCalls: 3,
    });
    // Accepted work must never be reported as safe to bootstrap again.
    expect(result.executionRecovery).toBeUndefined();
  });

  it("stops when the run budget elapses", async () => {
    gateway.wait = () => ({ status: "timeout" });
    const { ctx } = createContext({ runBudgetMs: 3_000, waitWindowMs: 100 });

    const result = await runExecute(ctx);

    expect(result.errorCode).toBe("openclaw_gateway_wait_budget_exhausted");
    expect(gateway.waitRequests.length).toBeGreaterThan(1);
    expect(gateway.waitRequests.length).toBeLessThan(60);
  });

  it("caps each agent.wait window to the budget left and never starts a call past it", async () => {
    gateway.wait = () => ({ status: "timeout" });
    const { ctx } = createContext({ runBudgetMs: 2_500, waitWindowMs: 1_000 });

    const result = await runExecute(ctx);

    expect(result.errorCode).toBe("openclaw_gateway_wait_budget_exhausted");
    // t=0 and t=1000 get the full window; t=2000 only the 500ms left; none at t=2500.
    expect(gateway.waitRequests.map((request) => request.timeoutMs)).toEqual([1_000, 1_000, 500]);
  });

  it("does not start agent.wait when dispatch already spent the run budget", async () => {
    const { ctx } = createContext({ runBudgetMs: 1_000, waitWindowMs: 200 });
    const recordEvent = ctx.onEvent;
    ctx.onEvent = async (event) => {
      await recordEvent?.(event);
      // Dispatch took longer than the whole budget.
      if (event.eventType === "openclaw.run.accepted") vi.setSystemTime(Date.now() + 5_000);
    };

    const result = await runExecute(ctx);

    expect(gateway.waitRequests).toHaveLength(0);
    expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "openclaw_gateway_wait_budget_exhausted" });
    expect(result.errorMessage).toContain("oc-run-1");
    expect(dispatchOf(result)).toMatchObject({
      phase: "wait_budget_exhausted",
      acceptedRunId: "oc-run-1",
      providerWorkStarted: true,
    });
  });

  it.each([
    ["error", { status: "error", error: "model crashed" }, "openclaw_gateway_wait_error", "wait_error"],
    ["unexpected", { status: "weird" }, "openclaw_gateway_wait_status_unexpected", "wait_status_unexpected"],
  ])("keeps accepted-run evidence on a %s wait status", async (_label, reply, errorCode, phase) => {
    gateway.wait = () => reply;
    const { ctx } = createContext({ runBudgetMs: 20_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(result).toMatchObject({ exitCode: 1, errorCode });
    expect(result.errorMessage).toContain("oc-run-1");
    expect(dispatchOf(result)).toMatchObject({
      phase,
      acceptedRunId: "oc-run-1",
      idempotencyKey: PAPERCLIP_RUN_ID,
      providerWorkStarted: true,
    });
  });

  it("reconnects after a dropped socket and resumes agent.wait without re-sending agent", async () => {
    gateway.wait = (n) => (n === 2 ? "drop" : n < 3 ? { status: "timeout" } : { status: "ok", summary: "done" });
    const { ctx } = createContext({ runBudgetMs: 20_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(gateway.connections).toBe(2);
    expect(gateway.agentRequests).toHaveLength(1);
    expect(gateway.waitRequests.every((request) => request.runId === "oc-run-1")).toBe(true);
  });

  it("reports observation_lost when the gateway stays gone past the run budget", async () => {
    gateway.wait = () => "drop";
    const { ctx } = createContext({ runBudgetMs: 4_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(gateway.agentRequests).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_observation_lost" });
    expect(result.errorMessage).toContain("oc-run-1");
    expect(dispatchOf(result)).toMatchObject({
      phase: "observation_lost",
      acceptedRunId: "oc-run-1",
      providerWorkStarted: true,
    });
  });

  it("caps observation reconnects at 12 with a 1s to 30s backoff", async () => {
    gateway.wait = () => "drop";
    const { ctx, logs } = createContext({ runBudgetMs: 3_600_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(result.errorCode).toBe("openclaw_gateway_observation_lost");
    expect(dispatchOf(result)).toMatchObject({ observationReconnects: 12 });
    expect(gateway.connections).toBe(13);
    expect(gateway.agentRequests).toHaveLength(1);
    const backoffs = logs
      .map((line) => line.match(/reconnect \d+\/12 in (\d+)ms/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    expect(backoffs).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, ...Array(7).fill(30_000)]);
  });

  it("observes the idempotency-key run id when the acceptance has no runId, and records it", async () => {
    gateway.accept = { status: "accepted" };
    gateway.wait = (n) => (n === 1 ? "drop" : { status: "ok" });
    const { ctx, events } = createContext({ runBudgetMs: 20_000, waitWindowMs: 200 });

    const result = await runExecute(ctx);

    expect(result.exitCode).toBe(0);
    expect(gateway.waitRequests.map((request) => request.runId)).toEqual([PAPERCLIP_RUN_ID, PAPERCLIP_RUN_ID]);
    expect(events[0]?.payload).toMatchObject({ runIdSource: "idempotency_key_fallback" });
    // Reattaching after the drop must not relabel the id as gateway-supplied.
    expect(dispatchOf(result)).toMatchObject({ runIdSource: "idempotency_key_fallback" });
  });

  it("reads a legacy waitTimeoutMs as the run budget with the default 60s wait window", async () => {
    const { ctx } = createContext({ waitTimeoutMs: 1_800_000 });

    const result = await runExecute(ctx);

    expect(result.exitCode).toBe(0);
    expect(gateway.agentRequests[0]?.timeout).toBe(1_800);
    expect(gateway.waitRequests[0]?.timeoutMs).toBe(60_000);
  });
});
