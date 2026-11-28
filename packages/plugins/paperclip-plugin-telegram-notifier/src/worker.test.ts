import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, PluginAccessMember } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_KIND, JOB_KEYS, STATE_KEY, TOOL_NAMES } from "./constants.js";
import manifest from "./manifest.js";
import { readPairing, saveMessageContext, setApprovalConfig, setPairedChat } from "./pairing.js";
import { pair, REF_A, REF_B, seedCompany, setup, state, TOKEN_A } from "./test-helpers.js";
import type { PairingState, TelegramUpdate } from "./types.js";
import { applyConfigPatch, saveThenRefresh } from "./ui/index.js";
import {
  collectDigestIssues,
  postTelegramReplyComment,
  resolveUpdateConfig,
} from "./worker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("poll job with company-scoped config", () => {
  it("reads each paired company's config by id and polls its bot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, configReads, calls } = await setup({
      "company-a": { botToken: REF_A },
    });
    await pair(harness, "company-a", "100");

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect(configReads).not.toContain(undefined);
    expect(configReads).toContain("company-a");
    expect(calls.some((c) => c.botId === "111111" && c.method === "getUpdates")).toBe(true);
  });

  it("polls each distinct bot once and skips companies without readable config", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls } = await setup({
      "company-a": { botToken: REF_A },
      "company-b": { botToken: REF_B },
      "company-c": { botToken: REF_A },
    });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");
    await pair(harness, "company-c", "300");
    await pair(harness, "company-unconfigured", "400");

    await harness.runJob(JOB_KEYS.pollUpdates);

    const polls = calls.filter((c) => c.method === "getUpdates").map((c) => c.botId);
    expect(polls.sort()).toEqual(["111111", "222222"]);
  });

  it("keeps a separate update cursor per bot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, pendingUpdates } = await setup({
      "company-a": { botToken: REF_A },
    });
    await pair(harness, "company-a", "100");
    pendingUpdates.set("111111", [
      { update_id: 7, message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "/help" } },
    ]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect(state(harness).bots?.["111111"]?.lastUpdateId).toBe(7);
  });
});

describe("resolveUpdateConfig", () => {
  const update = (chatId: number): TelegramUpdate => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: chatId, type: "private" }, date: 0, text: "/inbox" },
  });
  const groupA = () => ({
    botId: "111111",
    companyIds: ["company-a"],
    stored: new Map([["company-a", { botToken: REF_A, silent: true }]]),
  });
  const configs = {
    "company-a": { botToken: REF_A, silent: true },
    "company-b": { botToken: REF_B },
  };
  const pairedState: PairingState = {
    pairedByCompany: {
      "company-a": { chatId: "100", chatLabel: "a", pairedAt: "" },
      "company-b": { chatId: "200", chatLabel: "b", pairedAt: "" },
    },
  };

  it("uses the config of the company the chat is paired to", async () => {
    const { harness } = await setup(configs);
    expect(
      await resolveUpdateConfig(harness.ctx, pairedState, update(100), groupA(), new Map()),
    ).toEqual({
      botToken: TOKEN_A,
      silent: true,
    });
  });

  it("ignores a chat paired to a company that uses another bot", async () => {
    const { harness } = await setup(configs);
    expect(
      await resolveUpdateConfig(harness.ctx, pairedState, update(200), groupA(), new Map()),
    ).toBeUndefined();
  });

  it("loads a company that started pairing on this bot after the poll began", async () => {
    const { harness } = await setup({ ...configs, "company-c": { botToken: REF_A } });
    const batch = new Map();
    const handshakeState: PairingState = {
      ...pairedState,
      pairing: {
        stage: "awaiting_chat",
        targetCompanyId: "company-c",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };

    const config = await resolveUpdateConfig(harness.ctx, handshakeState, update(300), groupA(), batch);

    expect(config?.botToken).toBe(TOKEN_A);
    expect(batch.has("company-c")).toBe(true);
  });
});

describe("agent tools are bound to the calling agent's company", () => {
  it("refuses to unpair another company", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");

    const result = await harness.executeTool<{ error?: string }>(
      TOOL_NAMES.unpair,
      { companyId: "company-b" },
      { companyId: "company-a" },
    );

    expect(result.error).toMatch(/own company/);
    expect(state(harness).pairedByCompany?.["company-b"]).toBeDefined();
  });

  it("unpairs only the caller's company when no companyId is passed", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");

    await harness.executeTool(TOOL_NAMES.unpair, {}, { companyId: "company-a" });

    expect(state(harness).pairedByCompany?.["company-a"]).toBeUndefined();
    expect(state(harness).pairedByCompany?.["company-b"]).toBeDefined();
  });

  it("returns only the caller's pairing from get_status", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");

    const result = await harness.executeTool<{ data: { paired: { companyId: string } | null } }>(
      TOOL_NAMES.getStatus,
      {},
      { companyId: "company-a" },
    );

    expect(result.data.paired?.companyId).toBe("company-a");
    expect(JSON.stringify(result)).not.toContain("company-b");
    expect(JSON.stringify(result)).not.toContain("chatId");
  });

  it("does not let another company confirm or cancel a live handshake", async () => {
    const { harness } = await setup({
      "company-a": { botToken: REF_A },
      "company-b": { botToken: REF_A },
    });
    seedCompany(harness, "company-a");
    await harness.executeTool(TOOL_NAMES.startPairing, {}, { companyId: "company-a" });

    const start = await harness.executeTool<{ error?: string }>(
      TOOL_NAMES.startPairing,
      {},
      { companyId: "company-b" },
    );
    const confirm = await harness.executeTool<{ error?: string }>(
      TOOL_NAMES.confirmPairing,
      { code: "ABCDEF" },
      { companyId: "company-b" },
    );

    expect(start.error).toMatch(/Another company is pairing/);
    expect(confirm.error).toMatch(/No active pairing handshake/);
    expect(state(harness).pairing?.targetCompanyId).toBe("company-a");
  });
});

describe("settings page bridge", () => {
  it("lists only the company the host scoped the request to", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    seedCompany(harness, "company-a");
    seedCompany(harness, "company-b");

    const data = await harness.getData<{ items: Array<{ id: string }> }>("companies", {
      companyId: "company-a",
    });

    expect(data.items.map((c) => c.id)).toEqual(["company-a"]);
  });

  it("serializes concurrent pairing-state writes so none is lost", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");

    await Promise.all([
      harness.performAction(
        "setOperateAsForCompany",
        { agentId: "agent-1", agentLabel: "CEO" },
        { companyId: "company-a" },
      ),
      harness.performAction(
        "setApprovalConfig",
        { config: { enabled: true, approverAgentId: null, agents: {} } },
        { companyId: "company-a" },
      ),
      setApprovalConfig(harness.ctx, "company-b", {
        enabled: false,
        approverAgentId: null,
        agents: {},
      }),
    ]);

    const saved = await readPairing(harness.ctx);
    expect(saved.pairedByCompany?.["company-a"]?.operateAsAgentId).toBe("agent-1");
    expect(saved.approvalByCompany?.["company-a"]?.enabled).toBe(true);
    expect(saved.approvalByCompany?.["company-b"]).toBeDefined();
  });

  it("refreshes the cached bot username when the token changes", async () => {
    const configs: Record<string, Record<string, unknown>> = {
      "company-a": { botToken: REF_A },
    };
    const { harness } = await setup(configs);

    await harness.performAction("startPairing", {}, { companyId: "company-a" });
    const first = await harness.getData<{ botUsername?: string }>("status", {
      companyId: "company-a",
    });
    configs["company-a"] = { botToken: REF_B };
    await harness.performAction("startPairing", {}, { companyId: "company-a" });
    const second = await harness.getData<{ botUsername?: string }>("status", {
      companyId: "company-a",
    });

    expect(first.botUsername).toBe("bot111111");
    expect(second.botUsername).toBe("bot222222");
  });

  it("records the confirming Paperclip user on the paired chat", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEY },
      {
        pairing: {
          stage: "code_sent",
          targetCompanyId: "company-a",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          candidateChatId: "100",
          candidateLabel: "chat 100",
          candidateUserId: 42,
          code: "K7MN3X",
        },
      } satisfies PairingState,
    );

    await harness.performAction(
      "confirmPairing",
      { code: "K7MN3X" },
      { companyId: "company-a", actor: { type: "user", userId: "user-1" } },
    );

    expect(state(harness).pairedByCompany?.["company-a"]?.pairedByUserId).toBe("user-1");
  });
});

describe("Telegram replies", () => {
  async function replySetup() {
    // Reading comments back is a test-only capability.
    const { harness } = await setup({ "company-a": { botToken: REF_A } }, [
      "issue.comments.read",
    ]);
    harness.seed({
      issues: [{ id: "issue-1", companyId: "company-a", title: "T" } as unknown as Issue],
      accessMembers: [
        {
          companyId: "company-a",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
        } as unknown as PluginAccessMember,
      ],
    });
    return harness;
  }
  const chat = {
    chatId: "100",
    chatLabel: "chat",
    pairedAt: "",
    pairedByTelegramUserId: 42,
    pairedByUserId: "user-1",
    operateAsAgentId: "agent-1",
  };
  const message = (fromId: number) => ({
    message_id: 5,
    from: { id: fromId },
    chat: { id: 100, type: "private" as const },
    date: 0,
    text: "ship it",
  });

  it("posts the pairing operator's reply as the Paperclip user so the assignee wakes", async () => {
    const harness = await replySetup();
    const author = await postTelegramReplyComment(
      harness.ctx,
      chat,
      message(42),
      { companyId: "company-a", issueId: "issue-1" },
      "ship it",
    );
    const [comment] = await harness.ctx.issues.listComments("issue-1", "company-a");
    expect(author).toBe("user");
    expect(comment?.authorUserId).toBe("user-1");
    expect(comment?.authorAgentId).toBeNull();
  });

  it("attributes an allowed non-operator sender to the operate-as agent", async () => {
    const harness = await replySetup();
    const author = await postTelegramReplyComment(
      harness.ctx,
      chat,
      message(99),
      { companyId: "company-a", issueId: "issue-1" },
      "ship it",
    );
    const [comment] = await harness.ctx.issues.listComments("issue-1", "company-a");
    expect(author).toBe("agent");
    expect(comment?.authorAgentId).toBe("agent-1");
  });

  it("posts only the operator's reply in a paired group and ignores other members", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, pendingUpdates } = await setup(
      { "company-a": { botToken: REF_A } },
      ["issue.comments.read"],
    );
    harness.seed({
      issues: [{ id: "issue-1", companyId: "company-a", title: "T" } as unknown as Issue],
      accessMembers: [
        {
          companyId: "company-a",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
        } as unknown as PluginAccessMember,
      ],
    });
    await setPairedChat(harness.ctx, "company-a", { ...chat, chatId: "-500" });
    await saveMessageContext(harness.ctx, "-500", 9, {
      kind: "comment_thread",
      companyId: "company-a",
      issueId: "issue-1",
      identifier: "ALP-1",
      createdAt: new Date().toISOString(),
    });
    const groupReply = (updateId: number, fromId: number, text: string) =>
      ({
        update_id: updateId,
        message: {
          message_id: 10 + updateId,
          from: { id: fromId },
          chat: { id: -500, type: "group" },
          date: 0,
          text,
          reply_to_message: { message_id: 9 },
        },
      }) as unknown as TelegramUpdate;
    pendingUpdates.set("111111", [groupReply(1, 99, "from a member"), groupReply(2, 42, "from the operator")]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    const comments = await harness.ctx.issues.listComments("issue-1", "company-a");
    expect(comments.map((c) => c.body)).toEqual(["from the operator"]);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});

describe("writes from a paired group", () => {
  async function groupSetup() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, pendingUpdates } = await setup({ "company-a": { botToken: REF_A } });
    seedCompany(harness, "company-a");
    harness.seed({
      agents: [
        { id: "agent-1", companyId: "company-a", name: "Builder" } as unknown as Agent,
        { id: "agent-2", companyId: "company-a", name: "Reviewer" } as unknown as Agent,
      ],
      issues: [
        {
          id: "issue-1",
          companyId: "company-a",
          identifier: "ALP-1",
          title: "T",
          status: "todo",
          assigneeAgentId: "agent-1",
        } as unknown as Issue,
      ],
    });
    await setPairedChat(harness.ctx, "company-a", {
      chatId: "-500",
      chatLabel: "Team",
      pairedAt: "",
      pairedByTelegramUserId: 42,
      operateAsAgentId: "agent-1",
    });
    const sentTexts = () =>
      calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
    return { harness, calls, pendingUpdates, sentTexts };
  }
  const command = (updateId: number, fromId: number, text: string): TelegramUpdate => ({
    update_id: updateId,
    message: { message_id: updateId, from: { id: fromId }, chat: { id: -500, type: "group" }, date: 0, text },
  });
  const tap = (updateId: number, fromId: number, data: string) =>
    ({
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        from: { id: fromId },
        message: { message_id: 7, chat: { id: -500, type: "group" }, date: 0 },
        data,
      },
    }) as unknown as TelegramUpdate;

  it("lets only the operator /new, while any member can /inbox", async () => {
    const { harness, pendingUpdates, sentTexts } = await groupSetup();
    pendingUpdates.set("111111", [
      command(1, 99, "/new Member task"),
      command(2, 99, "/inbox"),
      command(3, 42, "/new Operator task"),
    ]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    const titles = (await harness.ctx.issues.list({ companyId: "company-a" })).map((i) => i.title);
    expect(titles).toContain("Operator task");
    expect(titles).not.toContain("Member task");
    expect(sentTexts().filter((t) => t.includes("Only the paired operator"))).toHaveLength(1);
    expect(sentTexts().some((t) => t.includes("Your inbox"))).toBe(true);
  });

  it("shows the full comment unchanged apart from Markdown escaping", async () => {
    const { harness, pendingUpdates, sentTexts } = await groupSetup();
    await saveMessageContext(harness.ctx, "-500", 7, {
      kind: "comment_thread",
      companyId: "company-a",
      issueId: "issue-1",
      identifier: "ALP-1",
      fullBody: "See /bots/handler.ts and /bot123/readme",
      createdAt: new Date().toISOString(),
    });
    pendingUpdates.set("111111", [tap(1, 42, CALLBACK_KIND.showFullComment)]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect(sentTexts()).toEqual([
      "*📄 Full comment on ALP\\-1*\n\nSee /bots/handler\\.ts and /bot123/readme",
    ]);
  });

  it("lets only the operator reassign from the picker", async () => {
    const { harness, calls, pendingUpdates } = await groupSetup();
    await saveMessageContext(harness.ctx, "-500", 7, {
      kind: "assign_picker",
      companyId: "company-a",
      issueId: "issue-1",
      identifier: "ALP-1",
      agents: [{ id: "agent-2", name: "Reviewer" }],
      createdAt: new Date().toISOString(),
    });
    pendingUpdates.set("111111", [tap(1, 99, "ras"), tap(2, 99, "asg:0")]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect((await harness.ctx.issues.get("issue-1", "company-a"))?.assigneeAgentId).toBe("agent-1");
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(false);
    const answers = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(answers).toEqual([
      "Only the paired operator can do this.",
      "Only the paired operator can do this.",
    ]);

    pendingUpdates.set("111111", [tap(3, 42, "asg:0")]);
    await harness.runJob(JOB_KEYS.pollUpdates);

    expect((await harness.ctx.issues.get("issue-1", "company-a"))?.assigneeAgentId).toBe("agent-2");
  });
});

describe("group pairing", () => {
  const groupMessage = (fromId: number): TelegramUpdate => ({
    update_id: 1,
    message: {
      message_id: 3,
      from: { id: fromId, first_name: "Ann" },
      chat: { id: -500, type: "group", title: "Team" },
      date: 0,
      text: "/start",
    },
  });

  async function startGroupPairing(privateChatReachable: boolean) {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, pendingUpdates } = await setup({ "company-a": { botToken: REF_A } });
    const fetch = harness.ctx.http.fetch;
    harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (!privateChatReachable && body.chat_id === "42") {
        return new Response(
          JSON.stringify({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" }),
          { status: 403 },
        );
      }
      return fetch(url, init);
    };
    await harness.performAction("startPairing", {}, { companyId: "company-a" });
    pendingUpdates.set("111111", [groupMessage(42)]);
    await harness.runJob(JOB_KEYS.pollUpdates);
    const pairing = state(harness).pairing;
    if (pairing?.stage !== "code_sent") throw new Error("expected code_sent");
    const sentTo = (chatId: string) =>
      calls
        .filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId)
        .map((c) => String(c.body.text))
        .join("\n");
    await harness.performAction(
      "confirmPairing",
      { code: pairing.code },
      { companyId: "company-a", actor: { type: "user", userId: "user-1" } },
    );
    return { pairing, sentTo, paired: state(harness).pairedByCompany?.["company-a"] };
  }

  it("sends the code to the sender's private chat and makes that sender the operator", async () => {
    const { pairing, sentTo, paired } = await startGroupPairing(true);

    expect(sentTo("42")).toContain(pairing.code);
    expect(sentTo("-500")).not.toContain(pairing.code);
    expect(paired?.chatId).toBe("-500");
    expect(paired?.pairedByTelegramUserId).toBe(42);
  });

  it("pairs the group with no operator when the sender cannot be reached privately", async () => {
    const { pairing, sentTo, paired } = await startGroupPairing(false);

    expect(sentTo("-500")).toContain(pairing.code);
    expect(paired?.chatId).toBe("-500");
    expect(paired?.pairedByTelegramUserId).toBeUndefined();
  });
});

describe("notifications", () => {
  it("links failed runs to the agent from the payload, not the run id", async () => {
    const { harness, calls } = await setup({
      "company-a": { botToken: REF_A, paperclipBaseUrl: "https://paperclip.example" },
    });
    harness.seed({
      agents: [{ id: "agent-1", companyId: "company-a", name: "Builder" } as unknown as Agent],
    });
    await pair(harness, "company-a", "100");

    await harness.emit(
      "agent.run.failed",
      { runId: "run-9", agentId: "agent-1", error: "boom" },
      { companyId: "company-a", entityId: "run-9", entityType: "heartbeat_run" },
    );

    const sent = calls.find((c) => c.method === "sendMessage");
    const markup = JSON.stringify(sent?.body);
    expect(markup).toContain("/agents/agent-1");
    expect(markup).not.toContain("/agents/run-9");
    expect(String(sent?.body.text)).toContain("Builder");
  });
});

describe("comment notifications", () => {
  async function commentSetup() {
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    harness.seed({
      issues: [
        { id: "issue-1", companyId: "company-a", identifier: "ALP-1", title: "Smoke test" } as unknown as Issue,
      ],
      agents: [{ id: "agent-1", companyId: "company-a", name: "Builder" } as unknown as Agent],
      accessMembers: [
        {
          companyId: "company-a",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
        } as unknown as PluginAccessMember,
      ],
    });
    await setPairedChat(harness.ctx, "company-a", {
      chatId: "100",
      chatLabel: "chat",
      pairedAt: "",
      pairedByTelegramUserId: 42,
      pairedByUserId: "user-1",
    });
    return { harness, calls };
  }

  async function emitComment(
    harness: TestHarness,
    commentId: string,
    actor: { actorType: "user" | "agent"; actorId: string },
  ) {
    await harness.emit(
      "issue.comment.created",
      { commentId, identifier: "ALP-1", bodySnippet: "hi" },
      { companyId: "company-a", entityId: "issue-1", entityType: "issue", ...actor },
    );
  }

  it("names a board author and hydrates a missing issue title", async () => {
    const { harness, calls } = await commentSetup();
    const comment = await harness.ctx.issues.createComment("issue-1", "hello", "company-a", {
      actorUserId: "user-1",
    });
    await emitComment(harness, comment.id, { actorType: "user", actorId: "user-1" });

    const text = String(calls.find((c) => c.method === "sendMessage")?.body.text);
    expect(text).toContain("*Board* wrote:");
    expect(text).toContain("Smoke test");
    expect(text).not.toContain("Someone");
    expect(text).not.toContain("no title");
  });

  it("names an agent author", async () => {
    const { harness, calls } = await commentSetup();
    const comment = await harness.ctx.issues.createComment("issue-1", "done", "company-a", {
      authorAgentId: "agent-1",
    });
    await emitComment(harness, comment.id, { actorType: "agent", actorId: "agent-1" });

    expect(String(calls.find((c) => c.method === "sendMessage")?.body.text)).toContain(
      "*Builder* wrote:",
    );
  });

  it("does not echo a reply it relayed from Telegram back to the chat", async () => {
    const { harness, calls } = await commentSetup();
    const chat = (await readPairing(harness.ctx)).pairedByCompany!["company-a"]!;
    await postTelegramReplyComment(
      harness.ctx,
      chat,
      { message_id: 5, from: { id: 42 }, chat: { id: 100, type: "private" }, date: 0, text: "ship it" },
      { companyId: "company-a", issueId: "issue-1" },
      "ship it",
    );
    const [relayed] = await harness.ctx.issues.listComments("issue-1", "company-a");
    await emitComment(harness, relayed!.id, { actorType: "user", actorId: "user-1" });
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);

    // A later board comment still notifies.
    const next = await harness.ctx.issues.createComment("issue-1", "ship it", "company-a", {
      actorUserId: "user-1",
    });
    await emitComment(harness, next.id, { actorType: "user", actorId: "user-1" });
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("notifies a same-text comment created while a relay is in flight", async () => {
    const { harness, calls } = await commentSetup();
    const chat = (await readPairing(harness.ctx)).pairedByCompany!["company-a"]!;
    const createComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    harness.ctx.issues.createComment = (async (...args: Parameters<typeof createComment>) => {
      await held;
      return createComment(...args);
    }) as typeof createComment;

    const relaying = postTelegramReplyComment(
      harness.ctx,
      chat,
      { message_id: 5, from: { id: 42 }, chat: { id: 100, type: "private" }, date: 0, text: "ship it" },
      { companyId: "company-a", issueId: "issue-1" },
      "ship it",
    );
    const board = await createComment("issue-1", "ship it", "company-a", { actorUserId: "user-1" });
    const notifying = emitComment(harness, board.id, { actorType: "user", actorId: "user-1" });
    release();
    await Promise.all([relaying, notifying]);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);

    // The relayed reply itself is still not echoed.
    const relayed = (await harness.ctx.issues.listComments("issue-1", "company-a")).find(
      (c) => c.id !== board.id,
    );
    await emitComment(harness, relayed!.id, { actorType: "user", actorId: "user-1" });
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});

describe("config", () => {
  it("allows a config without botToken so Disconnect can clear it", () => {
    const schema = manifest.instanceConfigSchema as { required?: string[] };
    expect(schema.required ?? []).not.toContain("botToken");
  });

  it("merges only the saving card's fields over the stored config", () => {
    const stored = {
      botToken: REF_A,
      paperclipBaseUrl: "https://a",
      notifyOn: { comments: false },
    };
    expect(applyConfigPatch(stored, { paperclipBaseUrl: "https://b" })).toEqual({
      botToken: REF_A,
      paperclipBaseUrl: "https://b",
      notifyOn: { comments: false },
    });
    expect(applyConfigPatch(stored, { botToken: undefined })).toEqual({
      paperclipBaseUrl: "https://a",
      notifyOn: { comments: false },
    });
  });

  it("declares companyId-free tool schemas matching the handlers", () => {
    for (const tool of manifest.tools ?? []) {
      const schema = tool.parametersSchema as { required?: string[] };
      expect(schema.required ?? []).not.toContain("companyId");
    }
  });
});

describe("get_approval_config tool", () => {
  it("resolves for the calling agent when no agentId is passed", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    await setApprovalConfig(harness.ctx, "company-a", {
      enabled: true,
      approverAgentId: null,
      agents: { "agent-1": { requiresApproval: true } },
    });

    const result = await harness.executeTool<{ data: { requiresApproval: boolean } }>(
      TOOL_NAMES.getApprovalConfig,
      {},
      { companyId: "company-a", agentId: "agent-1" },
    );

    expect(result.data.requiresApproval).toBe(true);
  });
});

describe("confirmation notifications", () => {
  const confirmation = (harness: TestHarness, issueId: string) =>
    harness.emit(
      "approval.created",
      {
        interactionKind: "request_confirmation",
        interactionId: "ix-1",
        bodySnippet: "PRIVATE PROMPT TEXT",
      },
      { companyId: "company-a", entityId: issueId, entityType: "issue" },
    );

  it("sends only the title and link, never the prompt, and no loopback request", async () => {
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    harness.seed({
      issues: [
        { id: "issue-1", companyId: "company-a", title: "Ship it", identifier: "PAP-1" } as unknown as Issue,
      ],
    });
    await pair(harness, "company-a", "100");
    const loopback = vi.spyOn(globalThis, "fetch");

    await confirmation(harness, "issue-1");

    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toContain("Ship it");
    expect(JSON.stringify(sent[0]?.body)).not.toContain("PRIVATE PROMPT");
    expect(loopback).not.toHaveBeenCalled();
    loopback.mockRestore();
  });

  it("sends nothing for an issue the plugin cannot read in this company", async () => {
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    harness.seed({
      issues: [{ id: "issue-x", companyId: "company-b", title: "Other" } as unknown as Issue],
    });
    await pair(harness, "company-a", "100");

    await confirmation(harness, "issue-x");

    expect(calls.filter((c) => c.method === "sendMessage")).toEqual([]);
  });
});

describe("paired chats during another company's handshake", () => {
  it("lets a paired chat use its commands while another company pairs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, pendingUpdates } = await setup({
      "company-a": { botToken: REF_A },
      "company-b": { botToken: REF_A },
    });
    seedCompany(harness, "company-b");
    await pair(harness, "company-a", "100");
    await harness.performAction("startPairing", {}, { companyId: "company-b" });
    pendingUpdates.set("111111", [
      { update_id: 1, message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "/status" } },
    ]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    const replies = calls
      .filter((c) => c.method === "sendMessage" && c.body.chat_id === "100")
      .map((c) => String(c.body.text));
    expect(replies.some((t) => t.includes("Wrong chat"))).toBe(false);
    expect(replies.length).toBeGreaterThan(0);
    expect(state(harness).pairing?.stage).toBe("awaiting_chat");
  });
});

describe("morning digest sections", () => {
  it("reads every page of each section instead of one mixed page", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } });
    const issue = (id: string, status: string) =>
      ({ id, companyId: "company-a", title: id, status }) as unknown as Issue;
    harness.seed({
      issues: [
        ...Array.from({ length: 250 }, (_, i) => issue(`busy-${i}`, "in_progress")),
        issue("todo-1", "todo"),
        issue("todo-2", "todo"),
        { ...issue("done-1", "done"), completedAt: new Date() } as unknown as Issue,
      ],
    });

    const digest = await collectDigestIssues(harness.ctx, "company-a", new Date());

    expect(digest.inProgress).toHaveLength(250);
    expect(digest.todo.map((i) => i.id)).toEqual(["todo-1", "todo-2"]);
    expect(digest.doneYesterday.map((i) => i.id)).toEqual(["done-1"]);
    expect(digest.capped).toBe(false);
  });
});

describe("Telegram reply fallback", () => {
  it("does not post a second copy when the human-attributed write saved before failing", async () => {
    const { harness } = await setup({ "company-a": { botToken: REF_A } }, ["issue.comments.read"]);
    harness.seed({
      issues: [{ id: "issue-1", companyId: "company-a", title: "T" } as unknown as Issue],
      accessMembers: [
        {
          companyId: "company-a",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
        } as unknown as PluginAccessMember,
      ],
    });
    const create = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    harness.ctx.issues.createComment = async (issueId, body, companyId, options) => {
      const comment = await create(issueId, body, companyId, options);
      if (options?.actorUserId) throw new Error("activity log write failed");
      return comment;
    };

    const author = await postTelegramReplyComment(
      harness.ctx,
      {
        chatId: "100",
        chatLabel: "chat",
        pairedAt: "",
        pairedByTelegramUserId: 42,
        pairedByUserId: "user-1",
        operateAsAgentId: "agent-1",
      },
      { message_id: 5, from: { id: 42 }, chat: { id: 100, type: "private" }, date: 0, text: "ship it" },
      { companyId: "company-a", issueId: "issue-1" },
      "ship it",
    );

    const comments = await harness.ctx.issues.listComments("issue-1", "company-a");
    expect(author).toBe("user");
    expect(comments).toHaveLength(1);
  });
});

describe("long polling", () => {
  it("holds each idle getUpdates open longer than the old 5s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");

    await harness.runJob(JOB_KEYS.pollUpdates);

    const poll = calls.find((c) => c.method === "getUpdates");
    expect(poll?.body.timeout).toBe(20);
  });
});

describe("company edit panel save", () => {
  it("refreshes the card data after every section saved", async () => {
    const order: string[] = [];
    await saveThenRefresh(
      [
        Promise.resolve().then(() => void order.push("save-a")),
        undefined,
        Promise.resolve().then(() => void order.push("save-b")),
      ],
      [async () => void order.push("refresh-company"), async () => void order.push("refresh-approval")],
    );
    expect(order).toEqual(["save-a", "save-b", "refresh-company", "refresh-approval"]);
  });
});
