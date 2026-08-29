import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;

    constructor() {
      super();
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
      const responsePayload = request.method === "connect"
        ? { protocol: 3 }
        : { status: "ok", runId: "remote-run-1", summary: "done" };
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: responsePayload,
        }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

describe("openclaw_gateway execute dispatch boundary", () => {
  it("reports dispatch before opening the remote websocket", async () => {
    const onDispatch = vi.fn();
    const ctx: AdapterExecutionContext = {
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
        timeoutSec: 1,
      },
      context: {
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "interaction_resolved",
      },
      onLog: async () => {},
      onDispatch,
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});
