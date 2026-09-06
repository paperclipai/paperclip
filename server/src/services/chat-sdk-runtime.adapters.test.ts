import { describe, expect, it } from "vitest";
import type { Attachment } from "chat";
import {
  createChatSdkEndpointRuntime,
  scopeMicrosoftTeamsEgress,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
} from "./chat-sdk-state.js";

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

function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (input: {
    companyId: string;
    endpointId: string;
    key: string;
  }) => `${input.companyId}:${input.endpointId}:${input.key}`;
  return {
    async compareAndSet(input) {
      const key = keyFor(input);
      const current = rows.get(key) ?? null;
      if ((current?.version ?? null) !== input.expectedVersion) return false;
      rows.set(key, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (current?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const key = keyFor(input);
      if (rows.get(key)?.version !== input.expectedVersion) return false;
      rows.delete(key);
      return true;
    },
    async read(scope, key) {
      return rows.get(keyFor({ ...scope, key })) ?? null;
    },
  };
}

describe("Chat SDK published adapter integration", () => {
  it("fails initialization when pinned Teams adapter internals drift", () => {
    expect(() => scopeMicrosoftTeamsEgress({} as never)).toThrowError(
      expect.objectContaining({
        name: "TeamsAdapterCompatibilityError",
        code: "CHAT_ADAPTER_COMPATIBILITY_ERROR",
      }),
    );
  });

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
      status: 403,
      description: "Forbidden: bot was blocked by the user",
      expected: { name: "PermissionError", code: "PERMISSION_DENIED" },
    },
    {
      status: 401,
      description: "Unauthorized",
      expected: { name: "AuthenticationError", code: "AUTH_FAILED" },
    },
  ])(
    "preserves Telegram Bot API $status as its scoped adapter error",
    async ({ description, expected, status }) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-telegram-errors",
        endpointId: `endpoint-telegram-${status}`,
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "telegram",
          userName: "paperclip_agent_bot",
          credentials: {
            botToken: "123:test",
            secretToken: "telegram-webhook-secret",
          },
        },
      });
      const adapter = runtime.getProviderAdapter() as unknown as {
        postMessage(
          threadId: string,
          message: { markdown: string },
        ): Promise<unknown>;
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: status, description }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        );
      try {
        await expect(
          adapter.postMessage("telegram:77112233", {
            markdown: "Safe Telegram response",
          }),
        ).rejects.toMatchObject({ adapter: "telegram", ...expected });
      } finally {
        globalThis.fetch = originalFetch;
        await runtime.shutdown();
      }
    },
  );

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

  it("isolates concurrent Teams sends by verified thread service URL", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-egress",
      endpointId: "endpoint-teams-egress",
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
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: {
        activitySender: {
          send: (
            activity: unknown,
            reference: { serviceUrl: string },
          ) => Promise<{ id: string }>;
        };
        api: { serviceUrl: string };
      };
      postMessage: (
        threadId: string,
        message: { markdown: string },
      ) => Promise<unknown>;
    };
    const originalApi = adapter.app.api;
    const observedServiceUrls: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstObserved!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      markFirstObserved = resolve;
    });
    let markSecondObserved!: () => void;
    const secondObserved = new Promise<void>((resolve) => {
      markSecondObserved = resolve;
    });
    adapter.app.activitySender.send = async (_activity, reference) => {
      observedServiceUrls.push(reference.serviceUrl);
      if (observedServiceUrls.length === 1) {
        markFirstObserved();
        await firstBlocked;
      } else if (observedServiceUrls.length === 2) {
        markSecondObserved();
      }
      return { id: "teams-outbound-1" };
    };
    const amerServiceUrl = "https://smba.trafficmanager.net/amer/";
    const emeaServiceUrl = "https://smba.trafficmanager.net/emea/";
    const amerThreadId = `teams:${Buffer.from("19:regional-thread@thread.tacv2;messageid=1729").toString("base64url")}:${Buffer.from(amerServiceUrl).toString("base64url")}:channel`;
    const emeaThreadId = `teams:${Buffer.from("19:second-region@thread.tacv2;messageid=1730").toString("base64url")}:${Buffer.from(emeaServiceUrl).toString("base64url")}:channel`;

    const first = adapter.postMessage(amerThreadId, {
      markdown: "Americas response",
    });
    await firstObserved;
    const second = adapter.postMessage(emeaThreadId, {
      markdown: "EMEA response",
    });
    await secondObserved;
    expect(observedServiceUrls).toEqual([
      "https://smba.trafficmanager.net/amer",
      "https://smba.trafficmanager.net/emea",
    ]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(observedServiceUrls).toEqual([
      "https://smba.trafficmanager.net/amer",
      "https://smba.trafficmanager.net/emea",
    ]);
    expect(adapter.app.api).toBe(originalApi);
  });

  it("scopes direct Teams edit, reaction, and delete API calls to sovereign service URLs", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-direct-api",
      endpointId: "endpoint-teams-direct-api",
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
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: { api: unknown };
      addReaction: (
        threadId: string,
        messageId: string,
        emoji: string,
      ) => Promise<void>;
      deleteMessage: (threadId: string, messageId: string) => Promise<void>;
      editMessage: (
        threadId: string,
        messageId: string,
        message: { markdown: string },
      ) => Promise<unknown>;
      removeReaction: (
        threadId: string,
        messageId: string,
        emoji: string,
      ) => Promise<void>;
    };
    const observed: Array<{ operation: string; serviceUrl: string }> = [];
    class InstrumentedApi {
      readonly conversations;
      readonly _apiClientSettings: unknown;
      readonly http: unknown;

      constructor(
        readonly serviceUrl: string,
        http: unknown,
        settings?: unknown,
      ) {
        this.http = http;
        this._apiClientSettings = settings;
        this.conversations = {
          activities: () => ({
            update: async () => {
              observed.push({ operation: "edit", serviceUrl });
            },
            delete: async () => {
              observed.push({ operation: "delete", serviceUrl });
            },
          }),
          addReaction: async () => {
            observed.push({ operation: "add-reaction", serviceUrl });
          },
          deleteReaction: async () => {
            observed.push({ operation: "remove-reaction", serviceUrl });
          },
        };
      }
    }
    adapter.app.api = new InstrumentedApi(
      "https://smba.trafficmanager.net/teams",
      {},
    );
    const gccHigh = "https://smba.infra.gov.teams.microsoft.us/teams";
    const dod = "https://smba.infra.dod.teams.microsoft.us/teams";
    const gccHighThread = `teams:${Buffer.from("19:gcc-high@thread.tacv2;messageid=2001").toString("base64url")}:${Buffer.from(gccHigh).toString("base64url")}:channel`;
    const dodThread = `teams:${Buffer.from("19:dod@thread.tacv2;messageid=2002").toString("base64url")}:${Buffer.from(dod).toString("base64url")}:channel`;

    await Promise.all([
      adapter.editMessage(gccHighThread, "2001", { markdown: "updated" }),
      adapter.addReaction(dodThread, "2002", "eyes"),
      adapter.removeReaction(gccHighThread, "2001", "eyes"),
      adapter.deleteMessage(dodThread, "2002"),
    ]);

    expect(observed).toEqual(
      expect.arrayContaining([
        { operation: "edit", serviceUrl: gccHigh },
        { operation: "add-reaction", serviceUrl: dod },
        { operation: "remove-reaction", serviceUrl: gccHigh },
        { operation: "delete", serviceUrl: dod },
      ]),
    );
    expect(observed).toHaveLength(4);
  });

  it("isolates concurrent Teams openDM calls by cached user service URL", async () => {
    const state = memoryPersistence();
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-open-dm",
      endpointId: "endpoint-teams-open-dm",
      logger: "silent",
      persistence: state,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "secret",
          appTenantId: "11111111-1111-1111-1111-111111111111",
          appType: "SingleTenant",
        },
      },
    });
    await runtime.handleWebhook(
      new Request("https://paperclip.test/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "initialize" }),
      }),
    );
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: { api: unknown };
      chat: {
        getState(): {
          set(key: string, value: string, ttlMs: number): Promise<void>;
        };
      };
      openDM(userId: string): Promise<string>;
    };
    const amer = "https://smba.trafficmanager.net/amer";
    const gcc = "https://smba.infra.gcc.teams.microsoft.com/teams";
    await Promise.all([
      adapter.chat
        .getState()
        .set("teams:serviceUrl:29:user-amer", amer, 60_000),
      adapter.chat.getState().set("teams:serviceUrl:29:user-gcc", gcc, 60_000),
    ]);
    const observedServiceUrls: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstObserved!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      markFirstObserved = resolve;
    });
    let markSecondObserved!: () => void;
    const secondObserved = new Promise<void>((resolve) => {
      markSecondObserved = resolve;
    });
    class InstrumentedOpenDmApi {
      readonly conversations;
      readonly _apiClientSettings: unknown;
      readonly http: unknown;

      constructor(
        readonly serviceUrl: string,
        http: unknown,
        settings?: unknown,
      ) {
        this.http = http;
        this._apiClientSettings = settings;
        this.conversations = {
          create: async () => {
            observedServiceUrls.push(serviceUrl);
            if (observedServiceUrls.length === 1) {
              markFirstObserved();
              await firstBlocked;
            } else if (observedServiceUrls.length === 2) {
              markSecondObserved();
            }
            return { id: `conversation-${observedServiceUrls.length}` };
          },
        };
      }
    }
    adapter.app.api = new InstrumentedOpenDmApi(
      "https://smba.trafficmanager.net/teams",
      {},
    );

    const first = adapter.openDM("29:user-amer");
    await firstObserved;
    const second = adapter.openDM("29:user-gcc");
    await secondObserved;
    expect(observedServiceUrls).toEqual([amer, gcc]);
    releaseFirst();
    const [amerThread, gccThread] = await Promise.all([first, second]);
    expect(amerThread).toContain(Buffer.from(amer).toString("base64url"));
    expect(gccThread).toContain(Buffer.from(gcc).toString("base64url"));
  });

  it("restores the Teams API client after a scoped outbound failure", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-egress-failure",
      endpointId: "endpoint-teams-egress-failure",
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
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: {
        activitySender: {
          send: () => Promise<never>;
        };
        api: { serviceUrl: string };
      };
      postMessage: (
        threadId: string,
        message: { markdown: string },
      ) => Promise<unknown>;
    };
    const originalApi = adapter.app.api;
    adapter.app.activitySender.send = async () => {
      throw new Error("simulated regional send failure");
    };
    const threadId = `teams:${Buffer.from("19:failed-thread@thread.tacv2;messageid=1730").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/emea/").toString("base64url")}:channel`;

    await expect(
      adapter.postMessage(threadId, { markdown: "Failure response" }),
    ).rejects.toThrow("simulated regional send failure");
    expect(adapter.app.api).toBe(originalApi);
  });

  it("rejects unsafe Teams thread service URLs before transport", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-egress-untrusted",
      endpointId: "endpoint-teams-egress-untrusted",
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
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: {
        activitySender: { send: () => Promise<{ id: string }> };
      };
      postMessage: (
        threadId: string,
        message: { markdown: string },
      ) => Promise<unknown>;
    };
    let transportCalled = false;
    adapter.app.activitySender.send = async () => {
      transportCalled = true;
      return { id: "unexpected" };
    };
    const unsafeServiceUrls = [
      "http://127.0.0.1:1234/internal",
      "https://127.0.0.1/internal",
      "https://smba.trafficmanager.net.attacker.example/teams",
      "https://smba.trafficmanager.net:8443/teams",
    ];
    for (const serviceUrl of unsafeServiceUrls) {
      const threadId = `teams:${Buffer.from("19:unsafe-thread@thread.tacv2").toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:channel`;
      await expect(
        adapter.postMessage(threadId, { markdown: "Do not send" }),
      ).rejects.toMatchObject({
        name: "TeamsServiceUrlValidationError",
        code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
      });
    }
    expect(transportCalled).toBe(false);
  });

  it("allows only the exact explicitly configured custom Teams API URL", async () => {
    const configuredApiUrl = "https://connector.example.test:8443/custom";
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-custom-api",
      endpointId: "endpoint-teams-custom-api",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          apiUrl: configuredApiUrl,
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "secret",
        },
      },
    });
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: {
        activitySender: {
          send: (
            activity: unknown,
            reference: { serviceUrl: string },
          ) => Promise<{ id: string }>;
        };
      };
      postMessage: (
        threadId: string,
        message: { markdown: string },
      ) => Promise<unknown>;
    };
    const observed: string[] = [];
    adapter.app.activitySender.send = async (_activity, reference) => {
      observed.push(reference.serviceUrl);
      return { id: "custom-api-message" };
    };
    const encodedConversation = Buffer.from(
      "19:custom-api@thread.tacv2",
    ).toString("base64url");
    const exactThread = `teams:${encodedConversation}:${Buffer.from(`${configuredApiUrl}/`).toString("base64url")}:channel`;
    const otherPathThread = `teams:${encodedConversation}:${Buffer.from("https://connector.example.test:8443/other").toString("base64url")}:channel`;

    await adapter.postMessage(exactThread, { markdown: "Configured route" });
    await expect(
      adapter.postMessage(otherPathThread, { markdown: "Wrong route" }),
    ).rejects.toMatchObject({
      code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
    });
    expect(observed).toEqual([configuredApiUrl]);
  });
});
