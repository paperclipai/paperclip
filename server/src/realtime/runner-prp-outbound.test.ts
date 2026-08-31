import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import {
  connectRunnerPrpIngress,
  WsJsonWireConnection,
} from "./runner-prp-outbound.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.alloc(0));
  });
}

describe("runner provider-ingress WebSocket wire", () => {
  it("delivers one terminal close to both PRP authority and reconnect ownership", () => {
    const socket = new FakeSocket();
    const wire = new WsJsonWireConnection(
      socket as unknown as WebSocket,
    );
    const authorityClose = vi.fn();
    const reconnectClose = vi.fn();
    wire.onClose(authorityClose);
    wire.onClose(reconnectClose);

    const error = new Error("preview disconnected");
    socket.emit("error", error);
    socket.emit("close", 1006, Buffer.from("duplicate close"));

    expect(authorityClose).toHaveBeenCalledOnce();
    expect(reconnectClose).toHaveBeenCalledOnce();
    expect(authorityClose).toHaveBeenCalledWith({
      message: "websocket_error",
      error,
    });
  });

  it("replays a close to a listener registered after the socket ended", () => {
    const socket = new FakeSocket();
    const wire = new WsJsonWireConnection(
      socket as unknown as WebSocket,
    );
    socket.emit("close", 1001, Buffer.from("sandbox restart"));
    const listener = vi.fn();
    wire.onClose(listener);
    expect(listener).toHaveBeenCalledWith({
      code: 1001,
      message: "sandbox restart",
    });
  });

  it("reports a terminal ingress failure to startup and active-run ownership", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "ws://preview.invalid/api/runner/v1/connect/run-1",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: async () => undefined,
    };
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(),
        activeRunnerConnectionCount: () => 0,
      } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 0,
      recoveryGraceMs: 0,
    });

    const [ready, failure] = await Promise.allSettled([
      handle.ready,
      handle.failure,
    ]);
    expect(ready).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "runner_ingress_unavailable" }),
    });
    expect(failure).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "runner_ingress_unavailable" }),
    });
    await handle.close();
  });

  it("keeps an unobserved active-run failure from becoming process-global", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "ws://preview.invalid/api/runner/v1/connect/run-unobserved",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: async () => undefined,
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const handle = connectRunnerPrpIngress({
        authority: {
          attachWireConnection: vi.fn(),
          activeRunnerConnectionCount: () => 0,
        } as unknown as DurablePrpControlPlane,
        endpoint,
        startupDeadlineMs: 0,
        recoveryGraceMs: 0,
      });
      await expect(handle.ready).rejects.toMatchObject({
        code: "runner_ingress_unavailable",
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await handle.close();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("does not report intentional close as an active-run ingress failure", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://127.0.0.1:9/api/runner/v1/connect/run-1",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: vi.fn(async () => undefined),
    };
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(),
        activeRunnerConnectionCount: () => 0,
      } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 60_000,
      recoveryGraceMs: 60_000,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    void handle.ready.catch(() => undefined);

    await handle.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(failureObserver).not.toHaveBeenCalled();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });
});
