import type { AdapterExecutionContext, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayState = vi.hoisted(() => ({
  connectionAttempts: 0,
  sendTerminalAgentFrame: true,
  terminalFrameDelayMs: 0,
  immediateCompletion: false,
  agentWaitCalls: 0,
  agentMetaCostUsd: undefined as unknown,
  agentMetaUsage: {
    input: 25103,
    output: 2,
    cacheRead: 8832,
    total: 33937,
    cost: { total: 0 },
  } as Record<string, unknown>,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;

    constructor() {
      super();
      gatewayState.connectionAttempts += 1;
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
      const request = JSON.parse(payload) as { id: string; method: string };
      if (request.method === "connect") {
        queueMicrotask(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: { protocol: 4 },
          }));
        });
        return;
      }
      if (request.method === "agent") {
        if (gatewayState.immediateCompletion) {
          queueMicrotask(() => {
            this.emit("message", JSON.stringify({
              type: "res",
              id: request.id,
              ok: true,
              payload: {
                status: "ok",
                runId: "run-remote-1",
                summary: "done",
                result: {
                  meta: {
                    agentMeta: {
                      provider: "deepseek-official",
                      model: "deepseek-v4-flash",
                      usage: gatewayState.agentMetaUsage,
                      ...(gatewayState.agentMetaCostUsd === undefined
                        ? {}
                        : { costUsd: gatewayState.agentMetaCostUsd }),
                    },
                  },
                },
              },
            }));
          });
          return;
        }
        queueMicrotask(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: { status: "accepted", runId: "run-remote-1", sessionKey: "agent:1:paperclip:issue:1" },
          }));
        });
        if (gatewayState.sendTerminalAgentFrame) {
          setTimeout(() => {
            this.emit("message", JSON.stringify({
              type: "res",
              id: request.id,
              ok: true,
              payload: {
                status: "ok",
                runId: "run-remote-1",
                summary: "done",
                result: {
                  meta: {
                    agentMeta: {
                      provider: "deepseek-official",
                      model: "deepseek-v4-flash",
                      usage: gatewayState.agentMetaUsage,
                      ...(gatewayState.agentMetaCostUsd === undefined
                        ? {}
                        : { costUsd: gatewayState.agentMetaCostUsd }),
                    },
                  },
                },
              },
            }));
          }, gatewayState.terminalFrameDelayMs);
        }
        return;
      }
      if (request.method === "agent.wait") {
        gatewayState.agentWaitCalls += 1;
        queueMicrotask(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: {
              status: "ok",
              runId: "run-remote-1",
              startedAt: 1,
              endedAt: 2,
              stopReason: "stop",
            },
          }));
        });
        return;
      }
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: {},
        }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

function createContext(receipts: AdapterUsageCheckpoint[]): AdapterExecutionContext {
  return {
    runId: "run-1",
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
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "interaction_resolved",
    },
    onLog: async () => {},
    onUsage: async (receipt: AdapterUsageCheckpoint) => {
      receipts.push(receipt);
    },
  } as unknown as AdapterExecutionContext;
}

describe("openclaw_gateway usage accounting", () => {
  beforeEach(() => {
    gatewayState.connectionAttempts = 0;
    gatewayState.sendTerminalAgentFrame = true;
    gatewayState.terminalFrameDelayMs = 0;
    gatewayState.immediateCompletion = false;
    gatewayState.agentWaitCalls = 0;
    gatewayState.agentMetaCostUsd = undefined;
    gatewayState.agentMetaUsage = {
      input: 25103,
      output: 2,
      cacheRead: 8832,
      total: 33937,
      cost: { total: 0 },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the usage carried by the terminal agent frame", async () => {
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 25103,
      outputTokens: 2,
      cachedInputTokens: 8832,
    });
    expect(result.provider).toBe("deepseek-official");
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("reports a complete usage receipt through the accounting channel", async () => {
    const receipts: AdapterUsageCheckpoint[] = [];
    await execute(createContext(receipts));

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      usage: { inputTokens: 25103, outputTokens: 2, cachedInputTokens: 8832 },
      usageBasis: "per_run",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      complete: true,
    });
  });

  it("still reports usage when the terminal frame arrives after the agent.wait response", async () => {
    gatewayState.terminalFrameDelayMs = 25;
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 25103,
      outputTokens: 2,
      cachedInputTokens: 8832,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.complete).toBe(true);
  });

  it("does not report a usage receipt when the gateway reports no counters", async () => {
    gatewayState.agentMetaUsage = {};
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.usage).toBeUndefined();
    expect(receipts).toHaveLength(0);
  });

  it("completes without usage when the gateway never sends a terminal agent frame", async () => {
    gatewayState.sendTerminalAgentFrame = false;
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.usage).toBeUndefined();
    expect(receipts).toHaveLength(0);
  });

  it("reports the cost carried by the terminal usage counters", async () => {
    gatewayState.agentMetaUsage = {
      input: 25103,
      output: 2,
      cacheRead: 8832,
      total: 33937,
      cost: { total: 0.42 },
    };
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.42);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      costUsd: 0.42,
      costStatus: "reported",
      complete: true,
    });
  });

  it("keeps an explicitly reported zero cost instead of marking it unpriced", async () => {
    gatewayState.agentMetaCostUsd = 0;
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      costUsd: 0,
      costStatus: "reported",
      complete: true,
    });
  });

  it("reports usage when the gateway completes in a single agent response", async () => {
    gatewayState.immediateCompletion = true;
    const receipts: AdapterUsageCheckpoint[] = [];
    const result = await execute(createContext(receipts));

    expect(result.exitCode).toBe(0);
    expect(gatewayState.agentWaitCalls).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 25103,
      outputTokens: 2,
      cachedInputTokens: 8832,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      usage: { inputTokens: 25103, outputTokens: 2, cachedInputTokens: 8832 },
      complete: true,
    });
  });
});
