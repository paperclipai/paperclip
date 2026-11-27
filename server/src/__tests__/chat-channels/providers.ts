// Shared fake chat provider runtimes, fetch mocks, and Express app builders.
import { resolveExternalTestDatabaseUrl } from "../helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import request from "supertest";
import { describe, vi } from "vitest";
import { agents, createDb } from "@paperclipai/db";
import { type ChatProvider } from "@paperclipai/shared";
import type { Attachment, Author, Message, Thread } from "chat";
import { errorHandler } from "../../middleware/index.js";
import { createChatWebhookDiagnostics, type ChatWebhookDiagnosticEvent } from "../../services/chat-webhook-diagnostics.js";
import { chatChannelRoutes, chatWebhookRoutes } from "../../routes/chat-channels.js";
import { type ChatChannelService } from "../../services/chat-channels.js";
import type { CreateChatSdkEndpointRuntimeOptions, ChatSdkEndpointRuntime, ChatSdkProvider } from "../../services/chat-sdk-runtime.js";
import type { TelegramDraftControl } from "../../services/chat-telegram-draft-stop.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { githubAttachmentLocator, rehydrateGitHubPublicAttachment } from "../../services/chat-github-attachments.js";
import { getEmbeddedPostgresTestSupport } from "../helpers/embedded-postgres.js";

export const historyTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");
export const slackProtocolCapture = process.env.PAPERCLIP_SLACK_PROTOCOL_CAPTURE === "1";
export const slackProtocolDatabaseUrl = slackProtocolCapture ? resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_TEST_DATABASE_URL") : undefined;
if (slackProtocolCapture && !slackProtocolDatabaseUrl) throw new Error("Slack protocol capture requires an explicit dedicated test database");
export const externalTestDatabaseUrl = slackProtocolDatabaseUrl ?? historyTestDatabaseUrl ?? process.env.PAPERCLIP_TEST_DATABASE_URL;
export const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
export const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat-channel integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

export type TestDb = ReturnType<typeof createDb>;

export class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => {
    await this.initializeHook?.(this.options.endpointId);
  });
  readonly shutdown = vi.fn(async () => undefined);
  readonly posts: Array<{
    threadId: string;
    text: string;
    attachments?: unknown[];
    chunks?: string[];
    files?: unknown[];
  }> = [];
  readonly edits: Array<{
    threadId: string;
    messageId: string;
    text: string;
  }> = [];
  readonly editAttempts: Array<{
    threadId: string;
    messageId: string;
  }> = [];
  readonly reactions: Array<{
    threadId: string;
    messageId: string;
    emoji: string;
  }> = [];
  readonly reactionErrors: Error[] = [];
  readonly removedReactions: Array<{
    threadId: string;
    messageId: string;
    emoji: string;
  }> = [];
  readonly removeReactionErrors: Error[] = [];
  readonly rehydratedAttachmentDescriptors: unknown[] = [];
  readonly postResultIds: string[] = [];
  readonly slackFileReceiptLookups: Array<{
    fileIds: string[];
    threadId: string;
  }> = [];
  readonly slackFileReceiptResultIds: Array<string | null> = [];
  slackFileReceiptCaptureRepeats = 1;
  slackFilePublicationAttempts = 0;
  slackFilePostAcceptanceError: Error | null = null;
  slackFilePostAcceptanceHook: (() => Promise<void>) | undefined;
  slackFileReceiptHook: (() => Promise<void>) | undefined;
  readonly ensuredDiscordRootThreads: Array<{
    channelId: string;
    content: string;
    messageId: string;
  }> = [];
  readonly recordedMicrosoftTeamsRoutes: Array<{
    threadId: string;
    serviceUrl: unknown;
  }> = [];
  private nextPostId = 0;
  postError: Error | null = null;
  editError: Error | null = null;
  postHook: (() => Promise<void>) | undefined;
  webhookHook: ((request: Request) => Promise<void>) | undefined;
  webhookRequest: Request | null = null;
  webhookResponse = new Response("accepted", {
    status: 202,
    headers: { "x-chat-test": "accepted" },
  });

  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
    private readonly attachmentBodies: Map<string, Buffer>,
    private readonly initializeHook?: (endpointId: string) => Promise<void>,
  ) {}

  get provider() {
    return this.options.providerConfig.provider;
  }

  async handleWebhook(request: Request) {
    this.webhookRequest = request;
    await this.webhookHook?.(request);
    return this.webhookResponse;
  }

  async ensureDiscordRootThread(input: {
    channelId: string;
    content: string;
    messageId: string;
  }) {
    this.ensuredDiscordRootThreads.push(input);
  }

  async recordMicrosoftTeamsRoute(threadId: string, serviceUrl: unknown) {
    this.recordedMicrosoftTeamsRoutes.push({ threadId, serviceUrl });
  }

  async postSlackFilePublication(
    threadId: string,
    message: unknown,
    onUploadAccepted: (receipt: {
      version: 1;
      channelId: string;
      fileIds: string[];
      threadTs: string | null;
    }) => Promise<void>,
  ) {
    this.slackFilePublicationAttempts += 1;
    await this.postHook?.();
    if (this.postError) throw this.postError;
    const parts = threadId.split(":");
    const files =
      message &&
      typeof message === "object" &&
      "files" in message &&
      Array.isArray((message as { files?: unknown }).files)
        ? (message as { files: unknown[] }).files
        : [];
    for (
      let attempt = 0;
      attempt < this.slackFileReceiptCaptureRepeats;
      attempt += 1
    ) {
      await onUploadAccepted({
        version: 1,
        channelId: parts[1] ?? "",
        fileIds: files.map((_, index) => `FTEST${index + 1}`),
        threadTs: parts[2] || null,
      });
    }
    await this.slackFilePostAcceptanceHook?.();
    if (this.slackFilePostAcceptanceError) {
      throw this.slackFilePostAcceptanceError;
    }
    const postHook = this.postHook;
    this.postHook = undefined;
    try {
      return await this.thread(threadId).post(message);
    } finally {
      this.postHook = postHook;
    }
  }

  async resolveSlackFileUploadReceipt(threadId: string, fileIds: string[]) {
    this.slackFileReceiptLookups.push({
      fileIds: [...fileIds],
      threadId,
    });
    await this.slackFileReceiptHook?.();
    return this.slackFileReceiptResultIds.shift() ?? null;
  }

  acceptsProviderScope(raw: unknown) {
    if (this.options.providerConfig.provider !== "microsoft-teams") return true;
    const expected = this.options.providerConfig.credentials.appTenantId;
    if (!expected || !raw || typeof raw !== "object") return Boolean(!expected);
    const payload = raw as {
      conversation?: { tenantId?: unknown };
      channelData?: { tenant?: { id?: unknown } };
      recipient?: { isTargeted?: unknown };
    };
    if (payload.recipient?.isTargeted === true) return false;
    const tenantIds = [
      payload.conversation?.tenantId,
      payload.channelData?.tenant?.id,
    ].filter((value): value is string => typeof value === "string");
    return (
      tenantIds.length > 0 && tenantIds.every((value) => value === expected)
    );
  }

  async applySlackReceiptReaction(input: {
    operation: "add" | "remove";
    threadId: string;
    messageId: string;
    reaction: "eyes";
  }) {
    const adapter = this.thread(input.threadId).adapter;
    if (input.operation === "add")
      await adapter.addReaction(
        input.threadId,
        input.messageId,
        input.reaction,
      );
    else
      await adapter.removeReaction(
        input.threadId,
        input.messageId,
        input.reaction,
      );
  }

  async applyGitHubReceiptReaction(
    input: Parameters<ChatSdkEndpointRuntime["applyGitHubReceiptReaction"]>[0],
    assertCurrent: () => Promise<void>,
  ) {
    await assertCurrent();
    await this.applySlackReceiptReaction(input);
    return input.githubReceipt ?? { botUserId: "9001", reactionId: "880012" };
  }

  async streamTelegramDraft(
    threadId: string,
    stream: AsyncIterable<string>,
    control: TelegramDraftControl,
  ) {
    if (!(await control.beforeDraft()) || !(await control.beforeFinal()))
      return { paperclipDraftStopped: true as const };
    return this.thread(threadId).post(stream);
  }

  thread(threadId: string) {
    const parts = threadId.split(":");
    const channelId =
      this.options.providerConfig.provider === "discord"
        ? (parts[2] ?? threadId)
        : (parts[1] ?? threadId);
    const isTelegramDirectMessage =
      this.options.providerConfig.provider === "telegram" &&
      /^\d+$/.test(channelId);
    return {
      id: threadId,
      channelId,
      isDM: isTelegramDirectMessage || /^D[A-Z0-9-]*$/i.test(channelId),
      channel: {
        id: channelId,
        name: "command-thread",
      },
      adapter: {
        addReaction: async (
          reactionThreadId: string,
          messageId: string,
          emoji: string,
        ) => {
          const error = this.reactionErrors.shift();
          if (error) throw error;
          this.reactions.push({
            threadId: reactionThreadId,
            messageId,
            emoji,
          });
        },
        removeReaction: async (
          reactionThreadId: string,
          messageId: string,
          emoji: string,
        ) => {
          const error = this.removeReactionErrors.shift();
          if (error) throw error;
          this.removedReactions.push({
            threadId: reactionThreadId,
            messageId,
            emoji,
          });
        },
        editMessage: async (
          editedThreadId: string,
          messageId: string,
          editedMessage: unknown,
        ) => {
          this.editAttempts.push({ threadId: editedThreadId, messageId });
          if (this.editError) throw this.editError;
          if (this.postError) throw this.postError;
          const text =
            editedMessage &&
            typeof editedMessage === "object" &&
            "markdown" in editedMessage
              ? String((editedMessage as { markdown: unknown }).markdown)
              : JSON.stringify(editedMessage);
          this.edits.push({
            threadId: editedThreadId,
            messageId,
            text,
          });
          return { id: messageId, threadId: editedThreadId };
        },
      },
      startTyping: async () => undefined,
      subscribe: async () => undefined,
      post: async (message: unknown) => {
        await this.postHook?.();
        if (this.postError) throw this.postError;
        let text: string;
        let attachments: unknown[] | undefined;
        let chunks: string[] | undefined;
        let files: unknown[] | undefined;
        if (typeof message === "string") text = message;
        else if (
          message &&
          typeof message === "object" &&
          Symbol.asyncIterator in message
        ) {
          chunks = [];
          for await (const chunk of message as AsyncIterable<unknown>)
            chunks.push(String(chunk));
          text = chunks.join("");
        } else if (
          message &&
          typeof message === "object" &&
          "markdown" in message
        ) {
          text = String((message as { markdown: unknown }).markdown);
        } else text = JSON.stringify(message);
        if (
          message &&
          typeof message === "object" &&
          "attachments" in message &&
          Array.isArray((message as { attachments?: unknown }).attachments)
        ) {
          attachments = (message as { attachments: unknown[] }).attachments;
        }
        if (
          message &&
          typeof message === "object" &&
          "files" in message &&
          Array.isArray((message as { files?: unknown }).files)
        ) {
          files = (message as { files: unknown[] }).files;
        }
        this.posts.push({
          threadId,
          text,
          ...(attachments ? { attachments } : {}),
          ...(chunks ? { chunks } : {}),
          ...(files ? { files } : {}),
        });
        this.nextPostId += 1;
        return {
          id: this.postResultIds.shift() ?? `outbound-${this.nextPostId}`,
          threadId,
        };
      },
    };
  }

  attachmentRecoveryDescriptor(attachment: Attachment) {
    if (this.options.providerConfig.provider === "github") {
      const locator = githubAttachmentLocator(attachment);
      return locator
        ? {
            version: 1,
            provider: "github",
            attachment: { type: attachment.type, name: attachment.name },
            locator,
          }
        : null;
    }
    const recoveryKey = attachment.fetchMetadata?.testRecoveryKey;
    if (typeof recoveryKey !== "string") return null;
    return {
      version: 1,
      provider: this.options.providerConfig.provider,
      attachment: {
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
      locator: { kind: "test_attachment", recoveryKey },
    };
  }

  parseTelegramCommandMessage(raw: unknown): Message | null {
    if (
      this.options.providerConfig.provider !== "telegram" ||
      !raw ||
      typeof raw !== "object"
    )
      return null;
    const document = (raw as { document?: Record<string, unknown> }).document;
    const recoveryKey =
      typeof document?.file_id === "string" ? document.file_id : null;
    if (!recoveryKey || !document) return null;
    return makeMessage({
      id: `telegram-command:${recoveryKey}`,
      text: "",
      attachments: [
        {
          type: "file",
          name:
            typeof document.file_name === "string"
              ? document.file_name
              : undefined,
          mimeType:
            typeof document.mime_type === "string"
              ? document.mime_type
              : undefined,
          size:
            typeof document.file_size === "number"
              ? document.file_size
              : undefined,
          fetchMetadata: { testRecoveryKey: recoveryKey },
        } as Attachment,
      ],
    });
  }

  parseMicrosoftTeamsMessage(raw: unknown): Message | null {
    if (
      this.options.providerConfig.provider !== "microsoft-teams" ||
      !raw ||
      typeof raw !== "object"
    )
      return null;
    const activity = raw as {
      conversation?: { conversationType?: unknown; id?: unknown };
      from?: { aadObjectId?: unknown; id?: unknown; name?: unknown };
      id?: unknown;
      serviceUrl?: unknown;
      text?: unknown;
    };
    if (
      typeof activity.id !== "string" ||
      typeof activity.conversation?.id !== "string" ||
      typeof activity.serviceUrl !== "string"
    )
      return null;
    const conversationType = activity.conversation.conversationType;
    const legacyIsDM = !activity.conversation.id.startsWith("19:");
    const explicitIsDM = conversationType === "personal";
    const includeConversationType =
      (conversationType === "channel" ||
        conversationType === "groupChat" ||
        conversationType === "personal") &&
      explicitIsDM !== legacyIsDM;
    const threadId = [
      "teams",
      Buffer.from(activity.conversation.id).toString("base64url"),
      ...(includeConversationType ? [conversationType] : []),
    ].join(":");
    const userId =
      typeof activity.from?.id === "string" ? activity.from.id : "unknown";
    const userName =
      typeof activity.from?.name === "string" ? activity.from.name : userId;
    return {
      ...makeMessage({
        id: activity.id,
        raw,
        text: typeof activity.text === "string" ? activity.text : "",
        userId,
        userName,
      }),
      threadId,
    } as Message;
  }

  rehydrateAttachment(
    descriptor: unknown,
    source?: { threadId: string; messageId: string },
  ): Attachment | null {
    this.rehydratedAttachmentDescriptors.push(descriptor);
    if (!descriptor || typeof descriptor !== "object") return null;
    const value = descriptor as {
      version?: unknown;
      provider?: unknown;
      attachment?: Attachment;
      locator?: { kind?: unknown; recoveryKey?: unknown };
    };
    if (
      this.options.providerConfig.provider === "github" &&
      value.provider === "github" &&
      value.version === 1 &&
      source
    ) {
      return rehydrateGitHubPublicAttachment(value.locator, source);
    }
    if (
      value.version !== 1 ||
      value.provider !== this.options.providerConfig.provider ||
      value.locator?.kind !== "test_attachment" ||
      typeof value.locator.recoveryKey !== "string" ||
      !value.attachment
    ) {
      return null;
    }
    const body = this.attachmentBodies.get(value.locator.recoveryKey);
    if (!body) return null;
    return {
      ...value.attachment,
      fetchData: async () => body,
      fetchMetadata: { testRecoveryKey: value.locator.recoveryKey },
    } as Attachment;
  }

  async resolveGitHubAttachmentComment(
    _request: { url: string; accept: string },
    _signal: AbortSignal,
  ): Promise<unknown> {
    return null;
  }
}

export class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<
    string,
    CreateChatSdkEndpointRuntimeOptions
  >();
  initializeHook: ((endpointId: string) => Promise<void>) | undefined;
  replaceCount = 0;

  constructor(readonly attachmentBodies: Map<string, Buffer> = new Map()) {}

  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }

  hasUnsettledLifecycle() { return false; }

  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.replaceCount += 1;
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(
      options,
      this.attachmentBodies,
      this.initializeHook,
    );
    this.endpoints.set(options.endpointId, endpoint);
    return endpoint;
  }

  async removeEndpoint(endpointId: string) {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return false;
    this.endpoints.delete(endpointId);
    await endpoint.shutdown();
    return true;
  }

  async shutdown() {
    await Promise.all(
      [...this.endpoints.values()].map(async (endpoint) => endpoint.shutdown()),
    );
    this.endpoints.clear();
  }
}

export const TEST_SLACK_BOT_SCOPES =
  "app_mentions:read,assistant:write,channels:history,channels:read,chat:write,commands,files:read,files:write,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,reactions:read,reactions:write,users:read";
export const discordApplicationPrefix = 1_400_000_000_000_000_000n +
  BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) * 1000n;
export let discordApplicationSequence = 0n;

export function uniqueDiscordApplicationId() {
  discordApplicationSequence += 1n;
  return (discordApplicationPrefix + discordApplicationSequence).toString();
}

export function fakeSlackFetch(botId = `U-BOT-${randomUUID()}`) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const args = new URLSearchParams(String(init?.body ?? new URL(url).search));
    if (url === "https://slack.com/api/auth.test") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-PAPERCLIP",
            team: "Paperclip Test",
            user_id: botId,
            user: `maya-${botId.slice(-8)}`,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        ),
      );
    }
    if (url.startsWith("https://slack.com/api/conversations.list")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.startsWith("https://slack.com/api/conversations.info")) {
      const channelId = args.get("channel");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            channel: {
              id: channelId,
              name: channelId?.toLowerCase(),
              is_member: true,
              is_archived: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url === "https://slack.com/api/users.info") {
      return Promise.resolve(Response.json({ ok: true, user: { id: args.get("user"), team_id: "T-PAPERCLIP" } }));
    }
    if (url === "https://slack.com/api/agents.sessions.setStatus") {
      return Promise.resolve(Response.json({ ok: true }));
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

export function fakeDiscordFetch(
  applicationId: string,
  guildId = "1457808928258658549",
) {
  return async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const responses: Record<string, unknown> = {
      "/api/v10/users/@me": {
        id: applicationId,
        username: `maya-${applicationId.slice(-8)}`,
        global_name: "Maya",
        bot: true,
      },
      "/api/v10/oauth2/applications/@me": {
        id: applicationId,
        name: "Maya",
        flags: 1 << 18,
      },
      [`/api/v10/guilds/${guildId}`]: { id: guildId, name: "Clawd" },
      [`/api/v10/guilds/${guildId}/members/${applicationId}`]: {
        roles: ["222222222222222222"],
        user: { id: applicationId },
      },
      [`/api/v10/guilds/${guildId}/roles`]: [
        { id: "222222222222222222", permissions: "309237763136" },
      ],
      [`/api/v10/guilds/${guildId}/channels`]: [
        {
          id: "333333333333333333",
          name: "agent-lab",
          position: 1,
          type: 0,
        },
      ],
    };
    return new Response(JSON.stringify(responses[path]), {
      status: path in responses ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
}

export function fakeTelegramFetch(
  botId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: botId,
            username: `paperclip_${botId}_bot`,
            first_name: "Paperclip Test",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/getWebhookInfo")) {
      return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.endsWith("/setWebhook") ||
      url.endsWith("/setMyCommands") ||
      url.endsWith("/deleteWebhook") ||
      url.endsWith("/deleteMyCommands")
    ) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

export function chatSdkProvider(provider: ChatProvider): ChatSdkProvider {
  if (provider === "agentmail" || provider === "speko") throw new Error(`${provider} has no Chat SDK runtime`);
  return provider;
}

export function wizardStoreApp(service: ChatChannelService) {
  return (
    endpointId: string,
    userId: string,
    credentials: Record<string, string>,
    managementContext?: Parameters<ChatChannelService["storeGitHubApp"]>[4],
  ) => service.storeGitHubApp(endpointId, userId, credentials, "manifest", managementContext);
}

export function makeThread(input: {
  channelId: string;
  id: string;
  isDM?: boolean;
  name?: string;
}) {
  const addReaction = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => undefined);
  const postEphemeral = vi.fn(async (_user?: unknown, _message?: unknown, _options?: unknown) => ({
    id: `thread-ephemeral-${randomUUID()}`,
    threadId: input.id,
    usedFallback: false,
  }));
  const post = vi.fn(async () => ({
    id: `thread-post-${randomUUID()}`,
    threadId: input.id,
  }));
  const thread = {
    id: input.id,
    channelId: input.channelId,
    isDM: input.isDM ?? false,
    channel: { id: input.channelId, name: input.name ?? input.channelId },
    adapter: { addReaction },
    startTyping,
    subscribe,
    post,
    postEphemeral,
  } as unknown as Thread;
  return {
    thread,
    addReaction,
    startTyping,
    subscribe,
    post,
    postEphemeral,
  };
}

export function makeMessage(input: {
  attachments?: Attachment[];
  id: string;
  raw?: unknown;
  text: string;
  mentioned?: boolean;
  userId?: string;
  userName?: string;
}) {
  return {
    id: input.id,
    raw: input.raw,
    text: input.text,
    isMention: input.mentioned ?? false,
    attachments: input.attachments ?? [],
    metadata: { dateSent: new Date(), edited: false },
    author: {
      userId: input.userId ?? "U-EXTERNAL",
      userName: input.userName ?? "alex",
      fullName: "Alex External",
      isBot: false,
      isMe: false,
      isSystem: false,
    } satisfies Author,
  } as unknown as Message;
}

export function boardActor(companyId: string, userId = "owner-user") {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "operator" }],
  };
}

export function routesApp(
  db: TestDb,
  companyId: string,
  service: ChatChannelService,
  userId = "owner-user",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor(companyId, userId);
    next();
  });
  app.use(
    "/api",
    chatChannelRoutes(db, {
      heartbeat: { wakeup: async () => undefined },
      service,
    }),
  );
  app.use(errorHandler);
  return app;
}

export function webhookApp(
  service: ChatChannelService,
  diagnostics?: (event: ChatWebhookDiagnosticEvent) => void,
) {
  const app = express();
  if (diagnostics) app.use(createChatWebhookDiagnostics({ emit: diagnostics }));
  app.use(express.raw({ type: "*/*" }));
  app.use(chatWebhookRoutes(service));
  app.use(errorHandler);
  return app;
}
