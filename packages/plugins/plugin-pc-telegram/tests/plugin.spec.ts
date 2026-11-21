import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { upsertConnection } from "../src/connections.js";
import { DIALOG_ORIGIN_KIND, PLUGIN_ID, TOOL_SEND_TEXT } from "../src/constants.js";
import { containsSecretMaterial } from "../src/redaction.js";
import { TelegramConnectPage } from "../src/ui/index.js";
import { createTelegramUserClientPlugin } from "../src/worker.js";
import manifest from "../src/manifest.js";
import {
  AGENT_ID,
  COMPANY_ID,
  MOCK_API_HASH,
  MOCK_SESSION,
  OTHER_AGENT_ID,
  createMockTelegram,
  inboundMessage,
  waitFor,
} from "./support.js";

type TestBridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: {
    react?: { createElement?: typeof createElement };
    sdkUi?: Record<string, unknown>;
  };
};

function secretFree(value: unknown) {
  expect(containsSecretMaterial(value, [MOCK_SESSION, MOCK_API_HASH, "cloud-password"])).toBe(false);
}

const boardUser = { actor: { type: "user" as const, userId: "user-1" } };

describe("pc-telegram plugin", () => {
  it("declares QR connect UI, secret-ref app credentials, and the send tool", () => {
    const parsed = manifest;
    expect(parsed.id).toBe(PLUGIN_ID);
    expect(parsed.tools).toEqual([
      expect.objectContaining({ name: TOOL_SEND_TEXT }),
    ]);
    expect(parsed.ui?.slots).toEqual([
      expect.objectContaining({
        type: "page",
        routePath: "telegram-inbox",
        exportName: "TelegramInboxPage",
      }),
      expect.objectContaining({
        type: "sidebar",
        exportName: "TelegramChatsNav",
      }),
      expect.objectContaining({
        type: "companySettingsPage",
        routePath: "telegram",
        exportName: "TelegramConnectPage",
      }),
    ]);
    expect(parsed.instanceConfigSchema?.properties).toMatchObject({
      apiId: { format: "secret-ref" },
      apiHash: { format: "secret-ref" },
    });
    expect(parsed.capabilities).toEqual(expect.arrayContaining([
      "ui.page.register",
      "ui.sidebar.register",
      "instance.settings.register",
    ]));
  });

  it("stores a session secret from QR login and reconnects without a new login", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const started = await harness.performAction<{ loginId: string }>("start-login", { companyId: COMPANY_ID }, boardUser);
    expect(started.loginId).toEqual(expect.any(String));
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);

    const overview = await harness.getData<{ connections: Array<{ telegramUserId: string; hasSession: boolean }> }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.connections).toEqual([
      expect.objectContaining({ telegramUserId: "1001", hasSession: true }),
    ]);
    expect(telegram.connectFromSessionCalls[0]?.session).toBe(MOCK_SESSION);
    secretFree(harness.logs);
    secretFree(overview);

    const restarted = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    await restarted.definition.setup(harness.ctx);
    await waitFor(() => telegram.connectFromSessionCalls.length === 2);
    expect(telegram.connectFromSessionCalls[1]?.session).toBe(MOCK_SESSION);
    expect(telegram.startQrLoginCount).toBe(1);
  });

  it("turns an inbound DM into an assigned issue and keeps assignment changes off the Telegram login", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);

    await expect(harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
    }, { actor: { type: "agent", agentId: AGENT_ID } })).rejects.toThrow(/board user/);

    await harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
      acceptUnlistedSenders: true,
    }, boardUser);
    expect(telegram.startQrLoginCount).toBe(1);

    await telegram.deliver(inboundMessage());
    const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: DIALOG_ORIGIN_KIND });
    expect(issues).toEqual([
      expect.objectContaining({
        originId: "1001:2002",
        assigneeAgentId: AGENT_ID,
        title: "Telegram · Sam",
      }),
    ]);
    secretFree(issues);
    secretFree(harness.logs);
    secretFree(await harness.ctx.issues.listComments(issues[0]!.id, COMPANY_ID));
  });

  it("lets only the assigned agent send text through the plugin tool", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);
    await harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
      acceptUnlistedSenders: true,
    }, boardUser);
    await telegram.deliver(inboundMessage());
    const [dialog] = await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: DIALOG_ORIGIN_KIND });

    const allowed = await harness.executeTool(TOOL_SEND_TEXT, {
      text: "Working on it",
      issueId: dialog!.id,
    }, { agentId: AGENT_ID, companyId: COMPANY_ID });
    expect(allowed).toMatchObject({ content: "Sent Telegram message." });
    expect(telegram.sent).toEqual([
      { accountId: "1001", peerId: "2002", text: "Working on it" },
    ]);

    const denied = await harness.executeTool(TOOL_SEND_TEXT, {
      text: "Nope",
      issueId: dialog!.id,
    }, { agentId: OTHER_AGENT_ID, companyId: COMPANY_ID });
    expect(denied).toMatchObject({
      error: "This agent cannot send from that Telegram account.",
    });
    const missingTask = await harness.executeTool(TOOL_SEND_TEXT, {
      text: "Anywhere",
      accountId: "1001",
      peerId: "9999",
    }, { agentId: AGENT_ID, companyId: COMPANY_ID });
    expect(missingTask).toMatchObject({ error: "A Telegram task is required." });
    expect(telegram.sent).toHaveLength(1);
    secretFree(allowed);
    secretFree(denied);
  });

  it("rejects agent cache changes and lets a board user save or clear", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const agent = { actor: { type: "agent" as const, agentId: AGENT_ID } };
    await expect(harness.performAction("cache-save", {
      companyId: COMPANY_ID,
      enabled: false,
    }, agent)).rejects.toThrow(/board user/);
    const saved = await harness.performAction<{ enabled: boolean }>("cache-save", {
      companyId: COMPANY_ID,
      enabled: false,
    }, boardUser);
    expect(saved.enabled).toBe(false);
    await expect(harness.performAction("cache-clear", {
      companyId: COMPANY_ID,
      scope: "all",
    }, agent)).rejects.toThrow(/board user/);
    const cleared = await harness.performAction<{ enabled: boolean }>("cache-clear", {
      companyId: COMPANY_ID,
      scope: "dialogs",
    }, boardUser);
    expect(cleared.enabled).toBe(false);
  });

  it("lets a board user or the assigned agent send, delete, and forward", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);
    await harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
      acceptUnlistedSenders: true,
    }, boardUser);
    await telegram.deliver(inboundMessage());
    const [dialog] = await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: DIALOG_ORIGIN_KIND });
    const target = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "Telegram · Other",
      description: "other",
      status: "todo",
      originKind: DIALOG_ORIGIN_KIND,
      originId: "1001:3003",
    });
    const issueRef = dialog!.identifier || dialog!.id;
    const targetRef = target.identifier || target.id;
    const assigned = { actor: { type: "agent" as const, agentId: AGENT_ID } };
    const stranger = { actor: { type: "agent" as const, agentId: OTHER_AGENT_ID } };

    await harness.performAction("send-chat-reply", {
      companyId: COMPANY_ID,
      issueRef,
      text: "From the board",
    }, boardUser);
    await harness.performAction("send-chat-reply", {
      companyId: COMPANY_ID,
      issueRef,
      text: "From the agent",
    }, assigned);
    await expect(harness.performAction("send-chat-reply", {
      companyId: COMPANY_ID,
      issueRef,
      text: "From someone else",
    }, stranger)).rejects.toThrow(/cannot send/);
    await expect(harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "delete",
      messageIds: ["15"],
    }, stranger)).rejects.toThrow(/cannot send/);
    await expect(harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "forward",
      messageIds: ["16"],
      targetIssueRef: targetRef,
    }, stranger)).rejects.toThrow(/cannot send/);
    await expect(harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "react",
      messageIds: ["17"],
      emoji: "👍",
    }, assigned)).rejects.toThrow(/board user/);

    await harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "delete",
      messageIds: ["15"],
    }, assigned);
    await harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "forward",
      messageIds: ["16"],
      targetIssueRef: targetRef,
    }, assigned);
    await harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "delete",
      messageIds: ["18"],
    }, boardUser);
    await upsertConnection(harness.ctx, {
      companyId: COMPANY_ID,
      account: { telegramUserId: "2002", username: null, displayName: "Other desk" },
      sessionSecretId: "secret-2",
      assignedAgentId: OTHER_AGENT_ID,
    });
    const foreign = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "Telegram · Foreign",
      description: "foreign",
      status: "todo",
      originKind: DIALOG_ORIGIN_KIND,
      originId: "2002:9",
    });
    const foreignRef = foreign.identifier || foreign.id;
    await expect(harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "forward",
      messageIds: ["19"],
      targetIssueRef: foreignRef,
    }, assigned)).rejects.toThrow(/cannot send/);
    await expect(harness.performAction("chat-message-menu", {
      companyId: COMPANY_ID,
      issueRef,
      op: "forward",
      messageIds: ["19"],
      targetIssueRef: foreignRef,
    }, boardUser)).rejects.toThrow(/not connected/);
    expect(telegram.sent.map((row) => row.text)).toEqual(["From the board", "From the agent"]);
    expect(telegram.actions.map((row) => row.op)).toEqual(["delete", "forward", "delete"]);
  });

  it("renders Connect Telegram without session material", () => {
    (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
      react: { createElement },
      sdkUi: {
        usePluginData: () => ({
          data: {
            pluginId: PLUGIN_ID,
            credentialsConfigured: true,
            connections: [{
              telegramUserId: "1001",
              username: "desk",
              displayName: "Front Desk",
              assignedAgentId: AGENT_ID,
              incomingMode: "dialog_task",
              paused: false,
              live: true,
              hasSession: true,
            }],
          },
          loading: false,
          error: null,
          refresh() {},
        }),
        usePluginAction: () => async () => ({}),
        usePluginStream: () => ({
          events: [],
          lastEvent: null,
          connecting: false,
          connected: false,
          error: null,
          close() {},
        }),
        useHostNavigation: () => ({ linkProps: (href: string) => ({ href }) }),
        useHostLocation: () => ({ pathname: "/AND/telegram-inbox" }),
        AssigneePicker: () => createElement("div", null, "Assignee"),
        StatusBadge: ({ label }: { label: string }) => createElement("span", null, label),
      },
    };
    const html = renderToStaticMarkup(createElement(TelegramConnectPage, {
      context: {
        companyId: COMPANY_ID,
        companyPrefix: "AND",
        projectId: null,
        entityId: null,
        entityType: null,
        userId: "user-1",
      },
    }));
    expect(html).toContain("Connect Telegram");
    expect(html).toContain("Front Desk");
    expect(html).toContain("dialog = task");
    secretFree(html);
  });

  it("pages chats in one activity order", async () => {
    const plugin = createTelegramUserClientPlugin({
      createClient: createMockTelegram().factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const created = [];
    for (let index = 0; index < 40; index += 1) {
      created.push(await harness.ctx.issues.create({
        companyId: COMPANY_ID,
        title: `Chat ${index}`,
        status: "todo",
        originKind: DIALOG_ORIGIN_KIND,
        originId: `1001:${2000 + index}`,
      }));
    }
    const original = harness.ctx.issues.list.bind(harness.ctx.issues);
    const limits: number[] = [];
    harness.ctx.issues.list = async (input) => {
      if (input?.originKind === DIALOG_ORIGIN_KIND) limits.push(input.limit ?? 0);
      const rows = await original(input);
      if (input?.originKind !== DIALOG_ORIGIN_KIND) return rows;
      return rows.map((row, index) => ({
        ...row,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
      }));
    };
    const first = await harness.getData<{ chats: Array<{ issueId: string }>; nextCursor: string | null }>("chats", {
      companyId: COMPANY_ID,
    });
    const second = await harness.getData<{ chats: Array<{ issueId: string }>; nextCursor: string | null }>("chats", {
      companyId: COMPANY_ID,
      cursor: "30",
    });
    expect(limits.every((limit) => limit >= 40)).toBe(true);
    expect(first.chats).toHaveLength(30);
    expect(first.chats[0]?.issueId).toBe(created[39]?.id);
    expect(first.nextCursor).toBe("30");
    expect(second.chats.map((chat) => chat.issueId)).toEqual(created.slice(0, 10).reverse().map((issue) => issue.id));
    expect(second.nextCursor).toBeNull();
  });

  it("keeps the login QR off the company stream and an unscoped read", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const emitted: Array<{ channel: string; event: unknown }> = [];
    harness.ctx.streams.emit = (channel, event) => {
      emitted.push({ channel, event });
    };
    const started = await harness.performAction<{ loginId: string }>("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.requirePassword("secret-hint");
    const companyChannel = `telegram-login:${COMPANY_ID}`;
    const privateEvents = emitted.filter((row) => row.channel === `${companyChannel}:${started.loginId}`);
    const companyEvents = emitted.filter((row) => row.channel === companyChannel);
    expect(companyEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(companyEvents)).not.toContain("imageDataUrl");
    expect(JSON.stringify(companyEvents)).not.toContain("secret-hint");
    expect(JSON.stringify(privateEvents)).toContain("data:image/svg+xml");
    expect(JSON.stringify(privateEvents)).toContain("secret-hint");
    expect(await harness.getData("login-status", { companyId: COMPANY_ID })).toEqual({ state: "idle" });
    expect(await harness.getData("login-status", {
      companyId: COMPANY_ID,
      loginId: "00000000-0000-4000-8000-000000000000",
    })).toEqual({ state: "idle" });
    const visible = await harness.getData<{ state: string; hint?: string | null }>("login-status", {
      companyId: COMPANY_ID,
      loginId: started.loginId,
    });
    expect(visible).toMatchObject({ state: "password_required", hint: "secret-hint" });
  });
});
