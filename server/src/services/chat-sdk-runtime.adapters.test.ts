import { describe, expect, it } from "vitest";
import type { Attachment } from "chat";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import type { ChatSdkStatePersistence } from "./chat-sdk-state.js";

const persistence: ChatSdkStatePersistence = {
  async compareAndSet() {
    return true;
  },
  async deleteIfVersion() {
    return true;
  },
  async read() {
    return null;
  },
};

describe("Chat SDK published adapter integration", () => {
  it("constructs an isolated endpoint runtime for every pinned provider package", () => {
    const providerConfigs = [
      {
        provider: "slack" as const,
        userName: "paperclip-agent",
        credentials: { botToken: "xoxb-test", signingSecret: "secret" },
      },
      {
        provider: "github" as const,
        userName: "paperclip-agent[bot]",
        credentials: { token: "github_pat_test", webhookSecret: "secret" },
      },
      {
        provider: "microsoft-teams" as const,
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "secret",
        },
      },
      {
        provider: "telegram" as const,
        userName: "paperclip_agent_bot",
        credentials: { botToken: "123:test", secretToken: "secret" },
      },
    ];

    const runtimes = providerConfigs.map((providerConfig, index) =>
      createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-1",
        endpointId: `endpoint-${index}`,
        logger: "silent",
        persistence,
        providerConfig,
      }),
    );

    expect(runtimes.map((runtime) => runtime.provider)).toEqual([
      "slack",
      "github",
      "microsoft-teams",
      "telegram",
    ]);
    expect(runtimes.map((runtime) => runtime.sdkAdapterKey)).toEqual([
      "slack",
      "github",
      "teams",
      "telegram",
    ]);
    expect(
      new Set(runtimes.map((runtime) => runtime.getProviderAdapter())).size,
    ).toBe(4);
  });

  it.each([
    {
      provider: "slack",
      providerConfig: {
        provider: "slack" as const,
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-BOT",
          signingSecret: "slack-signing-secret",
        },
      },
      request: new Request("https://paperclip.test/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "event_callback" }),
      }),
    },
    {
      provider: "github",
      providerConfig: {
        provider: "github" as const,
        userName: "paperclip-agent[bot]",
        credentials: {
          token: "github_pat_test",
          webhookSecret: "github-webhook-secret",
        },
      },
      request: new Request("https://paperclip.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
        },
        body: JSON.stringify({ action: "created" }),
      }),
    },
    {
      provider: "telegram",
      providerConfig: {
        provider: "telegram" as const,
        userName: "paperclip_agent_bot",
        credentials: {
          botToken: "123:test",
          secretToken: "telegram-webhook-secret",
        },
      },
      request: new Request("https://paperclip.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong-secret",
        },
        body: JSON.stringify({ update_id: 1 }),
      }),
    },
    {
      provider: "microsoft-teams",
      providerConfig: {
        provider: "microsoft-teams" as const,
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "teams-secret",
          appTenantId: "11111111-1111-1111-1111-111111111111",
          appType: "SingleTenant" as const,
        },
      },
      request: new Request("https://paperclip.test/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "forged" }),
      }),
    },
  ])(
    "rejects an unauthenticated $provider webhook before dispatch",
    async ({ providerConfig, request }) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-signature-test",
        endpointId: `endpoint-${providerConfig.provider}`,
        logger: "silent",
        persistence,
        providerConfig,
      });
      const response = await runtime.handleWebhook(request);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    },
  );

  it("round-trips credential-free Slack, Teams, and Telegram attachment recovery metadata", () => {
    const cases: Array<{
      attachment: Attachment;
      credentials: string[];
      expectedLocator: Record<string, unknown>;
      providerConfig: Parameters<
        typeof createChatSdkEndpointRuntime
      >[0]["providerConfig"];
    }> = [
      {
        providerConfig: {
          provider: "slack",
          userName: "paperclip-agent",
          credentials: {
            botToken: "xoxb-never-persist",
            signingSecret: "slack-signing-never-persist",
          },
        },
        credentials: ["xoxb-never-persist", "slack-signing-never-persist"],
        attachment: {
          type: "image",
          name: " release\u0000-plan.png ",
          mimeType: "image/png",
          size: 2048,
          width: 640,
          height: 480,
          url: "https://files.slack.com/files-pri/T123-F123/release-plan.png",
          fetchMetadata: {
            url: "https://files.slack.com/files-pri/T123-F123/release-plan.png",
            teamId: "T123",
            botToken: "xoxb-never-persist",
            arbitrary: "slack-private-metadata",
          },
        },
        expectedLocator: {
          kind: "slack_private_url",
          teamId: "T123",
          url: "https://files.slack.com/files-pri/T123-F123/release-plan.png",
        },
      },
      {
        providerConfig: {
          provider: "microsoft-teams",
          userName: "Paperclip Agent",
          credentials: {
            appId: "00000000-0000-0000-0000-000000000000",
            appPassword: "teams-password-never-persist",
          },
        },
        credentials: ["teams-password-never-persist"],
        attachment: {
          type: "file",
          name: "design.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 4096,
          fetchMetadata: {
            auth: "bot",
            url: "https://smba.trafficmanager.net/amer/v3/attachments/A1/views/original",
            connectorOrigin: "https://smba.trafficmanager.net",
            clientSecret: "teams-password-never-persist",
          },
        },
        expectedLocator: {
          kind: "teams_bot_url",
          url: "https://smba.trafficmanager.net/amer/v3/attachments/A1/views/original",
          connectorOrigin: "https://smba.trafficmanager.net",
        },
      },
      {
        providerConfig: {
          provider: "telegram",
          userName: "paperclip_agent_bot",
          credentials: {
            botToken: "123:telegram-never-persist",
            secretToken: "telegram-webhook-never-persist",
          },
        },
        credentials: [
          "123:telegram-never-persist",
          "telegram-webhook-never-persist",
        ],
        attachment: {
          type: "video",
          name: "demo.mp4",
          mimeType: "video/mp4",
          size: 8192,
          width: 1280,
          height: 720,
          fetchMetadata: {
            fileId: "telegram-file-id",
            fileUniqueId: "telegram-stable-id",
            botToken: "123:telegram-never-persist",
          },
        },
        expectedLocator: {
          kind: "telegram_file_id",
          fileId: "telegram-file-id",
          fileUniqueId: "telegram-stable-id",
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-attachment-recovery",
        endpointId: `endpoint-attachment-${index}`,
        logger: "silent",
        persistence,
        providerConfig: testCase.providerConfig,
      });
      const descriptor = runtime.attachmentRecoveryDescriptor(
        testCase.attachment,
      );
      expect(descriptor).toMatchObject({
        version: 1,
        provider: testCase.providerConfig.provider,
        attachment: {
          type: testCase.attachment.type,
          name: testCase.attachment.name?.replace("\u0000", "").trim(),
          mimeType: testCase.attachment.mimeType,
          size: testCase.attachment.size,
        },
        locator: testCase.expectedLocator,
      });
      const persisted = JSON.parse(JSON.stringify(descriptor)) as unknown;
      const serialized = JSON.stringify(persisted);
      for (const credential of testCase.credentials) {
        expect(serialized).not.toContain(credential);
      }
      expect(serialized).not.toContain("arbitrary");
      expect(serialized).not.toContain("clientSecret");
      expect(serialized).not.toContain("botToken");

      const recovered = runtime.rehydrateAttachment(persisted);
      expect(recovered).toMatchObject(descriptor?.attachment ?? {});
      expect(recovered?.fetchMetadata).toBeDefined();
      expect(recovered?.fetchData).toEqual(expect.any(Function));
    }
  });

  it("fails closed for cross-provider and bearer-style Teams attachment locators", () => {
    const teams = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-attachment-recovery",
      endpointId: "endpoint-teams-attachment",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "secret",
        },
      },
    });
    const unsafe = teams.attachmentRecoveryDescriptor({
      type: "file",
      name: "private.docx",
      fetchMetadata: {
        url: "https://files.example.test/private.docx?access_token=secret",
      },
    });
    expect(unsafe).toBeNull();

    const slack = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-attachment-recovery",
      endpointId: "endpoint-slack-attachment",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: { botToken: "token", signingSecret: "secret" },
      },
    });
    expect(
      slack.rehydrateAttachment({
        version: 1,
        provider: "telegram",
        attachment: { type: "file" },
        locator: { kind: "telegram_file_id", fileId: "file-id" },
      }),
    ).toBeNull();
  });
});
