import { describe, expect, it, vi } from "vitest";
import type { Channel, ChannelMessage, ChannelMessageStatus } from "@paperclipai/shared";
import { createSender } from "../sender.js";
import type { ChannelMessageStore, PlatformAdapter } from "../types.js";

function makeChannel(): Channel {
  return {
    id: "ch_1",
    companyId: "co_1",
    platform: "webhook",
    name: "Webhook",
    config: { url: "https://example.com/hook" },
    status: "active",
    direction: "outbound",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function makeStore(): {
  store: ChannelMessageStore;
  rows: Map<string, ChannelMessage>;
} {
  const rows = new Map<string, ChannelMessage>();
  let id = 0;
  const store: ChannelMessageStore = {
    async create(input) {
      const row: ChannelMessage = {
        id: `msg_${++id}`,
        companyId: input.companyId,
        channelId: input.channelId,
        direction: "outbound",
        content: input.content,
        metadata: input.metadata,
        issueId: input.issueId ?? null,
        agentId: input.agentId ?? null,
        status: "pending",
        createdAt: "2026-06-02T00:00:00.000Z",
      };
      rows.set(row.id, row);
      return row;
    },
    async updateStatus(id, status: ChannelMessageStatus, metadata) {
      const existing = rows.get(id);
      if (!existing) throw new Error("missing");
      const next: ChannelMessage = { ...existing, status, metadata };
      rows.set(id, next);
      return next;
    },
  };
  return { store, rows };
}

describe("createSender", () => {
  it("delivers via the resolved adapter and updates status to delivered", async () => {
    const { store } = makeStore();
    const adapter: PlatformAdapter = {
      platform: "webhook",
      send: vi.fn().mockResolvedValue({ status: "delivered", metadata: { httpStatus: 200 } }),
    };
    const sender = createSender({
      store,
      resolveAdapter: (p) => (p === "webhook" ? adapter : null),
    });
    const result = await sender.send(makeChannel(), "hello", { metadata: { source: "test" } });
    expect(result.attempts).toBe(1);
    expect(result.message.status).toBe("delivered");
    expect(result.message.metadata).toMatchObject({ source: "test", httpStatus: 200 });
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("retries with backoff and ultimately marks failed after maxAttempts", async () => {
    const { store } = makeStore();
    const adapter: PlatformAdapter = {
      platform: "webhook",
      send: vi.fn().mockResolvedValue({ status: "failed", error: "boom" }),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sender = createSender({
      store,
      resolveAdapter: (p) => (p === "webhook" ? adapter : null),
    });
    const result = await sender.send(makeChannel(), "hello", {
      maxAttempts: 3,
      backoffBaseMs: 100,
      sleep,
    });
    expect(adapter.send).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(result.message.status).toBe("failed");
    expect(result.lastError).toBe("boom");
    // Exponential backoff: 100ms, 200ms between the 3 attempts.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(result.message.metadata).toMatchObject({ error: "boom", attempts: 3 });
  });

  it("retries until success and stops early when delivered", async () => {
    const { store } = makeStore();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", error: "transient" })
      .mockResolvedValueOnce({ status: "delivered", metadata: { ts: "1.0" } });
    const adapter: PlatformAdapter = { platform: "webhook", send };
    const sender = createSender({
      store,
      resolveAdapter: () => adapter,
    });
    const result = await sender.send(makeChannel(), "hello", {
      sleep: async () => undefined,
    });
    expect(result.attempts).toBe(2);
    expect(result.message.status).toBe("delivered");
    expect(result.message.metadata).toMatchObject({ ts: "1.0" });
  });

  it("marks failed without attempts when no adapter is found", async () => {
    const { store } = makeStore();
    const sender = createSender({ store, resolveAdapter: () => null });
    const result = await sender.send(makeChannel(), "hi");
    expect(result.attempts).toBe(0);
    expect(result.message.status).toBe("failed");
    expect(result.lastError).toMatch(/Unsupported platform/);
  });
});
