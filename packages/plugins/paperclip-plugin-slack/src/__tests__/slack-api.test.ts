import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  conversationsJoin,
  conversationsList,
  conversationsOpen,
  conversationsReplies,
  filesCompleteUploadExternal,
  filesGetUploadURLExternal,
  postMessage,
  reactionsAdd,
  searchMessages,
  usersInfo,
  usersList,
  usersLookupByEmail,
} from "../slack-api.js";

const mkCtx = () => {
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, ts: "1.2", channel: "C1" }),
  });
  return {
    http: { fetch },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
};

describe("postMessage", () => {
  it("POSTs to chat.postMessage with bearer token and json body", async () => {
    const ctx = mkCtx();
    const result = await postMessage(ctx as any, "xoxb-test", "C1", {
      text: "hello",
    });
    expect(result.ok).toBe(true);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ channel: "C1", text: "hello", blocks: undefined }),
      }),
    );
  });

  it("returns the body unchanged and warns when ok is false", async () => {
    const ctx = mkCtx();
    ctx.http.fetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    const result = await postMessage(ctx as any, "xoxb-test", "C0", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Slack API error",
      expect.objectContaining({ error: "channel_not_found", channelId: "C0" }),
    );
  });

  it("demotes low-signal Slack errors (missing_scope) from warn to debug", async () => {
    const ctx = mkCtx();
    ctx.http.fetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: false, error: "missing_scope" }),
    });
    const result = await postMessage(ctx as any, "xoxb-test", "C0", { text: "hi" });
    expect(result).toEqual({ ok: false, error: "missing_scope" });
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    expect(ctx.logger.debug).toHaveBeenCalledTimes(1);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      "Slack API error",
      expect.objectContaining({ error: "missing_scope", channelId: "C0" }),
    );
  });

  it("retries on 429 honoring Retry-After then returns the success body", async () => {
    const ctx = mkCtx();
    ctx.http.fetch
      .mockResolvedValueOnce({
        status: 429,
        headers: { get: (h: string) => (h === "Retry-After" ? "0.001" : null) },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, ts: "1.2", channel: "C1" }),
      });
    const result = await postMessage(ctx as any, "xoxb-test", "C1", { text: "hi" });
    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, ts: "1.2", channel: "C1" });
  });
});


describe("reactionsAdd", () => {
  it("POSTs to reactions.add with channel, timestamp, name", async () => {
    const ctx = mkCtx();
    await reactionsAdd(ctx as any, "xoxb-t", "C1", "1.0", "thumbsup");
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-t",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ channel: "C1", timestamp: "1.0", name: "thumbsup" }),
      }),
    );
  });
});

describe("conversationsList", () => {
  it("GETs conversations.list with URL search params", async () => {
    const ctx = mkCtx();
    await conversationsList(ctx as any, "xoxb-t", {
      types: "public_channel",
      cursor: "abc",
      limit: 50,
      exclude_archived: true,
    });
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe(
      "https://slack.com/api/conversations.list?types=public_channel&cursor=abc&limit=50&exclude_archived=true",
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
      }),
    );
  });

  it("GETs conversations.list with no params", async () => {
    const ctx = mkCtx();
    await conversationsList(ctx as any, "xoxb-t");
    const [url] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/conversations.list");
  });
});

describe("conversationsReplies", () => {
  it("GETs conversations.replies with channel, ts, and optional cursor/limit", async () => {
    const ctx = mkCtx();
    await conversationsReplies(ctx as any, "xoxb-t", "C1", "1.0", {
      cursor: "x",
      limit: 5,
    });
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe(
      "https://slack.com/api/conversations.replies?channel=C1&ts=1.0&cursor=x&limit=5",
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
      }),
    );
  });
});

describe("conversationsJoin", () => {
  it("POSTs to conversations.join with channel", async () => {
    const ctx = mkCtx();
    await conversationsJoin(ctx as any, "xoxb-t", "C1");
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.join",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-t",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ channel: "C1" }),
      }),
    );
  });
});

describe("conversationsOpen", () => {
  it("POSTs to conversations.open with comma-separated users", async () => {
    const ctx = mkCtx();
    await conversationsOpen(ctx as any, "xoxb-t", "U1,U2");
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.open",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-t",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ users: "U1,U2" }),
      }),
    );
  });
});

describe("usersList", () => {
  it("GETs users.list with optional cursor and limit", async () => {
    const ctx = mkCtx();
    await usersList(ctx as any, "xoxb-t", { cursor: "c", limit: 100 });
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/users.list?cursor=c&limit=100");
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
      }),
    );
  });
});

describe("usersInfo", () => {
  it("GETs users.info with user param", async () => {
    const ctx = mkCtx();
    await usersInfo(ctx as any, "xoxb-t", "U1");
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/users.info?user=U1");
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
      }),
    );
  });
});

describe("usersLookupByEmail", () => {
  it("GETs users.lookupByEmail with email param", async () => {
    const ctx = mkCtx();
    await usersLookupByEmail(ctx as any, "xoxb-t", "a@b.com");
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/users.lookupByEmail?email=a%40b.com");
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxb-t" },
      }),
    );
  });
});

describe("searchMessages", () => {
  it("GETs search.messages with user token and query params", async () => {
    const ctx = mkCtx();
    await searchMessages(ctx as any, "xoxp-user", "hello world", {
      count: 10,
      sort: "timestamp",
    });
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe(
      "https://slack.com/api/search.messages?query=hello+world&count=10&sort=timestamp",
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xoxp-user" },
      }),
    );
  });
});

describe("filesGetUploadURLExternal", () => {
  it("POSTs form-encoded body with filename and length", async () => {
    const ctx = mkCtx();
    await filesGetUploadURLExternal(ctx as any, "xoxb-t", "report.pdf", 1234);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/files.getUploadURLExternal",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-t",
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: "filename=report.pdf&length=1234",
      }),
    );
  });
});

describe("filesCompleteUploadExternal", () => {
  it("POSTs files (json-stringified) and channels", async () => {
    const ctx = mkCtx();
    await filesCompleteUploadExternal(
      ctx as any,
      "xoxb-t",
      [{ id: "F1", title: "Report" }],
      "C1",
    );
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/files.completeUploadExternal",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-t",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          files: JSON.stringify([{ id: "F1", title: "Report" }]),
          channels: "C1",
        }),
      }),
    );
  });
});
