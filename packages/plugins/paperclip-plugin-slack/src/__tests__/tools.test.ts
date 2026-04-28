import { describe, it, expect, vi } from "vitest";
import { registerTools } from "../tools.js";

const SLACK_TOKEN = "xoxb-test";
const USER_TOKEN = "xoxp-test";

interface MockHandlerEntry {
  decl: any;
  fn: (params: unknown, runCtx?: unknown) => Promise<any>;
}

interface MockCtx {
  ctx: any;
  handlers: Map<string, MockHandlerEntry>;
  fetch: ReturnType<typeof vi.fn>;
}

const mkCtx = (
  config: { slackUserTokenRef?: string; [k: string]: unknown } = {},
): MockCtx => {
  const handlers = new Map<string, MockHandlerEntry>();
  const fetch = vi.fn();
  const ctx: any = {
    http: { fetch },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    secrets: {
      resolve: vi.fn(async (ref: string) => {
        if (ref === "bot-token-ref") return SLACK_TOKEN;
        if (ref === "user-token-ref") return USER_TOKEN;
        throw new Error(`unknown secret ref: ${ref}`);
      }),
    },
    metrics: { write: vi.fn(async () => {}) },
    tools: {
      register: (name: string, decl: any, fn: any) => {
        handlers.set(name, { decl, fn });
      },
    },
  };
  registerTools(ctx, {
    slackTokenRef: "bot-token-ref",
    slackUserTokenRef: config.slackUserTokenRef,
  });
  return { ctx, handlers, fetch };
};

const mockSlackResponse = (
  fetch: ReturnType<typeof vi.fn>,
  body: any,
  status = 200,
) => {
  fetch.mockResolvedValueOnce({
    status,
    headers: { get: () => null },
    json: async () => body,
  });
};

const callHandler = async (
  handlers: Map<string, MockHandlerEntry>,
  name: string,
  params: unknown,
) => {
  const entry = handlers.get(name);
  if (!entry) throw new Error(`handler ${name} not registered`);
  return entry.fn(params, {
    agentId: "a1",
    runId: "r1",
    companyId: "c1",
    projectId: "p1",
  });
};

describe("registerTools — slack_post_message", () => {
  it("posts to chat.postMessage and returns slimmed output on success", async () => {
    const { ctx, handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: true, ts: "1.2", channel: "C1" });
    const result = await callHandler(handlers, "slack_post_message", {
      channel: "C1",
      text: "hi",
    });
    expect(result.data).toEqual({ ts: "1.2", channel: "C1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${SLACK_TOKEN}`,
        }),
      }),
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.tool.slack_post_message.success",
      1,
    );
  });

  it("returns { error } and emits error metric when slack rejects", async () => {
    const { ctx, handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "channel_not_found" });
    const result = await callHandler(handlers, "slack_post_message", {
      channel: "X",
      text: "hi",
    });
    expect(result).toEqual({ error: "channel_not_found" });
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.tool.slack_post_message.error",
      1,
    );
  });
});

describe("registerTools — slack_update_message", () => {
  it("posts to chat.update and returns slimmed output", async () => {
    const { ctx, handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: true, ts: "1.2", channel: "C1" });
    const result = await callHandler(handlers, "slack_update_message", {
      channel: "C1",
      ts: "1.2",
      text: "edit",
    });
    expect(result.data).toEqual({ ts: "1.2", channel: "C1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({ method: "POST" }),
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith(
      "slack.tool.slack_update_message.success",
      1,
    );
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "message_not_found" });
    const result = await callHandler(handlers, "slack_update_message", {
      channel: "C1",
      ts: "1.2",
      text: "edit",
    });
    expect(result).toEqual({ error: "message_not_found" });
  });
});

describe("registerTools — slack_react", () => {
  it("posts to reactions.add and returns ok output on success", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: true });
    const result = await callHandler(handlers, "slack_react", {
      channel: "C1",
      timestamp: "1.2",
      name: "thumbsup",
    });
    expect(result.data).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "already_reacted" });
    const result = await callHandler(handlers, "slack_react", {
      channel: "C1",
      timestamp: "1.2",
      name: "thumbsup",
    });
    expect(result).toEqual({ error: "already_reacted" });
  });
});

describe("registerTools — slack_send_dm", () => {
  it("opens a conversation then posts the message and slims the output", async () => {
    const { handlers, fetch } = mkCtx();
    // First call: conversations.open
    mockSlackResponse(fetch, { ok: true, channel: { id: "D1" } });
    // Second call: chat.postMessage
    mockSlackResponse(fetch, { ok: true, ts: "1.2", channel: "D1" });
    const result = await callHandler(handlers, "slack_send_dm", {
      user: "U1",
      text: "hi",
    });
    expect(result.data).toEqual({ ts: "1.2", channel: "D1" });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/conversations.open",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns { error } when conversations.open fails", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "user_not_found" });
    const result = await callHandler(handlers, "slack_send_dm", {
      user: "Uunknown",
      text: "hi",
    });
    expect(result).toEqual({ error: "user_not_found" });
  });
});

describe("registerTools — slack_list_channels", () => {
  it("returns slimmed channels and next_cursor on success", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      channels: [
        {
          id: "C1",
          name: "general",
          is_private: false,
          is_archived: false,
          extra: "skip",
        },
        {
          id: "C2",
          name: "random",
          is_private: false,
          is_archived: true,
        },
      ],
      response_metadata: { next_cursor: "cur1" },
    });
    const result = await callHandler(handlers, "slack_list_channels", {});
    expect(result.data).toEqual({
      channels: [
        { id: "C1", name: "general", is_private: false, is_archived: false },
        { id: "C2", name: "random", is_private: false, is_archived: true },
      ],
      next_cursor: "cur1",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://slack.com/api/conversations.list"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("applies name_filter case-insensitive substring match", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false, is_archived: false },
        { id: "C2", name: "random", is_private: false, is_archived: false },
        { id: "C3", name: "DevOps", is_private: false, is_archived: false },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = (await callHandler(handlers, "slack_list_channels", {
      name_filter: "dev",
    })) as { data: { channels: Array<{ id: string }> } };
    expect(result.data.channels.map((c) => c.id)).toEqual(["C3"]);
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "invalid_auth" });
    const result = await callHandler(handlers, "slack_list_channels", {});
    expect(result).toEqual({ error: "invalid_auth" });
  });
});

describe("registerTools — slack_join_channel", () => {
  it("posts to conversations.join and slims to { channel: { id, name } }", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      channel: { id: "C1", name: "general", extra: "skip" },
    });
    const result = await callHandler(handlers, "slack_join_channel", {
      channel: "C1",
    });
    expect(result.data).toEqual({ channel: { id: "C1", name: "general" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.join",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "is_archived" });
    const result = await callHandler(handlers, "slack_join_channel", {
      channel: "C1",
    });
    expect(result).toEqual({ error: "is_archived" });
  });
});

describe("registerTools — slack_list_users", () => {
  it("filters out bots and deleted users and returns slimmed members", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      members: [
        {
          id: "U1",
          name: "alice",
          real_name: "Alice",
          profile: { email: "a@x.com" },
          is_bot: false,
          deleted: false,
        },
        {
          id: "U2",
          name: "bot1",
          real_name: "Bot",
          profile: { email: null },
          is_bot: true,
          deleted: false,
        },
        {
          id: "U3",
          name: "bob",
          real_name: "Bob",
          profile: { email: "b@x.com" },
          is_bot: false,
          deleted: true,
        },
      ],
      response_metadata: { next_cursor: "next" },
    });
    const result = await callHandler(handlers, "slack_list_users", {});
    expect(result.data).toEqual({
      members: [
        {
          id: "U1",
          name: "alice",
          real_name: "Alice",
          email: "a@x.com",
          is_bot: false,
          deleted: false,
        },
      ],
      next_cursor: "next",
    });
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "invalid_cursor" });
    const result = await callHandler(handlers, "slack_list_users", {});
    expect(result).toEqual({ error: "invalid_cursor" });
  });
});

describe("registerTools — slack_get_user_info", () => {
  it("looks up by user ID and returns slimmed fields", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      user: {
        id: "U1",
        name: "alice",
        real_name: "Alice",
        profile: { email: "a@x.com" },
        is_bot: false,
        deleted: false,
      },
    });
    const result = await callHandler(handlers, "slack_get_user_info", {
      user: "U1",
    });
    expect(result.data).toEqual({
      id: "U1",
      name: "alice",
      real_name: "Alice",
      email: "a@x.com",
      is_bot: false,
      deleted: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://slack.com/api/users.info"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("looks up by email when input contains '@'", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      user: {
        id: "U2",
        name: "bob",
        real_name: "Bob",
        profile: { email: "b@x.com" },
        is_bot: false,
        deleted: false,
      },
    });
    await callHandler(handlers, "slack_get_user_info", { user: "b@x.com" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://slack.com/api/users.lookupByEmail"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "user_not_found" });
    const result = await callHandler(handlers, "slack_get_user_info", {
      user: "Uxxx",
    });
    expect(result).toEqual({ error: "user_not_found" });
  });
});

describe("registerTools — slack_get_thread_replies", () => {
  it("calls conversations.replies and returns slimmed messages", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, {
      ok: true,
      messages: [
        {
          user: "U1",
          ts: "1.0",
          text: "parent",
          thread_ts: "1.0",
          extra: "skip",
        },
        { user: "U2", ts: "2.0", text: "reply", thread_ts: "1.0" },
      ],
      response_metadata: { next_cursor: "cur" },
    });
    const result = await callHandler(handlers, "slack_get_thread_replies", {
      channel: "C1",
      thread_ts: "1.0",
    });
    expect(result.data).toEqual({
      messages: [
        { user: "U1", ts: "1.0", text: "parent", thread_ts: "1.0" },
        { user: "U2", ts: "2.0", text: "reply", thread_ts: "1.0" },
      ],
      next_cursor: "cur",
    });
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "thread_not_found" });
    const result = await callHandler(handlers, "slack_get_thread_replies", {
      channel: "C1",
      thread_ts: "9.9",
    });
    expect(result).toEqual({ error: "thread_not_found" });
  });
});

describe("registerTools — slack_search_messages", () => {
  it("returns guidance error when slackUserTokenRef is unset, without calling fetch", async () => {
    const { handlers, fetch } = mkCtx();
    const result = (await callHandler(handlers, "slack_search_messages", {
      query: "hi",
    })) as { error: string };
    expect(result.error).toContain("user token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls search.messages with user token and returns slimmed matches", async () => {
    const { handlers, fetch } = mkCtx({ slackUserTokenRef: "user-token-ref" });
    mockSlackResponse(fetch, {
      ok: true,
      messages: {
        total: 2,
        matches: [
          {
            ts: "1.0",
            channel: { id: "C1" },
            text: "hello",
            user: "U1",
            permalink: "https://slack.example/p1",
            extra: "skip",
          },
          {
            ts: "2.0",
            channel: "C2",
            text: "hi",
            user: "U2",
            permalink: "https://slack.example/p2",
          },
        ],
      },
    });
    const result = await callHandler(handlers, "slack_search_messages", {
      query: "hi",
    });
    expect(result.data).toEqual({
      matches: [
        {
          ts: "1.0",
          channel: "C1",
          text: "hello",
          user: "U1",
          permalink: "https://slack.example/p1",
        },
        {
          ts: "2.0",
          channel: "C2",
          text: "hi",
          user: "U2",
          permalink: "https://slack.example/p2",
        },
      ],
      total: 2,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://slack.com/api/search.messages"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${USER_TOKEN}`,
        }),
      }),
    );
  });

  it("returns { error } on slack failure", async () => {
    const { handlers, fetch } = mkCtx({ slackUserTokenRef: "user-token-ref" });
    mockSlackResponse(fetch, { ok: false, error: "invalid_auth" });
    const result = await callHandler(handlers, "slack_search_messages", {
      query: "x",
    });
    expect(result).toEqual({ error: "invalid_auth" });
  });
});

describe("registerTools — slack_upload_file", () => {
  it("returns guidance error when neither content_base64 nor source_url is provided", async () => {
    const { handlers, fetch } = mkCtx();
    const result = (await callHandler(handlers, "slack_upload_file", {
      channel: "C1",
      filename: "x.txt",
    })) as { error: string };
    expect(result.error).toContain("content_base64");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads via base64 path: getUploadURLExternal -> PUT -> completeUploadExternal", async () => {
    const { handlers, fetch } = mkCtx();
    // 1. getUploadURLExternal
    mockSlackResponse(fetch, {
      ok: true,
      upload_url: "https://files.slack/upload",
      file_id: "F1",
    });
    // 2. PUT to upload_url (returns 200 ok body — Slack returns OK text)
    fetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      text: async () => "OK",
      json: async () => ({}),
    });
    // 3. filesCompleteUploadExternal
    mockSlackResponse(fetch, {
      ok: true,
      files: [{ id: "F1", name: "x.txt", permalink: "https://p" }],
    });
    const result = await callHandler(handlers, "slack_upload_file", {
      channel: "C1",
      filename: "x.txt",
      content_base64: Buffer.from("hello").toString("base64"),
      title: "Hello",
    });
    expect(result.data).toEqual({
      files: [{ id: "F1", name: "x.txt", permalink: "https://p" }],
    });
    // Verify three calls in order
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/files.getUploadURLExternal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://files.slack/upload",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://slack.com/api/files.completeUploadExternal",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns { error } when getUploadURLExternal fails", async () => {
    const { handlers, fetch } = mkCtx();
    mockSlackResponse(fetch, { ok: false, error: "invalid_auth" });
    const result = await callHandler(handlers, "slack_upload_file", {
      channel: "C1",
      filename: "x.txt",
      content_base64: Buffer.from("hello").toString("base64"),
    });
    expect(result).toEqual({ error: "invalid_auth" });
  });
});
