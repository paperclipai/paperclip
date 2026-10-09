import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type {
  Agent,
  Company,
  Issue,
  PluginAccessMember,
  PluginCapability,
} from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_KEYS, STATE_KEY, TOOL_NAMES } from "./constants.js";
import manifest from "./manifest.js";
import { readPairing, setApprovalConfig, setPairedChat } from "./pairing.js";
import type { PairingState, TelegramUpdate } from "./types.js";
import { applyConfigPatch } from "./ui/config-patch.js";
import plugin, { configForUpdate, postTelegramReplyComment } from "./worker.js";

const TOKEN_A = "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

interface TelegramCall {
  botId: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * Harness with the host's current config contract: config is stored per
 * company and `get()` without a company is rejected, as it is for a
 * scheduled job outside any company-scoped invocation.
 */
async function setup(
  configs: Record<string, Record<string, unknown>>,
  extraCapabilities: PluginCapability[] = [],
) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, ...extraCapabilities],
  });
  const configReads: Array<string | undefined> = [];
  harness.ctx.config.get = async (companyId?: string) => {
    configReads.push(companyId);
    const config = companyId ? configs[companyId] : undefined;
    if (!config) throw new Error("company context is required");
    return { ...config };
  };

  const calls: TelegramCall[] = [];
  const pendingUpdates = new Map<string, TelegramUpdate[]>();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    const match = String(url).match(/\/bot(\d+):[^/]+\/(\w+)$/);
    if (!match) throw new Error(`unexpected url ${url}`);
    const [, botId, method] = match;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ botId: botId!, method: method!, body });
    let result: unknown = true;
    if (method === "getMe") result = { id: Number(botId), username: `bot${botId}` };
    if (method === "sendMessage") result = { message_id: calls.length };
    if (method === "getUpdates") {
      result = pendingUpdates.get(botId!) ?? [];
      pendingUpdates.delete(botId!);
      // End the 55-second long-poll loop after the first round.
      vi.setSystemTime(Date.now() + 120_000);
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  await plugin.definition.setup(harness.ctx);
  return { harness, configReads, calls, pendingUpdates };
}

function seedCompany(harness: TestHarness, id: string) {
  harness.seed({ companies: [{ id, name: `Company ${id}` } as unknown as Company] });
}

async function pair(harness: TestHarness, companyId: string, chatId: string) {
  await setPairedChat(harness.ctx, companyId, {
    chatId,
    chatLabel: `chat ${chatId}`,
    pairedAt: "2026-10-01T00:00:00.000Z",
    pairedByTelegramUserId: 42,
  });
}

function state(harness: TestHarness): PairingState {
  return (harness.getState({ scopeKind: "instance", stateKey: STATE_KEY }) ??
    {}) as PairingState;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("poll job with company-scoped config", () => {
  it("reads each paired company's config by id and polls its bot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, configReads, calls } = await setup({
      "company-a": { botToken: TOKEN_A },
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
      "company-a": { botToken: TOKEN_A },
      "company-b": { botToken: TOKEN_B },
      "company-c": { botToken: TOKEN_A },
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
      "company-a": { botToken: TOKEN_A },
    });
    await pair(harness, "company-a", "100");
    pendingUpdates.set("111111", [
      { update_id: 7, message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "/help" } },
    ]);

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect(state(harness).bots?.["111111"]?.lastUpdateId).toBe(7);
  });
});

describe("configForUpdate", () => {
  const group = {
    botId: "111111",
    config: { botToken: TOKEN_A },
    configs: new Map([["company-a", { botToken: TOKEN_A, silent: true }]]),
  };
  const update = (chatId: number): TelegramUpdate => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: chatId, type: "private" }, date: 0, text: "/inbox" },
  });
  const pairedState: PairingState = {
    pairedByCompany: {
      "company-a": { chatId: "100", chatLabel: "a", pairedAt: "" },
      "company-b": { chatId: "200", chatLabel: "b", pairedAt: "" },
    },
  };

  it("uses the config of the company the chat is paired to", () => {
    expect(configForUpdate(pairedState, update(100), group)).toEqual({
      botToken: TOKEN_A,
      silent: true,
    });
  });

  it("ignores a chat paired to a company that uses another bot", () => {
    expect(configForUpdate(pairedState, update(200), group)).toBeUndefined();
  });
});

describe("agent tools are bound to the calling agent's company", () => {
  it("refuses to unpair another company", async () => {
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
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
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");

    await harness.executeTool(TOOL_NAMES.unpair, {}, { companyId: "company-a" });

    expect(state(harness).pairedByCompany?.["company-a"]).toBeUndefined();
    expect(state(harness).pairedByCompany?.["company-b"]).toBeDefined();
  });

  it("returns only the caller's pairing from get_status", async () => {
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
    await pair(harness, "company-a", "100");
    await pair(harness, "company-b", "200");

    const result = await harness.executeTool<{ data: { paired: { companyId: string } | null } }>(
      TOOL_NAMES.getStatus,
      {},
      { companyId: "company-a" },
    );

    expect(result.data.paired?.companyId).toBe("company-a");
    expect(JSON.stringify(result)).not.toContain("company-b");
  });

  it("does not let another company confirm or cancel a live handshake", async () => {
    const { harness } = await setup({
      "company-a": { botToken: TOKEN_A },
      "company-b": { botToken: TOKEN_A },
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
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
    seedCompany(harness, "company-a");
    seedCompany(harness, "company-b");

    const data = await harness.getData<{ items: Array<{ id: string }> }>("companies", {
      companyId: "company-a",
    });

    expect(data.items.map((c) => c.id)).toEqual(["company-a"]);
  });

  it("serializes concurrent pairing-state writes so none is lost", async () => {
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
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
      "company-a": { botToken: TOKEN_A },
    };
    const { harness } = await setup(configs);

    await harness.performAction("startPairing", {}, { companyId: "company-a" });
    const first = await harness.getData<{ botUsername?: string }>("status", {
      companyId: "company-a",
    });
    configs["company-a"] = { botToken: TOKEN_B };
    await harness.performAction("startPairing", {}, { companyId: "company-a" });
    const second = await harness.getData<{ botUsername?: string }>("status", {
      companyId: "company-a",
    });

    expect(first.botUsername).toBe("bot111111");
    expect(second.botUsername).toBe("bot222222");
  });

  it("records the confirming Paperclip user on the paired chat", async () => {
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } });
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
    const { harness } = await setup({ "company-a": { botToken: TOKEN_A } }, [
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

  it("keeps agent attribution for other chat members", async () => {
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
});

describe("notifications", () => {
  it("links failed runs to the agent from the payload, not the run id", async () => {
    const { harness, calls } = await setup({
      "company-a": { botToken: TOKEN_A, paperclipBaseUrl: "https://paperclip.example" },
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

describe("config", () => {
  it("allows a config without botToken so Disconnect can clear it", () => {
    const schema = manifest.instanceConfigSchema as { required?: string[] };
    expect(schema.required ?? []).not.toContain("botToken");
  });

  it("merges only the saving card's fields over the stored config", () => {
    const stored = {
      botToken: TOKEN_A,
      paperclipBaseUrl: "https://a",
      notifyOn: { comments: false },
    };
    expect(applyConfigPatch(stored, { paperclipBaseUrl: "https://b" })).toEqual({
      botToken: TOKEN_A,
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
