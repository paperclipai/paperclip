import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@paperclipai/shared";
import { createWebhookAdapter, signWebhookPayload } from "../platforms/webhook.js";
import type { FetchLike } from "../types.js";

function makeChannel(config: Record<string, unknown>): Channel {
  return {
    id: "ch_1",
    companyId: "co_1",
    platform: "webhook",
    name: "Ops Webhook",
    config,
    status: "active",
    direction: "outbound",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

describe("webhook adapter", () => {
  it("POSTs JSON payload and returns delivered on 2xx", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    });
    const adapter = createWebhookAdapter({ fetch: fetchMock });
    const result = await adapter.send(
      makeChannel({ url: "https://example.com/hook" }),
      { content: "hello" },
    );
    expect(result.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(init?.body ?? "{}");
    expect(payload).toMatchObject({
      channelId: "ch_1",
      channelName: "Ops Webhook",
      content: "hello",
    });
  });

  it("signs the body when signingSecret is configured", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    });
    const adapter = createWebhookAdapter({ fetch: fetchMock });
    const result = await adapter.send(
      makeChannel({ url: "https://example.com/hook", signingSecret: "shh" }),
      { content: "hi" },
    );
    expect(result.status).toBe("delivered");
    const init = fetchMock.mock.calls[0][1];
    const body = init?.body ?? "";
    expect(init?.headers?.["X-Paperclip-Signature"]).toBe(signWebhookPayload("shh", body));
  });

  it("returns failed with HTTP status on non-2xx", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    });
    const adapter = createWebhookAdapter({ fetch: fetchMock });
    const result = await adapter.send(
      makeChannel({ url: "https://example.com/hook" }),
      { content: "hi" },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 500");
    expect(result.metadata).toMatchObject({ httpStatus: 500 });
  });

  it("returns failed when config is missing url", async () => {
    const adapter = createWebhookAdapter({ fetch: vi.fn() });
    const result = await adapter.send(makeChannel({}), { content: "hi" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/url/);
  });
});
