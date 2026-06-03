import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@paperclipai/shared";
import { createSlackAdapter, markdownToSlackMrkdwn } from "../platforms/slack.js";
import type { FetchLike } from "../types.js";

function makeChannel(config: Record<string, unknown>): Channel {
  return {
    id: "ch_slack",
    companyId: "co_1",
    platform: "slack",
    name: "#ops",
    config,
    status: "active",
    direction: "outbound",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

describe("markdownToSlackMrkdwn", () => {
  it("converts links", () => {
    expect(markdownToSlackMrkdwn("see [docs](https://x.dev)")).toBe(
      "see <https://x.dev|docs>",
    );
  });
  it("converts bold and headings", () => {
    expect(markdownToSlackMrkdwn("# Title\n**bold** text")).toBe("*Title*\n*bold* text");
  });
  it("converts list markers", () => {
    expect(markdownToSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
  });
});

describe("slack adapter", () => {
  it("POSTs to chat.postMessage with bot token + mrkdwn body", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ ok: true, channel: "C123", ts: "1717.0001", message: { ts: "1717.0001" } }),
    });
    const adapter = createSlackAdapter({ fetch: fetchMock, apiBaseUrl: "https://slack.test/api" });
    const result = await adapter.send(
      makeChannel({ botToken: "xoxb-1", channel: "C123" }),
      { content: "**hi** [docs](https://x.dev)" },
    );
    expect(result.status).toBe("delivered");
    expect(result.metadata).toMatchObject({ channel: "C123", ts: "1717.0001", thread_ts: "1717.0001" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.test/api/chat.postMessage");
    expect(init?.headers?.Authorization).toBe("Bearer xoxb-1");
    const body = JSON.parse(init?.body ?? "{}");
    expect(body).toMatchObject({
      channel: "C123",
      mrkdwn: true,
      text: "*hi* <https://x.dev|docs>",
    });
    expect(body.thread_ts).toBeUndefined();
  });

  it("threads when metadata.thread_ts is provided", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ ok: true, ts: "2.0", message: { ts: "2.0", thread_ts: "1.0" } }),
    });
    const adapter = createSlackAdapter({ fetch: fetchMock, apiBaseUrl: "https://slack.test/api" });
    const result = await adapter.send(
      makeChannel({ botToken: "xoxb-1", channel: "C123" }),
      { content: "reply", metadata: { thread_ts: "1.0" } },
    );
    expect(result.status).toBe("delivered");
    expect(result.metadata).toMatchObject({ thread_ts: "1.0" });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body ?? "{}");
    expect(body.thread_ts).toBe("1.0");
  });

  it("returns failed when Slack returns ok:false", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    const adapter = createSlackAdapter({ fetch: fetchMock, apiBaseUrl: "https://slack.test/api" });
    const result = await adapter.send(
      makeChannel({ botToken: "xoxb-1", channel: "Cxx" }),
      { content: "hi" },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("channel_not_found");
  });

  it("rejects when bot token is missing", async () => {
    const adapter = createSlackAdapter({ fetch: vi.fn() });
    const result = await adapter.send(makeChannel({ channel: "C123" }), { content: "hi" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/botToken/);
  });
});
