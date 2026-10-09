import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Attachment, Logger } from "chat";
import {
  createChatSdkEndpointRuntime,
  scopeMicrosoftTeamsEgress,
} from "./chat-sdk-runtime.js";
import type { ChatSdkRuntimeCallbacks } from "./chat-sdk-runtime.js";
import { splitTelegramPublicationText } from "./chat-publication-stream.js";
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

function capturingLogger(entries: unknown[]): Logger {
  const logger: Logger = {
    child() {
      return logger;
    },
    debug(message, ...args) {
      entries.push(["debug", message, ...args]);
    },
    error(message, ...args) {
      entries.push(["error", message, ...args]);
    },
    info(message, ...args) {
      entries.push(["info", message, ...args]);
    },
    warn(message, ...args) {
      entries.push(["warn", message, ...args]);
    },
  };
  return logger;
}

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

function signedSlackEventRequest(
  signingSecret: string,
  payload: Record<string, unknown>,
): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request(
    "https://paperclip.example/api/chat-webhooks/public/slack",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    },
  );
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

  it("bounds each GitHub API request with a fresh abort signal", async () => {
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return Response.json({ resources: {} });
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-github-timeout",
      endpointId: "endpoint-github-timeout",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "github",
        userName: "paperclip-agent[bot]",
        credentials: { token: "github_pat_test", webhookSecret: "secret" },
      },
    });
    try {
      const adapter = runtime.getProviderAdapter() as unknown as {
        octokit: { request(route: string): Promise<unknown> };
      };
      await adapter.octokit.request("GET /rate_limit");
      await adapter.octokit.request("GET /rate_limit");
      expect(providerFetch).toHaveBeenCalledTimes(2);
      const firstSignal = providerFetch.mock.calls[0]?.[1]?.signal;
      const secondSignal = providerFetch.mock.calls[1]?.[1]?.signal;
      expect(firstSignal).not.toBe(secondSignal);
    } finally {
      await runtime.shutdown();
      vi.unstubAllGlobals();
    }
  });

  it("bounds Telegram Bot API calls while preserving a caller abort signal", async () => {
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return Response.json({ ok: true, result: { id: 123 } });
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-telegram-timeout",
      endpointId: "endpoint-telegram-timeout",
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
    try {
      const adapter = runtime.getProviderAdapter() as unknown as {
        telegramFetch(
          method: string,
          payload?: Record<string, unknown>,
          request?: { signal?: AbortSignal },
        ): Promise<unknown>;
      };
      const caller = new AbortController();
      await adapter.telegramFetch("getMe", {}, { signal: caller.signal });
      const effectiveSignal = providerFetch.mock.calls[0]?.[1]?.signal;
      expect(effectiveSignal).not.toBe(caller.signal);
      caller.abort();
      expect(effectiveSignal?.aborted).toBe(true);
    } finally {
      await runtime.shutdown();
      vi.unstubAllGlobals();
    }
  });

  it("configures a bounded Teams HTTP client reused by scoped egress", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-timeout",
      endpointId: "endpoint-teams-timeout",
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
    try {
      const adapter = runtime.getProviderAdapter() as unknown as {
        app: {
          api: {
            http: {
              options?: { timeout?: number };
              http?: { defaults?: { timeout?: number } };
            };
          };
        };
      };
      expect(
        adapter.app.api.http.options?.timeout ??
          adapter.app.api.http.http?.defaults?.timeout,
      ).toBe(45_000);
    } finally {
      await runtime.shutdown();
    }
  });

  it("bounds adapter-owned Slack and Discord webhook fetches", async () => {
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return new Response("", { status: 200 });
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const slackRuntime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-fetch-timeout",
      endpointId: "endpoint-slack-fetch-timeout",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: { botToken: "xoxb-test", signingSecret: "secret" },
      },
    });
    const discordRuntime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-discord-fetch-timeout",
      endpointId: "endpoint-discord-fetch-timeout",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "discord",
        userName: "Paperclip Agent",
        credentials: {
          apiUrl: "https://discord.com/api/v10",
          applicationId: "123456789012345678",
          botToken: "discord-secret",
          guildId: "1457808928258658549",
        },
      },
    });
    try {
      const slack = slackRuntime.getProviderAdapter() as unknown as {
        forwardSocketEvent(
          webhookUrl: string,
          event: { body: { type: string } },
        ): Promise<void>;
        sendToResponseUrl(responseUrl: string, action: "delete"): Promise<void>;
      };
      const discord = discordRuntime.getProviderAdapter() as unknown as {
        forwardGatewayEvent(
          webhookUrl: string,
          event: { type: string },
        ): Promise<void>;
      };
      await slack.sendToResponseUrl("https://paperclip.test/slack", "delete");
      await slack.forwardSocketEvent("https://paperclip.test/slack", {
        body: { type: "events_api" },
      });
      await discord.forwardGatewayEvent("https://paperclip.test/discord", {
        type: "MESSAGE_CREATE",
      });
      expect(providerFetch).toHaveBeenCalledTimes(3);
    } finally {
      await Promise.all([slackRuntime.shutdown(), discordRuntime.shutdown()]);
      vi.unstubAllGlobals();
    }
  });

  it("refreshes an expired GitHub App installation token before a delayed send", async () => {
    const start = new Date("2026-09-05T12:00:00.000Z");
    vi.setSystemTime(start);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let tokenExchanges = 0;
    const commentAuthorizations: string[] = [];
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        );
        if (url.endsWith("/app/installations/2468/access_tokens")) {
          tokenExchanges += 1;
          return Response.json(
            {
              token: `ghs-installation-${tokenExchanges}`,
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
              permissions: { issues: "write", pull_requests: "write" },
              repository_selection: "selected",
            },
            { status: 201 },
          );
        }
        if (url.endsWith("/repos/paperclipai/chat-e2e/issues/42/comments")) {
          commentAuthorizations.push(headers.get("authorization") ?? "");
          return Response.json(
            {
              id: 9_000 + commentAuthorizations.length,
              body: "safe reply",
              user: { id: 9001, login: "maya-paperclip[bot]", type: "Bot" },
            },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected GitHub provider request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-github-token-refresh",
      endpointId: "endpoint-github-token-refresh",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "github",
        userName: "maya-paperclip[bot]",
        credentials: {
          appId: "123456",
          botUserId: 9001,
          installationId: 2468,
          privateKey,
          webhookSecret: "github-webhook-secret",
        },
      },
    });
    const adapter = runtime.getProviderAdapter() as unknown as {
      postMessage(
        threadId: string,
        message: { markdown: string },
      ): Promise<{ id: string }>;
    };
    try {
      await adapter.postMessage("github:paperclipai/chat-e2e:issue:42", {
        markdown: "first safe reply",
      });
      vi.setSystemTime(new Date(start.getTime() + 61 * 60_000));
      await adapter.postMessage("github:paperclipai/chat-e2e:issue:42", {
        markdown: "delayed safe reply",
      });

      expect(tokenExchanges).toBe(2);
      expect(commentAuthorizations).toHaveLength(2);
      expect(commentAuthorizations[0]).toContain("ghs-installation-1");
      expect(commentAuthorizations[1]).toContain("ghs-installation-2");
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("preserves the pinned Slack Block Kit callback's clicked-message thread id", async () => {
    const signingSecret = "slack-action-signing-secret";
    const onAction = vi.fn();
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onAction, onMessage() {} },
      companyId: "company-slack-action-envelope",
      endpointId: "endpoint-slack-action-envelope",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret,
        },
      },
    });
    const payload = {
      type: "block_actions",
      team: { id: "T-PAPERCLIP" },
      user: { id: "U-OPERATOR", username: "operator" },
      channel: { id: "D-PAPERCLIP-DM" },
      container: {
        type: "message",
        channel_id: "D-PAPERCLIP-DM",
        message_ts: "1788.200",
      },
      message: { ts: "1788.200" },
      actions: [{ action_id: "pcq:blue", value: "interaction-id" }],
      trigger_id: "trigger-id",
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    try {
      await runtime.initialize();
      const response = await runtime.handleWebhook(
        new Request(
          "https://paperclip.example/api/chat-webhooks/public/slack",
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": signature,
            },
            body,
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(onAction).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "slack",
          event: expect.objectContaining({
            actionId: "pcq:blue",
            messageId: "1788.200",
            threadId: "slack:D-PAPERCLIP-DM:1788.200",
            value: "interaction-id",
          }),
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("acknowledges a signed Slack slash command without a blocking profile lookup", async () => {
    const signingSecret = "slack-slash-signing-secret";
    const onSlashCommand = vi.fn(async () => undefined);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {}, onSlashCommand },
      companyId: "company-slack-slash-ack",
      endpointId: "endpoint-slack-slash-ack",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret,
        },
      },
    });
    const body = new URLSearchParams({
      channel_id: "C-PAPERCLIP",
      command: "/paperclip-agent",
      team_id: "T-PAPERCLIP",
      text: "investigate the release",
      trigger_id: "slash-trigger",
      user_id: "U-OPERATOR",
      user_name: "operator",
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: { users: { info(input: unknown): Promise<unknown> } };
      };
      const usersInfo = vi.fn(
        async () =>
          await new Promise<never>(() => {
            // A regression to the upstream cold lookup would hold the provider
            // acknowledgement open until Paperclip's webhook deadline.
          }),
      );
      adapter._client.users.info = usersInfo;
      const response = await Promise.race([
        runtime.handleWebhook(
          new Request(
            "https://paperclip.example/api/chat-webhooks/public/slack",
            {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-slack-request-timestamp": timestamp,
                "x-slack-signature": signature,
              },
              body,
            },
          ),
        ),
        new Promise<"timed_out">((resolve) =>
          setTimeout(() => resolve("timed_out"), 250),
        ),
      ]);
      expect(response).not.toBe("timed_out");
      expect((response as Response).status).toBe(200);
      await expect((response as Response).json()).resolves.toEqual({
        response_type: "ephemeral",
        text: "Paperclip received this command.",
      });
      expect(usersInfo).not.toHaveBeenCalled();
      expect(onSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "slack",
          event: expect.objectContaining({
            command: "/paperclip-agent",
            text: "investigate the release",
            user: expect.objectContaining({
              userId: "U-OPERATOR",
              userName: "operator",
              fullName: "operator",
            }),
          }),
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("parses signed Slack message edits and deletes through the pinned adapter", async () => {
    const signingSecret = "slack-lifecycle-signing-secret";
    const onMessageUpdated = vi.fn(async () => undefined);
    const onMessageDeleted = vi.fn(async () => undefined);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: {
        onMessage() {},
        onMessageDeleted,
        onMessageUpdated,
      },
      companyId: "company-slack-lifecycle-envelope",
      endpointId: "endpoint-slack-lifecycle-envelope",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret,
        },
      },
    });
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          users: {
            info(input: unknown): Promise<unknown>;
          };
        };
      };
      adapter._client.users.info = vi.fn(async () => ({
        ok: true,
        user: {
          id: "U-OPERATOR",
          name: "operator",
          real_name: "Operator",
          is_bot: false,
          profile: { display_name: "operator", real_name: "Operator" },
        },
      }));
      const previousMessage = {
        type: "message",
        user: "U-OPERATOR",
        text: "@paperclip-agent original request",
        ts: "1788.500",
        thread_ts: "1788.400",
      };

      const edited = await runtime.handleWebhook(
        signedSlackEventRequest(signingSecret, {
          type: "event_callback",
          team_id: "T-PAPERCLIP",
          event_id: "Ev-slack-edit",
          event: {
            type: "message",
            subtype: "message_changed",
            channel: "C-PAPERCLIP",
            channel_type: "channel",
            event_ts: "1788.600",
            message: {
              ...previousMessage,
              text: "@paperclip-agent corrected request",
              edited: { user: "U-OPERATOR", ts: "1788.600" },
            },
            previous_message: previousMessage,
          },
        }),
      );
      expect(edited.status).toBe(200);
      expect(onMessageUpdated).toHaveBeenCalledOnce();
      expect(onMessageUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          endpointId: "endpoint-slack-lifecycle-envelope",
          provider: "slack",
          thread: expect.objectContaining({
            id: "slack:C-PAPERCLIP:1788.400",
          }),
          message: expect.objectContaining({
            id: "1788.500",
            text: expect.stringContaining("corrected request"),
          }),
          previousMessage: expect.objectContaining({
            id: "1788.500",
            text: expect.stringContaining("original request"),
          }),
        }),
      );

      const deleted = await runtime.handleWebhook(
        signedSlackEventRequest(signingSecret, {
          type: "event_callback",
          team_id: "T-PAPERCLIP",
          event_id: "Ev-slack-delete",
          event: {
            type: "message",
            subtype: "message_deleted",
            channel: "C-PAPERCLIP",
            channel_type: "channel",
            deleted_ts: "1788.500",
            event_ts: "1788.700",
            previous_message: previousMessage,
          },
        }),
      );
      expect(deleted.status).toBe(200);
      expect(onMessageDeleted).toHaveBeenCalledOnce();
      expect(onMessageDeleted).toHaveBeenCalledWith(
        expect.objectContaining({
          endpointId: "endpoint-slack-lifecycle-envelope",
          provider: "slack",
          event: expect.objectContaining({
            channelId: "C-PAPERCLIP",
            messageId: "1788.500",
            threadId: "slack:C-PAPERCLIP:1788.400",
          }),
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  describe("signed Slack file-only message changes", () => {
    const firstFile = {
      id: "F-FIRST",
      name: "first.png",
      mimetype: "image/png",
      size: 128,
      original_w: 16,
      original_h: 8,
      url_private: "https://files.slack.com/files-pri/T-TEST/F-FIRST/first.png",
    };
    const secondFile = {
      ...firstFile,
      id: "F-SECOND",
      name: "second.png",
      url_private:
        "https://files.slack.com/files-pri/T-TEST/F-SECOND/second.png",
    };
    const unchangedFiles = [firstFile, secondFile];
    const cases = [
      { name: "removal", files: [secondFile], changed: true },
      { name: "removal of all files", files: [], changed: true },
      { name: "removal with files omitted", files: undefined, changed: true },
      {
        name: "first file addition",
        previousFiles: [],
        files: [firstFile],
        changed: true,
      },
      {
        name: "absent versus empty files",
        previousFiles: [],
        files: undefined,
        changed: false,
      },
      {
        name: "addition",
        files: [...unchangedFiles, { ...firstFile, id: "F-THIRD" }],
        changed: true,
      },
      {
        name: "replacement ID",
        files: [{ ...firstFile, id: "F-REPLACEMENT" }, secondFile],
        changed: true,
      },
      { name: "reordering", files: [secondFile, firstFile], changed: true },
      {
        name: "name change",
        files: [{ ...firstFile, name: "renamed.png" }, secondFile],
        changed: true,
      },
      {
        name: "MIME type change",
        files: [{ ...firstFile, mimetype: "application/pdf" }, secondFile],
        changed: true,
      },
      {
        name: "size change",
        files: [{ ...firstFile, size: 256 }, secondFile],
        changed: true,
      },
      {
        name: "width change",
        files: [{ ...firstFile, original_w: 32 }, secondFile],
        changed: true,
      },
      {
        name: "height change",
        files: [{ ...firstFile, original_h: 32 }, secondFile],
        changed: true,
      },
      {
        name: "non-hidden removal",
        files: [secondFile],
        changed: true,
        hidden: false,
      },
      {
        name: "identical files",
        files: unchangedFiles.map((file) => ({ ...file })),
        changed: false,
      },
      {
        name: "private URL rotation",
        files: [
          { ...firstFile, url_private: `${firstFile.url_private}?rotation=2` },
          secondFile,
        ],
        changed: false,
      },
      {
        name: "unused title change",
        files: [{ ...firstFile, title: "Different preview title" }, secondFile],
        changed: false,
      },
      {
        name: "unfurl-only update",
        files: unchangedFiles,
        changed: false,
        unfurl: true,
      },
      {
        name: "invalid webhook signature",
        files: [secondFile],
        changed: false,
        invalidSignature: true,
      },
    ];

    it.each(cases)(
      "handles $name without changing text or edit time",
      async (testCase) => {
        const signingSecret = "slack-file-lifecycle-signing-secret";
        const onMessage = vi.fn<ChatSdkRuntimeCallbacks["onMessage"]>(
          async () => undefined,
        );
        const onMessageUpdated = vi.fn<
          NonNullable<ChatSdkRuntimeCallbacks["onMessageUpdated"]>
        >(async () => undefined);
        const onMessageDeleted = vi.fn(async () => undefined);
        const runtime = createChatSdkEndpointRuntime({
          callbacks: { onMessage, onMessageUpdated, onMessageDeleted },
          companyId: "company-slack-file-lifecycle",
          endpointId: "endpoint-slack-file-lifecycle",
          logger: "silent",
          persistence: memoryPersistence(),
          providerConfig: {
            provider: "slack",
            userName: "paperclip-agent",
            credentials: {
              botToken: "xoxb-test",
              botUserId: "U-PAPERCLIP-BOT",
              signingSecret,
            },
          },
        });
        const providerFetch = vi.fn(async () => {
          throw new Error(
            "Slack file lifecycle intake must not download files",
          );
        });
        vi.stubGlobal("fetch", providerFetch);
        const adapter = runtime.getProviderAdapter() as unknown as {
          _client: { apiCall(...args: unknown[]): Promise<unknown> };
        };
        const providerApi = vi
          .spyOn(adapter._client, "apiCall")
          .mockRejectedValue(
            new Error(
              "Slack file lifecycle intake must not call provider APIs",
            ),
          );
        try {
          await runtime.initialize();
          const previousMessage = {
            type: "message",
            user: "U-OPERATOR",
            username: "operator",
            text: "Please inspect the attached images.",
            ts: "1788.500",
            thread_ts: "1788.400",
            edited: { user: "U-OPERATOR", ts: "1788.600" },
            files: testCase.previousFiles ?? unchangedFiles,
          };
          const response = await runtime.handleWebhook(
            signedSlackEventRequest(
              testCase.invalidSignature
                ? "wrong-signing-secret"
                : signingSecret,
              {
                type: "event_callback",
                team_id: "T-PAPERCLIP",
                event_id: "Ev-slack-files-only",
                event: {
                  type: "message",
                  subtype: "message_changed",
                  hidden: testCase.hidden ?? true,
                  channel: "C-PAPERCLIP",
                  channel_type: "channel",
                  event_ts: "1788.700",
                  message: {
                    ...previousMessage,
                    files: testCase.files,
                    ...(testCase.unfurl
                      ? {
                          attachments: [
                            {
                              from_url: "https://example.com",
                              title: "Preview only",
                            },
                          ],
                        }
                      : {}),
                  },
                  previous_message: previousMessage,
                },
              },
            ),
          );
          expect(response.status).toBe(testCase.invalidSignature ? 401 : 200);
          expect(onMessageUpdated).toHaveBeenCalledTimes(
            testCase.changed ? 1 : 0,
          );
          expect(onMessage).not.toHaveBeenCalled();
          expect(onMessageDeleted).not.toHaveBeenCalled();
          expect(providerApi).not.toHaveBeenCalled();
          expect(providerFetch).not.toHaveBeenCalled();
          if (testCase.changed) {
            const update = onMessageUpdated.mock.calls[0]![0];
            expect(update.provider).toBe("slack");
            expect(update.thread.id).toBe("slack:C-PAPERCLIP:1788.400");
            expect(update.message.id).toBe(previousMessage.ts);
            expect(update.message.text).toBe(previousMessage.text);
            expect(update.message.metadata.editedAt).toEqual(
              new Date(1788.6 * 1_000),
            );
            expect((update.message.raw as { files?: unknown }).files).toEqual(
              testCase.files,
            );
            expect(update.previousMessage?.raw).toEqual(
              expect.objectContaining({ files: previousMessage.files }),
            );
            expect(update.message.attachments).toHaveLength(
              testCase.files?.length ?? 0,
            );
            expect(update.previousMessage?.attachments).toHaveLength(
              previousMessage.files.length,
            );
            for (const [index, file] of (testCase.files ?? []).entries()) {
              expect(update.message.attachments[index]).toEqual(
                expect.objectContaining({
                  name: file.name,
                  mimeType: file.mimetype,
                  size: file.size,
                  width: file.original_w,
                  height: file.original_h,
                }),
              );
            }
          }
        } finally {
          await runtime.shutdown();
          providerApi.mockRestore();
          vi.unstubAllGlobals();
        }
      },
    );
  });

  it("parses signed Slack reaction add and remove events through the pinned adapter", async () => {
    const signingSecret = "slack-reaction-signing-secret";
    const onReaction = vi.fn<
      NonNullable<ChatSdkRuntimeCallbacks["onReaction"]>
    >(async () => undefined);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {}, onReaction },
      companyId: "company-slack-reaction-envelope",
      endpointId: "endpoint-slack-reaction-envelope",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret,
        },
      },
    });
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          conversations: {
            replies(input: unknown): Promise<unknown>;
          };
          users: {
            info(input: unknown): Promise<unknown>;
          };
        };
      };
      adapter._client.conversations.replies = vi.fn(async () => ({
        ok: true,
        messages: [{ ts: "1788.500", thread_ts: "1788.400" }],
      }));
      adapter._client.users.info = vi.fn(async () => ({
        ok: true,
        user: {
          id: "U-OPERATOR",
          name: "operator",
          real_name: "Operator",
          is_bot: false,
          profile: { display_name: "operator", real_name: "Operator" },
        },
      }));

      for (const [type, eventTs] of [
        ["reaction_added", "1788.800"],
        ["reaction_removed", "1788.900"],
      ] as const) {
        const response = await runtime.handleWebhook(
          signedSlackEventRequest(signingSecret, {
            type: "event_callback",
            team_id: "T-PAPERCLIP",
            event_id: `Ev-slack-${type}`,
            event: {
              type,
              user: "U-OPERATOR",
              reaction: "eyes",
              item: {
                type: "message",
                channel: "C-PAPERCLIP",
                ts: "1788.500",
              },
              event_ts: eventTs,
            },
          }),
        );
        expect(response.status).toBe(200);
      }
      expect(onReaction).toHaveBeenCalledTimes(2);
      expect(onReaction.mock.calls.map(([callback]) => callback)).toEqual([
        expect.objectContaining({
          endpointId: "endpoint-slack-reaction-envelope",
          provider: "slack",
          event: expect.objectContaining({
            added: true,
            messageId: "1788.500",
            rawEmoji: "eyes",
            threadId: "slack:C-PAPERCLIP:1788.400",
          }),
        }),
        expect.objectContaining({
          endpointId: "endpoint-slack-reaction-envelope",
          provider: "slack",
          event: expect.objectContaining({
            added: false,
            messageId: "1788.500",
            rawEmoji: "eyes",
            threadId: "slack:C-PAPERCLIP:1788.400",
          }),
        }),
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("falls back from unavailable Slack native streaming to bounded post and edit", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-stream-fallback",
      endpointId: "endpoint-slack-stream-fallback",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "slack-stream-signing-secret",
        },
      },
    });
    try {
      await runtime.initialize();
      const nativeAppend = vi.fn(async () => {
        throw Object.assign(new Error("native streaming unavailable"), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "unknown_method" },
        });
      });
      const nativeStop = vi.fn(async () => ({ ok: true, ts: "1788.999" }));
      const chatStream = vi.fn(() => ({
        append: nativeAppend,
        stop: nativeStop,
      }));
      const postMessage = vi.fn(async () => ({
        ok: true,
        channel: "D-PAPERCLIP",
        ts: "1788.901",
      }));
      const update = vi.fn(async () => ({
        ok: true,
        channel: "D-PAPERCLIP",
        ts: "1788.901",
      }));
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: {
            postMessage: typeof postMessage;
            update: typeof update;
          };
          chatStream: typeof chatStream;
        };
        endTyping(threadId: string): Promise<void>;
        stream(
          threadId: string,
          chunks: AsyncIterable<string>,
          options: {
            recipientTeamId: string;
            recipientUserId: string;
            updateIntervalMs: number;
          },
        ): Promise<{ id: string } | null>;
      };
      adapter._client.chatStream = chatStream;
      adapter._client.chat.postMessage = postMessage;
      adapter._client.chat.update = update;
      adapter.endTyping = vi.fn(async () => undefined);
      const chunks = async function* () {
        yield "First safe paragraph.\n\n";
        yield "Second safe paragraph.";
      };

      const sent = await adapter.stream(
        "slack:D-PAPERCLIP:1788.400",
        chunks(),
        {
          recipientTeamId: "T-PAPERCLIP",
          recipientUserId: "U-OPERATOR",
          updateIntervalMs: 0,
        },
      );

      expect(sent?.id).toBe("1788.901");
      expect(chatStream).toHaveBeenCalledOnce();
      expect(nativeAppend).toHaveBeenCalledOnce();
      expect(nativeStop).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "First safe paragraph.\n\n" }),
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "First safe paragraph.\n\nSecond safe paragraph.",
          ts: "1788.901",
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("uses one Slack provider call for a file-only publication", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-only",
      endpointId: "endpoint-slack-file-only",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [
        {
          ok: true,
          files: [
            {
              id: "FPAPERCLIP",
              shares: {
                public: {
                  "C-PAPERCLIP": [{ thread_ts: "1788.300", ts: "1788.302" }],
                },
              },
            },
          ],
        },
      ],
    }));
    const fileInfo = vi.fn();
    const postMessage = vi.fn(async () => ({ ok: true, ts: "1788.301" }));
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: { info: typeof fileInfo; uploadV2: typeof uploadV2 };
        };
        postMessage(
          threadId: string,
          message: {
            files: Array<{ data: Buffer; filename: string; mimeType: string }>;
            markdown: string;
          },
        ): Promise<{ id: string }>;
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      const sent = await adapter.postMessage("slack:C-PAPERCLIP:1788.300", {
        markdown: "",
        files: [
          {
            data: Buffer.from("safe artifact"),
            filename: "result.txt",
            mimeType: "text/plain",
          },
        ],
      });
      expect(sent.id).toBe("1788.302");
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: "C-PAPERCLIP",
          thread_ts: "1788.300",
          file_uploads: [expect.objectContaining({ filename: "result.txt" })],
        }),
      );
      expect(fileInfo).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it("resolves a sparse Slack upload response to its exact private thread share", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-identity",
      endpointId: "endpoint-slack-file-identity",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "FSPARSE" }] }],
    }));
    const fileInfo = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        file: { id: "FSPARSE", shares: {} },
      })
      .mockResolvedValueOnce({
        ok: true,
        file: {
          id: "FSPARSE",
          shares: {
            private: {
              "D-PAPERCLIP": [{ thread_ts: "1788.400", ts: "1788.401" }],
            },
          },
        },
      });
    const postMessage = vi.fn();
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
        postMessage(
          threadId: string,
          message: {
            files: Array<{ data: Buffer; filename: string; mimeType: string }>;
            markdown: string;
          },
        ): Promise<{ id: string }>;
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      vi.useFakeTimers();
      const sentPromise = adapter.postMessage("slack:D-PAPERCLIP:1788.400", {
        markdown: "",
        files: [
          {
            data: Buffer.from("safe artifact"),
            filename: "result.txt",
            mimeType: "text/plain",
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(100);
      const sent = await sentPromise;
      expect(sent.id).toBe("1788.401");
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(fileInfo).toHaveBeenCalledTimes(2);
      expect(fileInfo).toHaveBeenCalledWith(
        expect.objectContaining({ file: "FSPARSE" }),
      );
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await runtime.shutdown();
    }
  });

  it("records accepted Slack file IDs before the share lookup and preserves Thread.post", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-receipt",
      endpointId: "endpoint-slack-file-receipt",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "FRECEIPT1" }] }],
    }));
    const fileInfo = vi.fn(async () => ({
      ok: true,
      file: {
        id: "FRECEIPT1",
        shares: {
          public: {
            "C-PAPERCLIP": [{ thread_ts: "1788.410", ts: "1788.411" }],
          },
        },
      },
    }));
    const postMessage = vi.fn();
    let releaseReceipt!: () => void;
    const receiptReleased = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    let receiptEntered!: () => void;
    const receiptAccepted = new Promise<void>((resolve) => {
      receiptEntered = resolve;
    });
    const onUploadAccepted = vi.fn(async () => {
      receiptEntered();
      await receiptReleased;
    });
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      const sentPromise = runtime.postSlackFilePublication(
        "slack:C-PAPERCLIP:1788.410",
        {
          files: [
            {
              data: Buffer.from("safe artifact"),
              filename: "result.txt",
              mimeType: "text/plain",
            },
          ],
          markdown: "",
        },
        onUploadAccepted,
      );
      await receiptAccepted;
      expect(onUploadAccepted).toHaveBeenCalledWith({
        version: 1,
        channelId: "C-PAPERCLIP",
        fileIds: ["FRECEIPT1"],
        threadTs: "1788.410",
      });
      expect(fileInfo).not.toHaveBeenCalled();
      releaseReceipt();
      await expect(sentPromise).resolves.toMatchObject({
        id: "1788.411",
        threadId: "slack:C-PAPERCLIP:1788.410",
        edit: expect.any(Function),
        addReaction: expect.any(Function),
        toJSON: expect.any(Function),
      });
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(fileInfo).toHaveBeenCalledOnce();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      releaseReceipt();
      await runtime.shutdown();
    }
  });

  it("isolates concurrent Slack upload receipt callbacks and restores the ordinary post context", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-concurrent",
      endpointId: "endpoint-slack-file-concurrent",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const uploadV2 = vi.fn(async (args: { thread_ts?: string }) => {
      const first = args.thread_ts === "1788.430";
      const second = args.thread_ts === "1788.440";
      if (first) await firstReleased;
      if (second) await secondReleased;
      return {
        ok: true,
        files: [
          {
            ok: true,
            files: [
              {
                id: first ? "FFIRST" : second ? "FSECOND" : "FORDINARY",
                shares: {
                  public: {
                    "C-PAPERCLIP": [
                      {
                        thread_ts: args.thread_ts,
                        ts: first
                          ? "1788.431"
                          : second
                            ? "1788.441"
                            : "1788.451",
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      };
    });
    const fileInfo = vi.fn();
    const postMessage = vi.fn();
    const firstCallback = vi.fn(async () => undefined);
    const secondCallback = vi.fn(async () => undefined);
    const message = {
      files: [
        {
          data: Buffer.from("safe artifact"),
          filename: "result.txt",
          mimeType: "text/plain",
        },
      ],
      markdown: "",
    };
    const pending: Array<Promise<{ id: string }>> = [];
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: { info: typeof fileInfo; uploadV2: typeof uploadV2 };
        };
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      const first = runtime.postSlackFilePublication(
        "slack:C-PAPERCLIP:1788.430",
        message,
        firstCallback,
      );
      const second = runtime.postSlackFilePublication(
        "slack:C-PAPERCLIP:1788.440",
        message,
        secondCallback,
      );
      pending.push(first, second);
      await vi.waitFor(() => expect(uploadV2).toHaveBeenCalledTimes(2));

      // Complete in reverse order while both asynchronous contexts are live.
      releaseSecond();
      await expect(second).resolves.toMatchObject({ id: "1788.441" });
      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        channelId: "C-PAPERCLIP",
        threadTs: "1788.440",
        fileIds: ["FSECOND"],
      });
      releaseFirst();
      await expect(first).resolves.toMatchObject({ id: "1788.431" });
      expect(firstCallback).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        channelId: "C-PAPERCLIP",
        threadTs: "1788.430",
        fileIds: ["FFIRST"],
      });

      await expect(
        runtime.thread("slack:C-PAPERCLIP:1788.450").post(message),
      ).resolves.toMatchObject({ id: "1788.451" });
      expect(firstCallback).toHaveBeenCalledOnce();
      expect(secondCallback).toHaveBeenCalledOnce();
      expect(uploadV2).toHaveBeenCalledTimes(3);
      expect(fileInfo).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled(pending);
      await runtime.shutdown();
    }
  });

  it.each(["receipt write", "malformed accepted ID"])(
    "does not repeat a Slack upload or look up shares after a failed %s",
    async (failure) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-slack-file-callback-failure",
        endpointId: "endpoint-slack-file-callback-failure",
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "slack",
          userName: "paperclip-agent",
          credentials: {
            botToken: "xoxb-test",
            botUserId: "U-PAPERCLIP-BOT",
            signingSecret: "secret",
          },
        },
      });
      const uploadV2 = vi.fn(async () => ({
        ok: true,
        files: [
          {
            ok: true,
            files: [
              {
                id:
                  failure === "receipt write" ? "FACCEPTED" : "invalid-file-id",
              },
            ],
          },
        ],
      }));
      const fileInfo = vi.fn();
      const postMessage = vi.fn();
      const onUploadAccepted = vi.fn(async () => {
        throw new Error("receipt persistence failed");
      });
      try {
        await runtime.initialize();
        const adapter = runtime.getProviderAdapter() as unknown as {
          _client: {
            chat: { postMessage: typeof postMessage };
            files: { info: typeof fileInfo; uploadV2: typeof uploadV2 };
          };
        };
        adapter._client.files.uploadV2 = uploadV2;
        adapter._client.files.info = fileInfo;
        adapter._client.chat.postMessage = postMessage;
        await expect(
          runtime.postSlackFilePublication(
            "slack:C-PAPERCLIP:1788.460",
            {
              files: [
                {
                  data: Buffer.from("safe artifact"),
                  filename: "result.txt",
                  mimeType: "text/plain",
                },
              ],
              markdown: "",
            },
            onUploadAccepted,
          ),
        ).rejects.toThrow();
        expect(uploadV2).toHaveBeenCalledOnce();
        expect(onUploadAccepted).toHaveBeenCalledTimes(
          failure === "receipt write" ? 1 : 0,
        );
        expect(fileInfo).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("resolves a captured Slack file receipt with metadata reads only", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-recovery",
      endpointId: "endpoint-slack-file-recovery",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn();
    const fileInfo = vi.fn(async () => ({
      ok: true,
      file: {
        id: "FRECOVERY1",
        shares: {
          public: {
            "C-PAPERCLIP": [{ thread_ts: "1788.420", ts: "1788.421" }],
          },
        },
      },
    }));
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      await expect(
        runtime.resolveSlackFileUploadReceipt("slack:C-PAPERCLIP:1788.420", [
          "FRECOVERY1",
        ]),
      ).resolves.toBe("1788.421");
      expect(fileInfo).toHaveBeenCalledOnce();
      expect(uploadV2).not.toHaveBeenCalled();
      await expect(
        runtime.resolveSlackFileUploadReceipt("slack:C-PAPERCLIP:1788.420", [
          "not-a-slack-file-id",
        ]),
      ).rejects.toMatchObject({ name: "ValidationError" });
      expect(fileInfo).toHaveBeenCalledOnce();
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects a Slack file upload whose provider message identity stays ambiguous", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-ambiguous",
      endpointId: "endpoint-slack-file-ambiguous",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "FAMBIGUOUS" }] }],
    }));
    const fileInfo = vi.fn(async () => ({
      ok: true,
      file: {
        id: "FAMBIGUOUS",
        shares: {
          public: {
            "C-OTHER": [{ ts: "1788.501" }],
          },
        },
      },
    }));
    const postMessage = vi.fn();
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
        postMessage(
          threadId: string,
          message: {
            files: Array<{ data: Buffer; filename: string; mimeType: string }>;
            markdown: string;
          },
        ): Promise<{ id: string }>;
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      vi.useFakeTimers();
      const rejected = expect(
        adapter.postMessage("slack:C-PAPERCLIP:1788.500", {
          markdown: "",
          files: [
            {
              data: Buffer.from("safe artifact"),
              filename: "result.txt",
              mimeType: "text/plain",
            },
          ],
        }),
      ).rejects.toMatchObject({
        message:
          "Slack file upload completed, but its message identity could not be confirmed",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(fileInfo).toHaveBeenCalledTimes(8);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await runtime.shutdown();
    }
  });

  it("bounds a stalled Slack file identity lookup without uploading again", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-timeout",
      endpointId: "endpoint-slack-file-timeout",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "FTIMEOUT" }] }],
    }));
    const fileInfo = vi.fn(() => new Promise<never>(() => undefined));
    const postMessage = vi.fn();
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
        postMessage(
          threadId: string,
          message: {
            files: Array<{ data: Buffer; filename: string; mimeType: string }>;
            markdown: string;
          },
        ): Promise<{ id: string }>;
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      vi.useFakeTimers();
      const rejected = expect(
        adapter.postMessage("slack:C-PAPERCLIP:1788.700", {
          markdown: "",
          files: [
            {
              data: Buffer.from("safe artifact"),
              filename: "result.txt",
              mimeType: "text/plain",
            },
          ],
        }),
      ).rejects.toMatchObject({
        message:
          "Slack file upload completed, but its message identity could not be confirmed",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(fileInfo).toHaveBeenCalledOnce();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await runtime.shutdown();
    }
  });

  it("does not start a Slack file lookup after token resolution exceeds the deadline", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-slack-file-late-token",
      endpointId: "endpoint-slack-file-late-token",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          botToken: "xoxb-test",
          botUserId: "U-PAPERCLIP-BOT",
          signingSecret: "secret",
        },
      },
    });
    const uploadV2 = vi.fn(async () => ({
      ok: true,
      files: [{ ok: true, files: [{ id: "FLATETOKEN" }] }],
    }));
    const fileInfo = vi.fn();
    const postMessage = vi.fn();
    try {
      await runtime.initialize();
      const adapter = runtime.getProviderAdapter() as unknown as {
        _client: {
          chat: { postMessage: typeof postMessage };
          files: {
            info: typeof fileInfo;
            uploadV2: typeof uploadV2;
          };
        };
        postMessage(
          threadId: string,
          message: {
            files: Array<{ data: Buffer; filename: string; mimeType: string }>;
            markdown: string;
          },
        ): Promise<{ id: string }>;
        withToken<T extends object>(input: T): Promise<T>;
      };
      adapter._client.files.uploadV2 = uploadV2;
      adapter._client.files.info = fileInfo;
      adapter._client.chat.postMessage = postMessage;
      vi.useFakeTimers();
      adapter.withToken = async <T extends object>(input: T): Promise<T> => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return input;
      };
      const rejected = expect(
        adapter.postMessage("slack:C-PAPERCLIP:1788.800", {
          markdown: "",
          files: [
            {
              data: Buffer.from("safe artifact"),
              filename: "result.txt",
              mimeType: "text/plain",
            },
          ],
        }),
      ).rejects.toMatchObject({
        message:
          "Slack file upload completed, but its message identity could not be confirmed",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(uploadV2).toHaveBeenCalledOnce();
      expect(fileInfo).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fileInfo).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await runtime.shutdown();
    }
  });

  it.each([
    {
      caseName: "omits the requested file",
      infoResult: { ok: true },
    },
    {
      caseName: "returns a different file",
      infoResult: {
        ok: true,
        file: {
          id: "FOTHER",
          shares: {
            public: {
              "C-PAPERCLIP": [{ thread_ts: "1788.600", ts: "1788.601" }],
            },
          },
        },
      },
    },
  ])(
    "rejects a Slack file identity lookup that $caseName",
    async ({ caseName, infoResult }) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: `company-slack-file-${caseName}`,
        endpointId: `endpoint-slack-file-${caseName}`,
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "slack",
          userName: "paperclip-agent",
          credentials: {
            botToken: "xoxb-test",
            botUserId: "U-PAPERCLIP-BOT",
            signingSecret: "secret",
          },
        },
      });
      const uploadV2 = vi.fn(async () => ({
        ok: true,
        files: [{ ok: true, files: [{ id: "FEXPECTED" }] }],
      }));
      const fileInfo = vi.fn(async () => infoResult);
      const postMessage = vi.fn();
      try {
        await runtime.initialize();
        const adapter = runtime.getProviderAdapter() as unknown as {
          _client: {
            chat: { postMessage: typeof postMessage };
            files: {
              info: typeof fileInfo;
              uploadV2: typeof uploadV2;
            };
          };
          postMessage(
            threadId: string,
            message: {
              files: Array<{
                data: Buffer;
                filename: string;
                mimeType: string;
              }>;
              markdown: string;
            },
          ): Promise<{ id: string }>;
        };
        adapter._client.files.uploadV2 = uploadV2;
        adapter._client.files.info = fileInfo;
        adapter._client.chat.postMessage = postMessage;
        await expect(
          adapter.postMessage("slack:C-PAPERCLIP:1788.600", {
            markdown: "",
            files: [
              {
                data: Buffer.from("safe artifact"),
                filename: "result.txt",
                mimeType: "text/plain",
              },
            ],
          }),
        ).rejects.toMatchObject({
          message:
            "Slack file upload completed, but its message identity could not be confirmed",
        });
        expect(fileInfo).toHaveBeenCalledOnce();
        expect(postMessage).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("parses attachments carried by a Telegram slash-command caption", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-telegram-caption-file",
      endpointId: "endpoint-telegram-caption-file",
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
    try {
      const message = runtime.parseTelegramCommandMessage({
        message_id: 14,
        date: 1_788_700_000,
        chat: { id: -1004415501660, type: "supergroup", title: "Agent Lab" },
        from: { id: 417200359, is_bot: false, first_name: "Dotta" },
        caption: "/task@paperclip_agent_bot inspect this file",
        caption_entities: [{ offset: 0, length: 30, type: "bot_command" }],
        document: {
          file_id: "telegram-file-id",
          file_unique_id: "telegram-unique-id",
          file_name: "proof.txt",
          mime_type: "text/plain",
          file_size: 41,
        },
      });
      expect(message?.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          name: "proof.txt",
          mimeType: "text/plain",
          size: 41,
          fetchMetadata: {
            fileId: "telegram-file-id",
            fileUniqueId: "telegram-unique-id",
          },
        }),
      ]);
      expect(
        runtime.attachmentRecoveryDescriptor(message!.attachments[0]!),
      ).toEqual(
        expect.objectContaining({
          provider: "telegram",
          locator: {
            kind: "telegram_file_id",
            fileId: "telegram-file-id",
            fileUniqueId: "telegram-unique-id",
          },
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    { label: "an absent Content-Length", contentLength: undefined },
    { label: "a misleading small Content-Length", contentLength: "4" },
  ])(
    "stops Telegram attachment downloads at Paperclip's byte cap with $label",
    async ({ contentLength }) => {
      const providerFetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/getFile")) {
          return Response.json({
            ok: true,
            result: { file_path: "documents/bounded.bin" },
          });
        }
        if (url.includes("/file/bot")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5, 6]));
                controller.close();
              },
            }),
            {
              status: 200,
              headers: contentLength
                ? { "content-length": contentLength }
                : undefined,
            },
          );
        }
        throw new Error(`Unexpected Telegram URL: ${url}`);
      });
      vi.stubGlobal("fetch", providerFetch);
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: `company-telegram-download-${contentLength ?? "absent"}`,
        endpointId: `endpoint-telegram-download-${contentLength ?? "absent"}`,
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "telegram",
          userName: "paperclip_agent_bot",
          maxDownloadBytes: 5,
          credentials: {
            botToken: "123:test",
            secretToken: "telegram-webhook-secret",
          },
        },
      });
      try {
        const message = runtime.parseTelegramCommandMessage({
          message_id: 15,
          date: 1_788_700_001,
          chat: { id: 77112233, type: "private" },
          from: { id: 77112233, is_bot: false, first_name: "Dotta" },
          caption: "/task inspect this file",
          caption_entities: [{ offset: 0, length: 5, type: "bot_command" }],
          document: {
            file_id: "telegram-bounded-file",
            file_name: "bounded.bin",
            mime_type: "application/octet-stream",
          },
        });

        await expect(
          message!.attachments[0]!.fetchData!(),
        ).rejects.toMatchObject({
          name: "NetworkError",
          message: expect.stringContaining("exceeds the download limit"),
        });
        expect(providerFetch).toHaveBeenCalledTimes(2);
      } finally {
        await runtime.shutdown();
        vi.unstubAllGlobals();
      }
    },
  );

  it("sends typed Telegram output through native photo, audio, video, and document methods", async () => {
    const methods: string[] = [];
    const providerFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        methods.push(method);
        return Response.json({
          ok: true,
          result: {
            message_id: methods.length,
            date: 1_788_700_002,
            chat: { id: 77112233, type: "private" },
          },
        });
      },
    );
    vi.stubGlobal("fetch", providerFetch);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-telegram-native-output",
      endpointId: "endpoint-telegram-native-output",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "telegram",
        userName: "paperclip_agent_bot",
        maxDownloadBytes: 10,
        credentials: {
          botToken: "123:test",
          secretToken: "telegram-webhook-secret",
        },
      },
    });
    try {
      const adapter = runtime.getProviderAdapter() as unknown as {
        postMessage(
          threadId: string,
          message: {
            attachments: Array<{
              data: Buffer;
              mimeType: string;
              name: string;
              type: "audio" | "file" | "image" | "video";
            }>;
            markdown: string;
          },
        ): Promise<unknown>;
      };
      const cases = [
        ["image", "image/png", "result.png"],
        ["audio", "audio/mpeg", "result.mp3"],
        ["audio", "audio/mp4", "result.m4a"],
        ["video", "video/mp4", "result.mp4"],
        ["file", "text/plain", "result.txt"],
        ["file", "audio/ogg", "voice.ogg"],
        ["file", "audio/wav", "recording.wav"],
        ["file", "audio/webm", "recording.webm"],
        ["file", "video/webm", "clip.webm"],
        ["file", "video/quicktime", "clip.mov"],
        ["file", "video/x-m4v", "clip.m4v"],
      ] as const;
      for (const [type, mimeType, name] of cases) {
        const bytes = Buffer.from(`original:${mimeType}:\u0000exact bytes\n`);
        await adapter.postMessage("telegram:77112233", {
          markdown: `Shared ${name}.`,
          attachments: [{ data: bytes, mimeType, name, type }],
        });
        const multipart = providerFetch.mock.calls.at(-1)?.[1]?.body;
        expect(multipart).toBeInstanceOf(FormData);
        const field =
          type === "file" ? "document" : type === "image" ? "photo" : type;
        const uploaded = (multipart as FormData).get(field);
        expect(uploaded).toBeInstanceOf(File);
        expect((uploaded as File).name).toBe(name);
        expect((uploaded as File).type).toBe(mimeType);
        expect(Buffer.from(await (uploaded as File).arrayBuffer())).toEqual(
          bytes,
        );
      }

      expect(methods).toEqual([
        "sendPhoto",
        "sendAudio",
        "sendAudio",
        "sendVideo",
        "sendDocument",
        ...Array<string>(6).fill("sendDocument"),
      ]);
      expect(
        providerFetch.mock.calls.every(
          ([, init]) => init?.body instanceof FormData,
        ),
      ).toBe(true);
    } finally {
      await runtime.shutdown();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      label: "worst-case durable part",
      source: "!".repeat(1_600),
      rendered: "\\!".repeat(1_600),
    },
    {
      label: "exact escaped ceiling",
      source: "!".repeat(2_048),
      rendered: "\\!".repeat(2_048),
    },
    {
      label: "exact astral ceiling",
      source: "🙂".repeat(2_048),
      rendered: "🙂".repeat(2_048),
    },
    {
      label: "medium prose",
      source: "A useful answer. ".repeat(120).trim(),
      rendered: "A useful answer\\. ".repeat(120).trim(),
    },
  ])(
    "keeps Telegram $label lossless after regular-message fallback",
    async ({ source, rendered }) => {
      const regularPayloads: Array<{ text?: string }> = [];
      const providerFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const method = new URL(String(input)).pathname.split("/").at(-1);
          if (method === "sendRichMessage") {
            return Response.json(
              {
                ok: false,
                error_code: 400,
                description: "Bad Request: method not found",
              },
              { status: 400 },
            );
          }
          if (method === "sendMessage") {
            regularPayloads.push(
              JSON.parse(String(init?.body)) as { text?: string },
            );
            return Response.json({
              ok: true,
              result: {
                message_id: 1,
                date: 1_788_700_003,
                chat: { id: 77112233, type: "private" },
              },
            });
          }
          throw new Error(`Unexpected Telegram method: ${method}`);
        },
      );
      vi.stubGlobal("fetch", providerFetch);
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-telegram-durable-part",
        endpointId: "endpoint-telegram-durable-part",
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
      try {
        const adapter = runtime.getProviderAdapter() as unknown as {
          postMessage(
            threadId: string,
            message: { markdown: string },
          ): Promise<unknown>;
        };
        expect(splitTelegramPublicationText(source)).toEqual([source]);
        await adapter.postMessage("telegram:77112233", { markdown: source });

        expect(regularPayloads).toHaveLength(1);
        const sentText = regularPayloads[0]?.text;
        expect(sentText).toBe(rendered);
        expect(sentText!.length).toBeLessThanOrEqual(4_096);
        expect(sentText!.replaceAll("\\", "")).toBe(source);
      } finally {
        await runtime.shutdown();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["personal", "channel", "groupChat"] as const)(
    "Teams close text replaces only the selected progress activity without retaining card controls (%s)",
    async (scope) => {
      // Transport proof only: the service must independently select a currently
      // owned plain progress lane and veto authored/uncertain final messages.
      // Actual installed adapter, App.send and Connector API serialization;
      // only the final HTTP methods are replaced. No live tenant/UI claim.
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-teams-close-edit",
        endpointId: `endpoint-teams-close-${scope}`,
        logger: "silent",
        persistence: memoryPersistence(),
        providerConfig: {
          provider: "microsoft-teams",
          userName: "maya",
          credentials: {
            appId: "00000000-0000-4000-8000-000000000000",
            appPassword: "synthetic-password",
          },
        },
      });
      const network = vi.fn(async () => {
        throw new Error("Unexpected network");
      });
      vi.stubGlobal("fetch", network);
      const adapter = runtime.getProviderAdapter();
      const app = (
        adapter as unknown as {
          app: {
            api: {
              serviceUrl: string;
              http: {
                put(url: string, body: unknown): Promise<{ data: unknown }>;
              };
            };
            activitySender: {
              client: {
                post(url: string, body: unknown): Promise<{ data: unknown }>;
              };
            };
          };
        }
      ).app;
      const post = vi
        .spyOn(app.activitySender.client, "post")
        .mockResolvedValueOnce({ data: { id: "authored-answer" } })
        .mockResolvedValueOnce({ data: { id: "owned-progress" } });
      const put = vi
        .spyOn(app.api.http, "put")
        .mockResolvedValue({ data: { id: "owned-progress" } });
      const conversation =
        scope === "personal"
          ? "a:close-personal"
          : "19:close-channel@thread.tacv2";
      const route = "https://smba.trafficmanager.net/emea/";
      const threadId = `teams:${Buffer.from(conversation).toString("base64url")}:${Buffer.from(route).toString("base64url")}:${scope}`;
      const originalApi = app.api;
      try {
        await runtime.initialize();
        await adapter.postMessage(threadId, {
          markdown: "The actual completed answer must remain unchanged.",
        });
        await adapter.postMessage(threadId, {
          card: {
            type: "card",
            title: "Working",
            children: [
              {
                type: "actions",
                children: [
                  { type: "button", id: "synthetic-stop", label: "Stop" },
                ],
              },
            ],
          },
        });
        expect(JSON.stringify(post.mock.calls[1]?.[1])).toContain(
          "Action.Submit",
        );
        expect(JSON.stringify(post.mock.calls[1]?.[1])).toContain(
          "synthetic-stop",
        );
        const edited = await adapter.editMessage(threadId, "owned-progress", {
          markdown:
            "This chat conversation is closed. The Paperclip task remains available.",
        });
        expect(edited).toMatchObject({ id: "owned-progress", threadId });
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0]?.[0]).toBe(
          `${route}v3/conversations/${conversation}/activities/owned-progress`,
        );
        const body = JSON.parse(JSON.stringify(put.mock.calls[0]?.[1]));
        expect(body).toMatchObject({
          type: "message",
          textFormat: "markdown",
          text: "This chat conversation is closed. The Paperclip task remains available.",
        });
        expect(body.attachments ?? []).toEqual([]);
        expect(body.suggestedActions).toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(
          /Action\.Submit|synthetic-stop|Working|authored-answer/,
        );
        expect(post).toHaveBeenCalledTimes(2);
        expect(app.api).toBe(originalApi);
        expect(network).not.toHaveBeenCalled();

        // An uncertain edit is surfaced; the adapter must not post a second
        // message, edit a different ID, or fall back to the authored answer.
        put.mockRejectedValueOnce(
          Object.assign(new Error("Synthetic connection lost"), {
            code: "ECONNRESET",
          }),
        );
        await expect(
          adapter.editMessage(threadId, "owned-progress", {
            markdown: "This chat conversation is closed.",
          }),
        ).rejects.toThrow();
        expect(put).toHaveBeenCalledTimes(2);
        expect(put.mock.calls[1]?.[0]).toBe(put.mock.calls[0]?.[0]);
        expect(post).toHaveBeenCalledTimes(2);
        expect(network).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it("parses verified Teams edit, delete, and restore envelopes through the public adapter contract", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-message-update",
      endpointId: "endpoint-teams-message-update",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-4000-8000-000000000511",
          appPassword: "secret",
          appTenantId: "00000000-0000-4000-8000-000000000522",
          appType: "SingleTenant",
        },
      },
    });
    const conversationId = "19:message-update@thread.tacv2;messageid=root-1";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const message = runtime.parseMicrosoftTeamsMessage({
      id: "teams-message-1",
      type: "messageUpdate",
      text: "Corrected Teams request",
      timestamp: "2026-09-06T14:01:00.000Z",
      serviceUrl,
      from: { id: "29:teams-user", name: "Teams User" },
      conversation: {
        id: conversationId,
        conversationType: "channel",
        tenantId: "00000000-0000-4000-8000-000000000522",
      },
      channelData: {
        eventType: "editMessage",
        tenant: { id: "00000000-0000-4000-8000-000000000522" },
      },
    });
    expect(message).toMatchObject({
      id: "teams-message-1",
      text: "Corrected Teams request",
      threadId: `teams:${Buffer.from(conversationId).toString("base64url")}`,
      author: { userId: "29:teams-user", fullName: "Teams User" },
    });
    expect(message?.threadId).not.toContain(
      Buffer.from(serviceUrl).toString("base64url"),
    );
    for (const lifecycle of [
      {
        type: "messageDelete",
        eventType: "softDeleteMessage",
        text: undefined,
      },
      {
        type: "messageUpdate",
        eventType: "undeleteMessage",
        text: "Restored Teams request",
      },
    ] as const) {
      const parsed = runtime.parseMicrosoftTeamsMessage({
        id: "teams-message-1",
        type: lifecycle.type,
        text: lifecycle.text,
        timestamp: "2026-09-06T14:02:00.000Z",
        serviceUrl,
        from: { id: "29:teams-user", name: "Teams User" },
        conversation: {
          id: conversationId,
          conversationType: "channel",
          tenantId: "00000000-0000-4000-8000-000000000522",
        },
        channelData: {
          eventType: lifecycle.eventType,
          tenant: { id: "00000000-0000-4000-8000-000000000522" },
        },
      });
      expect(parsed).toMatchObject({
        id: "teams-message-1",
        text: lifecycle.text ?? "",
        threadId: message?.threadId,
        author: { userId: "29:teams-user", fullName: "Teams User" },
      });
    }
    await runtime.shutdown();
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
      label: "JSON response body subCode",
      providerCode: "MessageWritesBlocked",
      rawError: Object.assign(new Error("Teams request was forbidden"), {
        innerHttpError: {
          statusCode: 403,
          body: JSON.stringify({
            error: {
              code: "Forbidden",
              innerError: {
                subCode: "MessageWritesBlocked",
                message: "sensitive-provider-detail-must-not-survive",
              },
            },
          }),
        },
      }),
    },
    {
      label: "structured response code",
      providerCode: "ForbiddenOperationException",
      rawError: Object.assign(new Error("Teams request was forbidden"), {
        status: 403,
        response: {
          data: {
            error: { code: "ForbiddenOperationException" },
          },
        },
      }),
    },
  ])(
    "retains bounded Teams 403 metadata from a $label",
    async ({ providerCode, rawError }) => {
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-teams-errors",
        endpointId: `endpoint-teams-${providerCode}`,
        logger: "silent",
        persistence,
        providerConfig: {
          provider: "microsoft-teams",
          userName: "Paperclip Agent",
          credentials: {
            appId: "00000000-0000-4000-8000-000000000000",
            appPassword: "secret",
          },
        },
      });
      const adapter = runtime.getProviderAdapter() as unknown as {
        app: { activitySender: { send: () => Promise<never> } };
        postMessage(
          threadId: string,
          message: { markdown: string },
        ): Promise<unknown>;
      };
      adapter.app.activitySender.send = async () => {
        throw rawError;
      };
      const threadId = `teams:${Buffer.from("19:blocked-thread@thread.tacv2").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}:channel`;

      try {
        const error = await adapter
          .postMessage(threadId, { markdown: "Safe Teams response" })
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          name: "PermissionError",
          adapter: "teams",
          code: "PERMISSION_DENIED",
          status: 403,
          statusCode: 403,
          subCode: providerCode,
          details: {
            providerStatus: 403,
            providerSubCode: providerCode,
          },
        });
        expect((error as { providerCodes: string[] }).providerCodes).toContain(
          providerCode,
        );
        expect(JSON.stringify(error)).not.toContain(
          "sensitive-provider-detail-must-not-survive",
        );
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("keeps a Teams 401 as an endpoint authentication error", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-auth-error",
      endpointId: "endpoint-teams-auth-error",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-4000-8000-000000000000",
          appPassword: "secret",
        },
      },
    });
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: { activitySender: { send: () => Promise<never> } };
      postMessage(
        threadId: string,
        message: { markdown: string },
      ): Promise<unknown>;
    };
    adapter.app.activitySender.send = async () => {
      throw Object.assign(new Error("expired credential"), {
        innerHttpError: { statusCode: 401 },
      });
    };
    const threadId = `teams:${Buffer.from("19:auth-thread@thread.tacv2").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}:channel`;

    try {
      await expect(
        adapter.postMessage(threadId, { markdown: "Do not deliver" }),
      ).rejects.toMatchObject({
        name: "AuthenticationError",
        adapter: "teams",
        code: "AUTH_FAILED",
      });
    } finally {
      await runtime.shutdown();
    }
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
          botUserId: 1,
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
      const providerFetch = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (providerConfig.provider === "telegram" && url.endsWith("/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 123,
              is_bot: true,
              first_name: "Paperclip Agent",
              username: "paperclip_agent_bot",
            },
          });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      });
      vi.stubGlobal("fetch", providerFetch);
      const runtime = createChatSdkEndpointRuntime({
        callbacks: { onMessage() {} },
        companyId: "company-signature-test",
        endpointId: `endpoint-${providerConfig.provider}`,
        logger: "silent",
        persistence,
        providerConfig,
      });
      try {
        const response = await runtime.handleWebhook(request);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      } finally {
        await runtime.shutdown();
        vi.unstubAllGlobals();
      }
    },
  );

  it("preserves safe HTTPS destinations from signed GitHub Markdown comments", async () => {
    const webhookSecret = "github-link-preservation-secret";
    const safeLink = "https://example.test/build/42?view=summary";
    const safeImage =
      "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
    const existingBareUrl = "https://already-visible.example.test/log.txt";
    const markdown = [
      `@paperclip-agent inspect [the build](${safeLink}).`,
      `![failure.log](${safeImage})`,
      `Existing URL: ${existingBareUrl}`,
      "[unsafe](javascript:alert(1))",
      "![credentialed](https://user:password@example.test/private)",
    ].join("\n\n");
    const payload = {
      action: "created",
      comment: {
        id: 4242,
        body: markdown,
        created_at: "2026-09-04T12:00:00.000Z",
        updated_at: "2026-09-04T12:00:00.000Z",
        user: { id: 101, login: "operator", type: "User" },
      },
      issue: { number: 42 },
      repository: {
        id: 202,
        name: "chat-e2e",
        owner: { id: 303, login: "paperclipai", type: "Organization" },
      },
      sender: { id: 101, login: "operator", type: "User" },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex")}`;
    const onMessage = vi.fn(async (_event: unknown) => undefined);
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage },
      companyId: "company-github-links",
      endpointId: "endpoint-github-links",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "github",
        userName: "paperclip-agent",
        credentials: {
          botUserId: 999,
          token: "github_pat_test",
          webhookSecret,
        },
      },
    });

    try {
      const response = await runtime.handleWebhook(
        new Request("https://paperclip.test/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-hub-signature-256": signature,
          },
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      const event = onMessage.mock.calls[0]?.[0] as unknown as {
        message: { text: string };
      };
      expect(event.message.text).toContain("the build");
      expect(event.message.text).toContain(safeLink);
      expect(event.message.text).toContain(safeImage);
      expect(event.message.text).toContain(existingBareUrl);
      expect(event.message.text.split(existingBareUrl)).toHaveLength(2);
      expect(event.message.text).not.toContain("javascript:");
      expect(event.message.text).not.toContain(
        "https://user:password@example.test/private",
      );

      const adapter = runtime.getProviderAdapter() as unknown as {
        parseReviewComment(
          comment: Record<string, unknown>,
          repository: Record<string, unknown>,
          prNumber: number,
          threadId: string,
        ): { text: string };
      };
      const review = adapter.parseReviewComment(
        payload.comment,
        payload.repository,
        42,
        "github:paperclipai/chat-e2e:42:rc:4242",
      );
      expect(review.text).toContain(safeLink);
      expect(review.text).toContain(safeImage);
    } finally {
      await runtime.shutdown();
    }
  });

  it("never logs unauthenticated Teams webhook bodies or authorization values", async () => {
    const bodyMarker = "teams-body-secret-marker-7c6f";
    const authorizationMarker = "teams-auth-secret-marker-94bd";
    const logEntries: unknown[] = [];
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-log-boundary",
      endpointId: "endpoint-teams-log-boundary",
      logger: capturingLogger(logEntries),
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "teams-secret",
          appTenantId: "11111111-1111-1111-1111-111111111111",
          appType: "SingleTenant",
        },
      },
    });

    try {
      const response = await runtime.handleWebhook(
        new Request("https://paperclip.test/webhook", {
          method: "POST",
          headers: {
            authorization: `Bearer ${authorizationMarker}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: "forged-activity",
            type: "message",
            text: bodyMarker,
            value: { privateInput: bodyMarker },
          }),
        }),
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const serializedLogs = JSON.stringify(logEntries);
      expect(serializedLogs).not.toContain(bodyMarker);
      expect(serializedLogs).not.toContain(authorizationMarker);
      expect(serializedLogs).not.toContain("Teams webhook raw body");
    } finally {
      await runtime.shutdown();
    }
  });

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

  it("keeps Teams thread identity canonical while the latest durable route wins over legacy URLs", async () => {
    const state = memoryPersistence();
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-route-refresh",
      endpointId: "endpoint-teams-route-refresh",
      logger: "silent",
      persistence: state,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-0000-0000-000000000000",
          appPassword: "secret",
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
      app: {
        activitySender: {
          send(
            activity: unknown,
            reference: { serviceUrl: string },
          ): Promise<{ id: string }>;
        };
      };
      postMessage(
        threadId: string,
        message: { markdown: string },
      ): Promise<unknown>;
    };
    const conversationId =
      "19:route-refresh@thread.tacv2;messageid=canonical-root";
    const canonicalThreadId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
    const staleServiceUrl = "https://smba.trafficmanager.net/amer";
    const currentServiceUrl = "https://smba.trafficmanager.net/emea";
    const legacyThreadId = `${canonicalThreadId}:${Buffer.from(staleServiceUrl).toString("base64url")}`;
    const observedServiceUrls: string[] = [];
    adapter.app.activitySender.send = async (_activity, reference) => {
      observedServiceUrls.push(reference.serviceUrl);
      return { id: `sent-${observedServiceUrls.length}` };
    };

    await runtime.recordMicrosoftTeamsRoute(
      canonicalThreadId,
      currentServiceUrl,
    );
    await adapter.postMessage(legacyThreadId, { markdown: "legacy row" });
    await adapter.postMessage(canonicalThreadId, { markdown: "canonical row" });

    expect(observedServiceUrls).toEqual([currentServiceUrl, currentServiceUrl]);
    await runtime.shutdown();
  });

  it("persists Teams metadata only after Paperclip admits the authenticated activity", async () => {
    const state = memoryPersistence();
    const tenantId = "00000000-0000-4000-8000-000000000622";
    const appId = "00000000-0000-4000-8000-000000000611";
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-admitted-metadata",
      endpointId: "endpoint-teams-admitted-metadata",
      logger: "silent",
      persistence: state,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId,
          appPassword: "secret",
          appTenantId: tenantId,
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
      cacheUserContext(activity: unknown): void;
      chat: {
        getState(): {
          get<T = unknown>(key: string): Promise<T | null>;
        };
      };
      getIncomingUser(...args: unknown[]): Promise<unknown>;
      getUser(...args: unknown[]): Promise<unknown>;
    };
    const userId = "29:admitted-teams-user";
    const aadObjectId = "00000000-0000-4000-8000-000000000633";
    const conversationId =
      "19:admitted-channel@thread.tacv2;messageid=admitted-root";
    const baseConversationId = "19:admitted-channel@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const raw = {
      type: "message",
      serviceUrl,
      from: { id: userId, aadObjectId, name: "Admitted Teams User" },
      conversation: {
        id: conversationId,
        conversationType: "channel",
        tenantId,
      },
      channelData: {
        tenant: { id: tenantId },
        team: { aadGroupId: "admitted-team-aad-id" },
        channel: { id: baseConversationId },
      },
    };
    const sdkState = adapter.chat.getState();

    adapter.cacheUserContext(raw);
    expect(await adapter.getIncomingUser({}, userId, aadObjectId)).toBeNull();
    expect(await adapter.getUser(userId)).toBeNull();
    expect(await sdkState.get(`teams:serviceUrl:${userId}`)).toBeNull();
    expect(await sdkState.get(`teams:aadObjectId:${userId}`)).toBeNull();
    expect(await sdkState.get(`teams:tenantId:${userId}`)).toBeNull();
    expect(
      await sdkState.get(`teams:channelContext:${baseConversationId}`),
    ).toBeNull();

    expect(runtime.acceptsProviderScope(raw)).toBe(true);
    expect(
      runtime.acceptsProviderScope({
        ...raw,
        recipient: { id: appId, isTargeted: true },
      }),
    ).toBe(false);
    expect(
      runtime.acceptsProviderScope({
        ...raw,
        conversation: {
          ...raw.conversation,
          tenantId: "00000000-0000-4000-8000-000000000699",
        },
      }),
    ).toBe(false);

    const threadId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
    await runtime.recordMicrosoftTeamsRoute(threadId, serviceUrl, raw);

    expect(await sdkState.get(`teams:serviceUrl:${userId}`)).toBe(
      "https://smba.trafficmanager.net/amer",
    );
    expect(await sdkState.get(`teams:aadObjectId:${userId}`)).toBe(aadObjectId);
    expect(await sdkState.get(`teams:tenantId:${userId}`)).toBe(tenantId);
    expect(
      JSON.parse(
        String(
          await sdkState.get(`teams:channelContext:${baseConversationId}`),
        ),
      ),
    ).toEqual({
      teamId: "admitted-team-aad-id",
      channelId: baseConversationId,
    });
    await runtime.shutdown();
  });

  it("scopes direct Teams edit, reaction, and delete calls to signed Microsoft service URLs", async () => {
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
      app: {
        api: unknown;
        activitySender: {
          send(
            activity: unknown,
            reference: { serviceUrl: string },
          ): Promise<{ id: string }>;
        };
      };
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
      app: {
        api: unknown;
        activitySender: {
          send(
            activity: unknown,
            reference: { serviceUrl: string },
          ): Promise<{ id: string }>;
        };
      };
      chat: {
        getState(): {
          set(key: string, value: string, ttlMs?: number): Promise<void>;
        };
      };
      openDM(userId: string): Promise<string>;
      postMessage(
        threadId: string,
        message: { markdown: string },
      ): Promise<unknown>;
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
            const index = observedServiceUrls.length;
            if (index === 1) {
              markFirstObserved();
              await firstBlocked;
            } else if (index === 2) {
              markSecondObserved();
            }
            return { id: `conversation-${index}` };
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
    expect(amerThread).toBe(
      `teams:${Buffer.from("conversation-1").toString("base64url")}`,
    );
    expect(gccThread).toBe(
      `teams:${Buffer.from("conversation-2").toString("base64url")}`,
    );
    observedServiceUrls.length = 0;
    adapter.app.activitySender.send = async (_activity, reference) => {
      observedServiceUrls.push(reference.serviceUrl);
      return { id: `sent-${observedServiceUrls.length}` };
    };
    await adapter.postMessage(amerThread, { markdown: "Americas follow-up" });
    await adapter.postMessage(gccThread, { markdown: "GCC follow-up" });
    expect(observedServiceUrls).toEqual([amer, gcc]);
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

  it("accepts canonical Microsoft first-party Teams service URL suffixes", async () => {
    const runtime = createChatSdkEndpointRuntime({
      callbacks: { onMessage() {} },
      companyId: "company-teams-egress-first-party",
      endpointId: "endpoint-teams-egress-first-party",
      logger: "silent",
      persistence,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Paperclip Agent",
        credentials: {
          appId: "00000000-0000-4000-8000-000000000000",
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
      return { id: `first-party-${observed.length}` };
    };
    const serviceUrls = [
      "https://skype.botframework.com/",
      "https://regional.botframework.com/teams/",
      "https://smba.trafficmanager.net/amer-client-ss.msg/",
      "https://smba.infra.gcc.teams.microsoft.com/teams/",
      "https://smba.infra.gov.teams.microsoft.us/teams/",
    ];

    for (const [index, serviceUrl] of serviceUrls.entries()) {
      const threadId = `teams:${Buffer.from(`19:first-party-${index}@thread.tacv2`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:channel`;
      await adapter.postMessage(threadId, { markdown: "Safe response" });
    }

    expect(observed).toEqual(serviceUrls.map((url) => url.replace(/\/$/, "")));
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
      "https://botframework.com.attacker.example/teams",
      "https://attackerbotframework.com/teams",
      "https://smba.trafficmanager.net:8443/teams",
      "https://user@skype.botframework.com/teams",
      "https://skype.botframework.com/teams/v3",
      "https://skype.botframework.com/teams///",
      "https://skype.botframework.com/%2e%2e/teams",
      "https://skype.botframework.com/teams?redirect=attacker",
      "https://skype.botframework.com/teams#fragment",
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
