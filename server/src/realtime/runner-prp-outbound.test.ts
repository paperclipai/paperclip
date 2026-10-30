import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import {
  __runnerPrpOutboundTesting,
  connectRunnerPrpIngress,
  WsJsonWireConnection,
} from "./runner-prp-outbound.js";

const sockets = vi.hoisted(() => ({ create: null as (() => unknown) | null }));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    default: Object.assign(vi.fn(function () { return sockets.create!(); }), {
      CONNECTING: actual.default.CONNECTING,
      OPEN: actual.default.OPEN,
      CLOSING: actual.default.CLOSING,
      CLOSED: actual.default.CLOSED,
    }),
  };
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  });
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.alloc(0));
  });
}

function openingSocket(socket = new FakeSocket()): FakeSocket {
  socket.readyState = WebSocket.CONNECTING;
  queueMicrotask(() => {
    if (socket.readyState !== WebSocket.CONNECTING) return;
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
  });
  return socket;
}

sockets.create = () => openingSocket();

describe("runner provider-ingress WebSocket wire", () => {
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

  it.each(["delayed_ack", "no_ack", "unconfirmed_termination", "error_before_close"] as const)("retires authenticated %s ingress within the native setup close budget", async (mode) => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    let activeConnections = 0;
    const closeFrameOwners: number[] = [];
    socket.close = vi.fn(() => {
      closeFrameOwners.push(activeConnections);
      socket.readyState = WebSocket.CLOSING;
      if (mode === "delayed_ack") {
        setTimeout(() => {
          socket.readyState = WebSocket.CLOSED;
          socket.emit("close", 1001, Buffer.alloc(0));
        }, 250);
      }
    });
    const finishClose = () => {
      socket.readyState = WebSocket.CLOSED;
      socket.emit("close", 1006, Buffer.alloc(0));
    };
    const terminate = vi.fn(() => {
      if (mode === "error_before_close") socket.emit("error", new Error("fixture termination pending"));
      else if (mode !== "unconfirmed_termination") finishClose();
    });
    Object.assign(socket, { terminate });
    const create = sockets.create;
    sockets.create = () => openingSocket(socket);
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-authenticated",
      secretHeaders: [{ name: "Authorization", value: "fixture-only" }],
      generation: "generation-authenticated",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { expect(activeConnections).toBe(0); }),
    };
    const attachWireConnection = vi.fn((wire: WsJsonWireConnection) => {
      expect(activeConnections).toBe(0);
      activeConnections += 1;
      wire.onClose(() => { activeConnections -= 1; });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 60_000,
      recoveryGraceMs: 60_000,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    let closing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      expect(activeConnections).toBe(1);
      closing = handle.close();
      expect(closeFrameOwners).toEqual([1]);
      if (socket.readyState !== WebSocket.CLOSED) {
        expect(activeConnections).toBe(mode === "error_before_close" ? 0 : 1);
        expect(endpoint.close).not.toHaveBeenCalled();
      }
      const outcome = Promise.race([
        closing.then(() => "closed"),
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve("setup_cleanup_deadline"), 10_000); }),
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(terminate).toHaveBeenCalledOnce();
      expect({ outcome: await outcome, activeConnections, endpointReleased: endpoint.close.mock.calls.length }).toEqual(["unconfirmed_termination", "error_before_close"].includes(mode)
        ? { outcome: "setup_cleanup_deadline", activeConnections: mode === "error_before_close" ? 0 : 1, endpointReleased: 0 }
        : { outcome: "closed", activeConnections: 0, endpointReleased: 1 });
      expect(attachWireConnection).toHaveBeenCalledOnce();
      expect(endpoint.refresh).not.toHaveBeenCalled();
      expect(failureObserver).not.toHaveBeenCalled();
      if (["unconfirmed_termination", "error_before_close"].includes(mode)) return;
      sockets.create = () => openingSocket();
      const successor = connectRunnerPrpIngress({
        authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
        endpoint,
      });
      await vi.advanceTimersByTimeAsync(0);
      await successor.ready;
      expect(activeConnections).toBe(1);
      await successor.close();
      expect(activeConnections).toBe(0);
      expect(attachWireConnection).toHaveBeenCalledTimes(2);
    } finally {
      if (deadline) clearTimeout(deadline);
      finishClose();
      await (closing ?? handle.close());
      sockets.create = create;
      vi.useRealTimers();
    }
  });

  it("retains an errored prior socket until physical close during reconnect shutdown", async () => {
    const prior = new FakeSocket();
    prior.close = vi.fn(() => { prior.readyState = WebSocket.CLOSING; });
    const pending = new FakeSocket();
    const create = sockets.create;
    let activeConnections = 0;
    let opens = 0;
    sockets.create = () => {
      opens += 1;
      if (opens === 1) return openingSocket(prior);
      pending.readyState = WebSocket.CONNECTING;
      return pending;
    };
    const endpointCloseStates: number[][] = [];
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-reconnecting",
      secretHeaders: [],
      generation: "generation-reconnecting",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { endpointCloseStates.push([prior.readyState, pending.readyState]); }),
    };
    const attachWireConnection = vi.fn((wire: WsJsonWireConnection) => {
      activeConnections += 1;
      wire.onClose(() => { activeConnections -= 1; });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
      endpoint,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    let closing: Promise<void> | undefined;
    try {
      await handle.ready;
      prior.readyState = WebSocket.CLOSING;
      prior.emit("error", new Error("fixture prior socket error"));
      await new Promise(resolve => setImmediate(resolve));
      expect(opens).toBe(2);
      expect(activeConnections).toBe(0);
      expect(prior.readyState).toBe(WebSocket.CLOSING);
      closing = handle.close();
      await closing;
      expect({ priorTerminations: prior.terminate.mock.calls.length, endpointCloseStates: endpointCloseStates.map(states => [...states]) }).toEqual({
        priorTerminations: 1, endpointCloseStates: [[WebSocket.CLOSED, WebSocket.CLOSED]],
      });
      expect(attachWireConnection).toHaveBeenCalledOnce();
      expect(failureObserver).not.toHaveBeenCalled();
      expect(endpoint.refresh).not.toHaveBeenCalled();
    } finally {
      prior.terminate();
      pending.terminate();
      await (closing ?? handle.close());
      sockets.create = create;
    }
  });

  it("joins a just-opened socket without attaching authority after intentional close", async () => {
    const socket = new FakeSocket();
    const create = sockets.create;
    let closing: Promise<void> | undefined;
    sockets.create = () => {
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        socket.readyState = WebSocket.OPEN;
        socket.emit("open");
        closing = handle.close();
      });
      return socket;
    };
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-opening",
      secretHeaders: [],
      generation: "generation-opening",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { expect(socket.readyState).toBe(WebSocket.CLOSED); }),
    };
    const attachWireConnection = vi.fn(() => ({ isAuthenticated: () => true }));
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => 0 } as unknown as DurablePrpControlPlane,
      endpoint,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    try {
      await expect(handle.ready).rejects.toThrow("closed before it became ready");
      await closing;
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(1001);
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(attachWireConnection).not.toHaveBeenCalled();
      expect(endpoint.close).toHaveBeenCalledOnce();
      expect(endpoint.refresh).not.toHaveBeenCalled();
      expect(failureObserver).not.toHaveBeenCalled();
    } finally {
      await (closing ?? handle.close());
      sockets.create = create;
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
