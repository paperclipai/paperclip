import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import {
  __runnerPrpOutboundTesting,
  connectRunnerPrpIngress,
  WsJsonWireConnection,
} from "./runner-prp-outbound.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  bufferedAmount = 0;
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.alloc(0));
  });
}

describe("runner provider-ingress WebSocket wire", () => {
  it("drains a real WebSocket burst in order after a paused durable consumer resumes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("missing test port");
    const accepted = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const wire = new WsJsonWireConnection(client);
    const [peer] = await accepted as [WebSocket];
    const delivered: number[] = [];
    wire.onJson(value => { delivered.push((value as { ordinal: number }).ordinal); if (delivered.length === 1) wire.pauseRead(); });
    try {
      for (let ordinal = 0; ordinal < 80; ordinal++) peer.send(JSON.stringify({ ordinal, text: "x".repeat(512) }));
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(client.readyState).toBe(WebSocket.OPEN);
      wire.resumeRead();
      await vi.waitFor(() => expect(delivered).toHaveLength(80));
      expect(delivered).toEqual(Array.from({ length: 80 }, (_, index) => index));
      expect(client.readyState).toBe(WebSocket.OPEN);
    } finally {
      const closed = once(client, "close"); client.terminate(); peer.terminate(); await closed;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("bounds frames before listener attachment and honors pause during buffered delivery", () => {
    const socket = new FakeSocket(), wire = new WsJsonWireConnection(socket as unknown as WebSocket);
    socket.emit("message", Buffer.from('{"ordinal":1}'), false);
    socket.emit("message", Buffer.from('{"ordinal":2}'), false);
    const delivered: unknown[] = [];
    wire.onJson(value => { delivered.push(value); if (delivered.length === 1) wire.pauseRead(); });
    expect(delivered).toEqual([{ ordinal: 1 }]);
    wire.resumeRead();
    expect(delivered).toEqual([{ ordinal: 1 }, { ordinal: 2 }]);
    expect(socket.pause).toHaveBeenCalled(); expect(socket.resume).toHaveBeenCalled();
    wire.pauseRead();
    for (let index = 0; index < 1000; index++) socket.emit("message", Buffer.from('{"small":true}'), false);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1013);
    wire.resumeRead();
    expect(delivered).toHaveLength(2);
  });

  it("bounds buffered bytes and unconsumed outgoing acknowledgements", () => {
    const socket = new FakeSocket(), wire = new WsJsonWireConnection(socket as unknown as WebSocket);
    const large = Buffer.from(JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) }));
    socket.emit("message", large, false); socket.emit("message", large, false);
    expect(socket.close).toHaveBeenCalledWith(1013);
    const stalled = new FakeSocket(), output = new WsJsonWireConnection(stalled as unknown as WebSocket);
    stalled.bufferedAmount = 4 * 1024 * 1024;
    output.sendJson({ kind: "ack" });
    expect(stalled.close).toHaveBeenCalledWith(1013); expect(stalled.send).not.toHaveBeenCalled();
  });

  it("bounds credential refresh by the fixed deadline and cancellation", async () => {
    const signal = new AbortController().signal;
    await expect(
      __runnerPrpOutboundTesting.awaitWithinDeadline({
        operation: async () => await new Promise<never>(() => undefined),
        deadline: Date.now() - 1,
        signal,
      }),
    ).rejects.toThrow("deadline elapsed");

    const abort = new AbortController();
    const pending = __runnerPrpOutboundTesting.awaitWithinDeadline({
      operation: async () => await new Promise<never>(() => undefined),
      deadline: Date.now() + 60_000,
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

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
