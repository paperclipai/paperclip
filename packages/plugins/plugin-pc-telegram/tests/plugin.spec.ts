import { createElement } from "react";
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

    const started = await harness.performAction<{ loginId: string }>("start-login", { companyId: COMPANY_ID });
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
    expect(telegram.connectFromSessionCalls.length).toBe(2);
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
    await harness.performAction("start-login", { companyId: COMPANY_ID });
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);

    await harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
    });
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
    await harness.performAction("start-login", { companyId: COMPANY_ID });
    telegram.completeLogin();
    await waitFor(() => telegram.connectFromSessionCalls.length === 1);
    await harness.performAction("update-connection", {
      companyId: COMPANY_ID,
      telegramUserId: "1001",
      assignedAgentId: AGENT_ID,
    });
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
});
