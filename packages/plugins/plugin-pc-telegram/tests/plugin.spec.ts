import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
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
  OTHER_COMPANY_ID,
  createMockTelegram,
  inboundMessage,
  seedCompanies,
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
        type: "companySettingsPage",
        routePath: "telegram",
        exportName: "TelegramConnectPage",
      }),
    ]);
    expect(parsed.instanceConfigSchema?.properties).toMatchObject({
      apiId: { format: "secret-ref" },
      apiHash: { format: "secret-ref" },
    });
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
    const loginStatus = await harness.getData<{ state: string }>("login-status", {
      companyId: COMPANY_ID,
      loginId: started.loginId,
    });
    expect(loginStatus.state).toBe("connected");
    secretFree(harness.logs);
    secretFree(overview);

    const restarted = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    seedCompanies(harness, COMPANY_ID);
    await restarted.definition.setup(harness.ctx);
    await waitFor(() => telegram.connectFromSessionCalls.length === 2);
    expect(telegram.connectFromSessionCalls[1]?.session).toBe(MOCK_SESSION);
    expect(telegram.startQrLoginCount).toBe(1);
  });

  it("reconnects every saved company after a restart", async () => {
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

    await harness.performAction("start-login", { companyId: OTHER_COMPANY_ID }, boardUser);
    telegram.completeLogin(
      { telegramUserId: "1002", username: "other", displayName: "Other Desk" },
      "session-other",
    );
    await waitFor(() => telegram.connectFromSessionCalls.length === 2);

    const restarted = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    seedCompanies(harness, COMPANY_ID, OTHER_COMPANY_ID);
    await restarted.definition.setup(harness.ctx);
    await waitFor(() => telegram.connectFromSessionCalls.length === 4);
    expect(telegram.connectFromSessionCalls.slice(2).map((call) => call.companyId).sort()).toEqual(
      [COMPANY_ID, OTHER_COMPANY_ID].sort(),
    );
    expect(telegram.connectFromSessionCalls.slice(2).map((call) => call.session).sort()).toEqual(
      [MOCK_SESSION, "session-other"].sort(),
    );
    expect(telegram.startQrLoginCount).toBe(2);
  });

  it("reports startup reconnect to idle drain and waits for it during shutdown", async () => {
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

    telegram.holdConnect();
    const restarted = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    seedCompanies(harness, COMPANY_ID);
    await restarted.definition.setup(harness.ctx);
    await waitFor(() => telegram.connectStarted === 2);
    expect(await restarted.definition.onIdleDrain?.(new AbortController().signal)).toBe("present");
    let shutdownDone = false;
    const shutdown = restarted.definition.onShutdown?.().then(() => {
      shutdownDone = true;
    });
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    expect(shutdownDone).toBe(false);
    telegram.releaseConnect();
    await shutdown;
    expect(await restarted.definition.onIdleDrain?.(new AbortController().signal)).toBe("none");
    const overview = await harness.getData<{ connections: Array<{ hasSession: boolean; live: boolean }> }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.connections).toEqual([
      expect.objectContaining({ telegramUserId: "1001", hasSession: true, live: false }),
    ]);
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
    }, boardUser);
    expect(telegram.startQrLoginCount).toBe(1);

    let inboundScopes = 0;
    const runInCompany = harness.ctx.runInCompanyBackground.bind(harness.ctx);
    harness.ctx.runInCompanyBackground = async (scopeCompanyId, fn) => {
      inboundScopes += 1;
      return runInCompany(scopeCompanyId, fn);
    };
    await telegram.deliver(inboundMessage());
    expect(inboundScopes).toBe(1);
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

  it("rejects an agent and a user from another company before they can change account access", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const agent = { actor: { type: "agent" as const, agentId: AGENT_ID, companyId: COMPANY_ID } };
    const outsider = { actor: { type: "user" as const, userId: "user-2", companyId: OTHER_COMPANY_ID } };
    await expect(harness.performAction("start-login", { companyId: COMPANY_ID }, agent)).rejects.toThrow(/board user/);
    await expect(harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
    }, agent)).rejects.toThrow(/board user/);
    await expect(harness.performAction("set-paused", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      paused: true,
    }, agent)).rejects.toThrow(/board user/);
    await expect(harness.performAction("disconnect-account", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
    }, agent)).rejects.toThrow(/board user/);
    await expect(harness.performAction("start-login", { companyId: COMPANY_ID }, outsider)).rejects.toThrow(/board user/);
    expect(telegram.startQrLoginCount).toBe(0);
  });

  it("does not keep a session when login is cancelled while the account is connecting", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    telegram.holdConnect();
    const started = await harness.performAction<{ loginId: string }>("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin();
    await waitFor(() => telegram.connectStarted === 1);
    const cancelPromise = harness.performAction("cancel-login", {
      companyId: COMPANY_ID,
      loginId: started.loginId,
    }, boardUser);
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    telegram.releaseConnect();
    await cancelPromise;
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);
    const overview = await harness.getData<{ connections: Array<{ hasSession: boolean; live: boolean; paused: boolean }> }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.connections).toEqual([
      expect.objectContaining({ telegramUserId: "1001", hasSession: false, live: false, paused: true }),
    ]);
    const status = await harness.getData<{ state: string }>("login-status", {
      companyId: COMPANY_ID,
      loginId: started.loginId,
    });
    expect(status.state).toBe("idle");
  });

  it("keeps the newer login when an older login is cancelled while connecting", async () => {
    const telegram = createMockTelegram();
    const plugin = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    telegram.holdConnect();
    const older = await harness.performAction<{ loginId: string }>("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin(undefined, "session-old");
    await waitFor(() => telegram.connectStarted === 1);
    await harness.performAction("start-login", { companyId: COMPANY_ID }, boardUser);
    telegram.completeLogin(undefined, "session-new");
    await waitFor(() => telegram.connectStarted === 2);
    const cancelPromise = harness.performAction("cancel-login", {
      companyId: COMPANY_ID,
      loginId: older.loginId,
    }, boardUser);
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    telegram.releaseConnect();
    await cancelPromise;
    await waitFor(() => telegram.connectFromSessionCalls.length === 2);
    const overview = await harness.getData<{ connections: Array<{ hasSession: boolean; paused: boolean }> }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(telegram.connectFromSessionCalls.map((call) => call.session)).toEqual(["session-old", "session-new"]);
    expect(overview.connections).toEqual([
      expect.objectContaining({ telegramUserId: "1001", hasSession: true, paused: false }),
    ]);
  });

  it("does not attach an account that was disconnected while reconnect was in flight", async () => {
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

    telegram.holdConnect();
    const restarted = createTelegramUserClientPlugin({
      createClient: telegram.factory,
      resolveAppCredentials: async () => ({ apiId: 1, apiHash: MOCK_API_HASH }),
    });
    seedCompanies(harness, COMPANY_ID);
    await restarted.definition.setup(harness.ctx);
    await waitFor(() => telegram.connectStarted === 2);
    await harness.performAction("disconnect-account", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
    }, boardUser);
    telegram.releaseConnect();
    await waitFor(() => telegram.connectFromSessionCalls.length === 2);
    const overview = await harness.getData<{ connections: Array<{ hasSession: boolean; live: boolean }> }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.connections).toEqual([
      expect.objectContaining({ telegramUserId: "1001", hasSession: false, live: false }),
    ]);
  });

  it("keeps Cancel on the left of the primary login action", () => {
    (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
      react: { createElement },
      sdkUi: {
        usePluginData: (key: string) => ({
          data: key === "login-status"
            ? { state: "password_required", loginId: "login-1", hint: "hint" }
            : {
                pluginId: PLUGIN_ID,
                credentialsConfigured: true,
                connections: [],
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
    const cancelAt = html.indexOf(">Cancel<");
    const continueAt = html.indexOf(">Continue<");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(continueAt).toBeGreaterThan(cancelAt);
    expect(html).toContain("justify-content:space-between");
    expect(html).toContain("var(--text-sm--line-height)");
    expect(html).not.toContain("calc(");
    expect(html).not.toContain("220");
  });

  it("does not download inbound media for a paused account or past the peer cap", async () => {
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
    let downloads = 0;
    await telegram.deliver(inboundMessage({
      text: "",
      peerId: "media-peer",
      attachments: [],
      loadAttachments: async () => {
        downloads += 1;
        const bytes = new Uint8Array([1, 2, 3, 4]);
        return [{
          id: "voice-live",
          filename: "voice.ogg",
          mimeType: "audio/ogg",
          byteLength: bytes.byteLength,
          kind: "voice" as const,
          bytes,
        }];
      },
    }));
    expect(downloads).toBe(1);
    await harness.performAction("set-paused", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      paused: true,
    }, boardUser);
    await telegram.deliver(inboundMessage({
      text: "paused",
      peerId: "media-peer",
      messageId: "2",
      attachments: [],
      loadAttachments: async () => {
        downloads += 1;
        return [];
      },
    }));
    expect(downloads).toBe(1);
    await harness.performAction("set-paused", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      paused: false,
    }, boardUser);
    downloads = 0;
    for (let index = 0; index < 9; index += 1) {
      await telegram.deliver(inboundMessage({
        messageId: String(index + 10),
        text: "",
        peerId: "capped-peer",
        attachments: [],
        loadAttachments: async () => {
          downloads += 1;
          return [];
        },
      }));
    }
    expect(downloads).toBe(8);
  });

  it("drops the previous company's login when the settings page changes company", async () => {
    const requireFromServer = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../server/package.json"));
    const { JSDOM } = requireFromServer("jsdom") as {
      JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis };
    };
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    const view = dom.window;
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver,
    };
    const restoreDom = () => {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.MutationObserver = previous.MutationObserver;
    };
    globalThis.window = view as unknown as Window & typeof globalThis;
    globalThis.document = view.document;
    globalThis.HTMLElement = view.HTMLElement;
    globalThis.Node = view.Node;
    globalThis.MutationObserver = view.MutationObserver;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const passwordStatus = { state: "password_required" as const, loginId: "login-a", hint: "cloud" };
    const passwordStream = {
      events: [] as unknown[],
      lastEvent: { status: passwordStatus },
      connecting: false,
      connected: false,
      error: null,
      close() {},
    };
    const idleStream = {
      events: [] as unknown[],
      lastEvent: null,
      connecting: false,
      connected: false,
      error: null,
      close() {},
    };
    const overview = {
      data: { pluginId: PLUGIN_ID, credentialsConfigured: true, connections: [] as unknown[] },
      loading: false,
      error: null,
      refresh() {},
    };
    (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
      react: { createElement },
      sdkUi: {
        usePluginData: (key: string, params?: { companyId?: string }) => {
          if (key === "login-status") {
            return {
              data: params?.companyId === COMPANY_ID ? passwordStatus : { state: "idle" as const },
              loading: false,
              error: null,
              refresh() {},
            };
          }
          return overview;
        },
        usePluginAction: () => async () => ({}),
        usePluginStream: (_channel: string, params?: { companyId?: string }) => (
          params?.companyId === COMPANY_ID ? passwordStream : idleStream
        ),
        AssigneePicker: () => createElement("div", null, "Assignee"),
        StatusBadge: ({ label }: { label: string }) => createElement("span", null, label),
      },
    };
    const host = view.document.createElement("div");
    view.document.body.appendChild(host);
    let root: Root | null = null;
    const page = (companyId: string) => createElement(TelegramConnectPage, {
      context: {
        companyId,
        companyPrefix: "AND",
        projectId: null,
        entityId: null,
        entityType: null,
        userId: "user-1",
      },
    });
    try {
      root = createRoot(host as unknown as HTMLElement);
      await act(async () => {
        root?.render(page(COMPANY_ID));
      });
      const input = view.document.querySelector("input[name='cloud-password']") as HTMLInputElement | null;
      expect(input).not.toBeNull();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "secret");
        input?.dispatchEvent(new view.Event("input", { bubbles: true }));
      });
      expect(input?.value).toBe("secret");
      await act(async () => {
        root?.render(page(OTHER_COMPANY_ID));
      });
      expect(view.document.querySelector("input[name='cloud-password']")).toBeNull();
      expect(view.document.body.textContent).not.toContain("secret");
      expect(view.document.body.textContent).toContain("Connect Telegram");
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      restoreDom();
    }
  });
});
