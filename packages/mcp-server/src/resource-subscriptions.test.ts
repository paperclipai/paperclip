import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatRunSubscriptions, type HeartbeatRunSnapshot } from "./resource-subscriptions.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function createMockServer() {
  return {
    server: {
      sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer;
}

describe("heartbeat run resource subscriptions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits updates when status or log byte count changes", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const snapshots: HeartbeatRunSnapshot[] = [
      { status: "running", logBytes: 0 },
      { status: "running", logBytes: 5 },
      { status: "succeeded", logBytes: 5 },
      { status: "succeeded", logBytes: 9 },
    ];
    const server = createMockServer();
    const readSnapshot = vi.fn().mockImplementation(() => Promise.resolve(snapshots.shift() ?? snapshots[0]));
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.server.sendResourceUpdated).toHaveBeenCalledTimes(2);
    expect(server.server.sendResourceUpdated).toHaveBeenNthCalledWith(1, { uri });
    expect(server.server.sendResourceUpdated).toHaveBeenNthCalledWith(2, { uri });
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  });

  it("does not emit updates for metadata-only snapshot changes", async () => {
    vi.useFakeTimers();
    const server = createMockServer();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ status: "running", logBytes: 0, updatedAt: "2026-01-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ status: "running", logBytes: 0, updatedAt: "2026-01-01T00:00:01.000Z" });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe("paperclip://heartbeat-runs/run-1/log");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("treats duplicate subscriptions as idempotent", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ status: "running", logBytes: 0 })
      .mockResolvedValue({ status: "running", logBytes: 1 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe(uri);
    await subscriptions.subscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(server.server.sendResourceUpdated).toHaveBeenCalledTimes(1);
  });

  it("treats concurrent duplicate subscriptions as idempotent", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    let resolveInitialSnapshot: (snapshot: HeartbeatRunSnapshot) => void = () => {};
    const initialSnapshot = new Promise<HeartbeatRunSnapshot>((resolve) => {
      resolveInitialSnapshot = resolve;
    });
    const readSnapshot = vi.fn()
      .mockReturnValueOnce(initialSnapshot)
      .mockResolvedValue({ status: "running", logBytes: 1 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    const firstSubscribe = subscriptions.subscribe(uri);
    const secondSubscribe = subscriptions.subscribe(uri);
    resolveInitialSnapshot({ status: "running", logBytes: 0 });
    await Promise.all([firstSubscribe, secondSubscribe]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(server.server.sendResourceUpdated).toHaveBeenCalledTimes(1);
  });

  it("stops polling after unsubscribe", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    const readSnapshot = vi.fn().mockResolvedValue({ status: "running", logBytes: 0 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe(uri);
    subscriptions.unsubscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("handles duplicate unsubscribe calls safely", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    const readSnapshot = vi.fn().mockResolvedValue({ status: "running", logBytes: 0 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe(uri);
    subscriptions.unsubscribe(uri);
    subscriptions.unsubscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("unsubscribes immediately if initial snapshot has terminal status", async () => {
    vi.useFakeTimers();
    const server = createMockServer();
    const readSnapshot = vi.fn().mockResolvedValue({ status: "succeeded", logBytes: 10 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe("paperclip://heartbeat-runs/run-1/log");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("stops polling after close", async () => {
    vi.useFakeTimers();
    const server = createMockServer();
    const readSnapshot = vi.fn().mockResolvedValue({ status: "running", logBytes: 0 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe("paperclip://heartbeat-runs/run-1/log");
    subscriptions.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("removes a subscription after a polling API error", async () => {
    vi.useFakeTimers();
    const server = createMockServer();
    const onError = vi.fn();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ status: "running", logBytes: 0 })
      .mockRejectedValueOnce(new Error("api unavailable"))
      .mockResolvedValue({ status: "running", logBytes: 10 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot, onError });

    await subscriptions.subscribe("paperclip://heartbeat-runs/run-1/log");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { uri: "paperclip://heartbeat-runs/run-1/log" });
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("unsubscribes if sendResourceUpdated fails", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    const sendError = new Error("transport closed");
    vi.mocked(server.server.sendResourceUpdated).mockRejectedValueOnce(sendError);
    const onError = vi.fn();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ status: "running", logBytes: 0 })
      .mockResolvedValue({ status: "running", logBytes: 10 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot, onError });

    await subscriptions.subscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.server.sendResourceUpdated).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(sendError, { uri });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes when snapshot becomes unavailable during polling", async () => {
    vi.useFakeTimers();
    const uri = "paperclip://heartbeat-runs/run-1/log";
    const server = createMockServer();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ status: "running", logBytes: 0 })
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ status: "running", logBytes: 10 });
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await subscriptions.subscribe(uri);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("rejects unsupported resources before accepting a subscription", async () => {
    const server = createMockServer();
    const readSnapshot = vi.fn().mockResolvedValue(null);
    const subscriptions = createHeartbeatRunSubscriptions({ server, readSnapshot });

    await expect(subscriptions.subscribe("paperclip://other/run-1/log")).rejects.toThrow(
      "Unsupported heartbeat run resource URI",
    );

    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });
});
