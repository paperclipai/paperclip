import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  assets,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatMessageLinks,
  chatPublications,
  companySecrets,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import type { Attachment, Author, Message, Thread } from "chat";
import { errorHandler } from "../middleware/index.js";
import {
  chatChannelRoutes,
  chatWebhookRoutes,
} from "../routes/chat-channels.js";
import {
  chatChannelService,
  type ChatChannelServiceOptions,
  type ChatChannelService,
} from "../services/chat-channels.js";
import type {
  CreateChatSdkEndpointRuntimeOptions,
  ChatSdkMessageTrigger,
  ChatSdkRuntime,
} from "../services/chat-sdk-runtime.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import type { StorageService } from "../storage/types.js";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../services/chat-interaction-publications.js";
import { enqueueChatRunMilestones } from "../services/chat-run-publications.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat-channel integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestDb = ReturnType<typeof createDb>;

class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  readonly posts: Array<{
    threadId: string;
    text: string;
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
  readonly rehydratedAttachmentDescriptors: unknown[] = [];
  private nextPostId = 0;
  postError: Error | null = null;
  editError: Error | null = null;
  webhookRequest: Request | null = null;
  webhookResponse = new Response("accepted", {
    status: 202,
    headers: { "x-chat-test": "accepted" },
  });

  constructor(
    private readonly options: CreateChatSdkEndpointRuntimeOptions,
    private readonly attachmentBodies: Map<string, Buffer>,
  ) {}

  async handleWebhook(request: Request) {
    this.webhookRequest = request;
    return this.webhookResponse;
  }

  acceptsProviderScope(raw: unknown) {
    if (this.options.providerConfig.provider !== "microsoft-teams") return true;
    const expected = this.options.providerConfig.credentials.appTenantId;
    if (!expected || !raw || typeof raw !== "object") return Boolean(!expected);
    const payload = raw as {
      conversation?: { tenantId?: unknown };
      channelData?: { tenant?: { id?: unknown } };
    };
    const tenantIds = [
      payload.conversation?.tenantId,
      payload.channelData?.tenant?.id,
    ].filter((value): value is string => typeof value === "string");
    return (
      tenantIds.length > 0 && tenantIds.every((value) => value === expected)
    );
  }

  thread(threadId: string) {
    const channelId = threadId.split(":")[1] ?? threadId;
    return {
      id: threadId,
      channelId,
      isDM: /^D[A-Z0-9-]*$/i.test(channelId),
      channel: {
        id: channelId,
        name: "command-thread",
      },
      adapter: {
        addReaction: async () => undefined,
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
        if (this.postError) throw this.postError;
        let text: string;
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
          "files" in message &&
          Array.isArray((message as { files?: unknown }).files)
        ) {
          files = (message as { files: unknown[] }).files;
        }
        this.posts.push({
          threadId,
          text,
          ...(chunks ? { chunks } : {}),
          ...(files ? { files } : {}),
        });
        this.nextPostId += 1;
        return { id: `outbound-${this.nextPostId}`, threadId };
      },
    };
  }

  attachmentRecoveryDescriptor(attachment: Attachment) {
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

  rehydrateAttachment(descriptor: unknown): Attachment | null {
    this.rehydratedAttachmentDescriptors.push(descriptor);
    if (!descriptor || typeof descriptor !== "object") return null;
    const value = descriptor as {
      version?: unknown;
      provider?: unknown;
      attachment?: Attachment;
      locator?: { kind?: unknown; recoveryKey?: unknown };
    };
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
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<
    string,
    CreateChatSdkEndpointRuntimeOptions
  >();

  constructor(readonly attachmentBodies: Map<string, Buffer> = new Map()) {}

  get(endpointId: string) {
    return this.endpoints.get(endpointId) ?? null;
  }

  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(options, this.attachmentBodies);
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

const TEST_SLACK_BOT_SCOPES =
  "app_mentions:read,channels:history,channels:read,chat:write,commands,files:read,files:write,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,reactions:read,reactions:write,users:read";

function fakeSlackFetch(botId = `U-BOT-${randomUUID()}`) {
  return (input: string | URL | Request) => {
    const url = String(input);
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
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function fakeTelegramFetch(
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
    if (url.endsWith("/setWebhook") || url.endsWith("/deleteWebhook")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

function makeThread(input: {
  channelId: string;
  id: string;
  isDM?: boolean;
  name?: string;
}) {
  const addReaction = vi.fn(async () => undefined);
  const startTyping = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => undefined);
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
  } as unknown as Thread;
  return { thread, addReaction, startTyping, subscribe, post };
}

function makeMessage(input: {
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

function boardActor(companyId: string, userId = "owner-user") {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "operator" }],
  };
}

function routesApp(
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

function webhookApp(service: ChatChannelService) {
  const app = express();
  app.use(express.raw({ type: "*/*" }));
  app.use(chatWebhookRoutes(service));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("chat channel control-plane integration", () => {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-chat-channels-${randomUUID()}`,
  );

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secretsTmpDir,
      "master.key",
    );
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-chat-channels-",
      );
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const assignedAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Chat Test ${companyId.slice(0, 8)}`,
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id: "owner-user",
        name: "Owner User",
        email: "owner-user@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: "owner-user",
      permissionKey: "tools:manage_connections",
      scope: null,
      grantedByUserId: "owner-user",
    });
    await db.insert(agents).values([
      {
        id: assignedAgentId,
        companyId,
        name: "Maya",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: replacementAgentId,
        companyId,
        name: "Linus",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, assignedAgentId, replacementAgentId };
  }

  function createService(
    runtime = new FakeChatSdkRuntime(),
    providerFetch: typeof globalThis.fetch = fakeSlackFetch() as typeof globalThis.fetch,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        "deferWebhookProcessing" | "scheduleDeferredWork" | "storage"
      >
    > = {},
  ) {
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      fetch: providerFetch,
      heartbeat: { wakeup },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      ...overrides,
    });
    return { runtime, service, wakeup };
  }

  function createStorageService() {
    const objects = new Map<string, Buffer>();
    const putFile = vi.fn<StorageService["putFile"]>(async (input) => {
      const objectKey = `${input.namespace}/${randomUUID()}-${input.originalFilename ?? "attachment"}`;
      objects.set(objectKey, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile,
      getObject: vi.fn(async (_companyId, objectKey) => {
        const body = objects.get(objectKey);
        if (!body) throw new Error(`Missing test object ${objectKey}`);
        return {
          stream: Readable.from([body]),
          contentLength: body.length,
        };
      }),
      headObject: vi.fn(async (_companyId, objectKey) => ({
        exists: objects.has(objectKey),
        contentLength: objects.get(objectKey)?.length,
      })),
      deleteObject: vi.fn(async (_companyId, objectKey) => {
        objects.delete(objectKey);
      }),
    };
    return { objects, putFile, storage };
  }

  async function recordSlackUrlVerification(
    service: ChatChannelService,
    publicId: string,
  ) {
    await service.handleWebhook(
      publicId,
      "slack",
      new Request(
        `https://paperclip.example/api/chat-webhooks/${publicId}/slack`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "url_verification",
            challenge: "verified-challenge",
          }),
        },
      ),
    );
  }

  async function chatWakeContext(input: {
    endpointId: string;
    issueId: string;
    provider: ChatProvider;
    providerMessageId: string;
  }) {
    const wakeCommentId = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, input.endpointId),
          eq(chatMessageLinks.providerMessageId, input.providerMessageId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .then((rows) => rows[0]?.commentId ?? null);
    if (!wakeCommentId) {
      throw new Error(
        `Expected inbound comment link ${input.providerMessageId}`,
      );
    }
    return {
      issueId: input.issueId,
      source: `chat:${input.provider}`,
      wakeCommentId,
      wakeCommentIds: [wakeCommentId],
    };
  }

  async function qualifySetupRoundTrip(
    service: ChatChannelService,
    endpointId: string,
    userId = "U-EXTERNAL",
  ) {
    const endpoint = await service.get(endpointId);
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpointId))
      .then((rows) => rows.at(-1));
    if (!conversation) throw new Error("Expected setup conversation");
    const fakeRuntime = service.runtime as unknown as FakeChatSdkRuntime;
    const callbacks = fakeRuntime.configurations.get(endpointId)?.callbacks;
    if (!callbacks) throw new Error("Expected setup callbacks");
    const { thread } = makeThread({
      id: conversation.externalThreadId,
      channelId: conversation.externalConversationId,
      isDM: conversation.isDirectMessage,
      name: conversation.externalLabel,
    });
    const setupFollowUpMessageId = `setup-follow-up-${randomUUID()}`;
    await callbacks.onMessage({
      endpointId,
      provider: endpoint.provider,
      thread,
      message: makeMessage({
        id: setupFollowUpMessageId,
        text: "Setup follow-up",
        userId,
      }),
      trigger:
        endpoint.provider === "telegram"
          ? "direct_message"
          : "subscribed_message",
    });
    const contextSnapshot = await chatWakeContext({
      endpointId,
      issueId: conversation.issueId,
      provider: endpoint.provider,
      providerMessageId: setupFollowUpMessageId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: endpoint.companyId,
      agentId: endpoint.assignedAgentId,
      status: "succeeded",
      contextSnapshot,
    });
    await issueService(db).addComment(
      conversation.issueId,
      "Setup round trip complete",
      { agentId: endpoint.assignedAgentId, runId },
      { authorType: "agent" },
    );
    await service.processPendingPublications();
    const providerRuntime = fakeRuntime.endpoints.get(endpointId);
    if (providerRuntime) providerRuntime.posts.length = 0;
  }

  async function configuredSlackEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides?: { allowUnlinkedPeople?: boolean },
  ) {
    const context = createService();
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Slack",
      },
      "owner-user",
    );
    if (overrides?.allowUnlinkedPeople !== undefined) {
      await context.service.update(
        endpoint.id,
        {
          allowUnlinkedPeople: overrides.allowUnlinkedPeople,
        },
        "owner-user",
      );
    }
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(context.service, endpoint.publicId);
    await context.service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function configuredTeamsEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        "deferWebhookProcessing" | "scheduleDeferredWork"
      >
    > = {},
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-test-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Teams",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: randomUUID(),
          tenantId: randomUUID(),
          clientSecret: "teams-test-secret",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Teams callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function configuredGitHubEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        "deferWebhookProcessing" | "scheduleDeferredWork" | "storage"
      >
    > = {},
  ) {
    let installationId = 2468;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const providerFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({
            id: 789,
            slug: `maya-${fixture.companyId.slice(0, 8)}`,
            name: "Maya Paperclip",
            owner: { login: "paperclipai" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            events: [
              "github_app_authorization",
              "installation",
              "installation_repositories",
              "issue_comment",
              "pull_request_review_comment",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/app/installations?per_page=100") {
        return new Response(
          JSON.stringify([
            {
              id: installationId,
              account: { id: 1357, login: "paperclipai", type: "Organization" },
              suspended_at: null,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url ===
        `https://api.github.com/app/installations/${installationId}/access_tokens`
      ) {
        return new Response(JSON.stringify({ token: "installation-token" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        url ===
        "https://api.github.com/installation/repositories?per_page=100&page=1"
      ) {
        return new Response(
          JSON.stringify({
            repositories: [
              {
                id: 97531,
                full_name: "paperclipai/paperclip",
                html_url: "https://github.com/paperclipai/paperclip",
                owner: { id: 1357, login: "paperclipai" },
                private: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const context = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
      overrides,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in GitHub",
      },
      "owner-user",
    );
    await context.service.generateSetupSecret(endpoint.id, "owner-user");
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          appId: "123456",
          privateKey,
        },
      },
      "owner-user",
    );
    const resources = await context.service.listResources(endpoint.id);
    await context.service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: true },
    ]);
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive GitHub callbacks");
    return {
      ...context,
      endpoint,
      callbacks,
      setInstallationId(value: number) {
        installationId = value;
      },
    };
  }

  async function configuredTelegramEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
  ) {
    const context = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch() as typeof globalThis.fetch,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya in Telegram",
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-interaction-test" },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive Telegram callbacks");
    return { ...context, endpoint, callbacks };
  }

  async function deliverMessage(input: {
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    message: Message;
    provider?: ChatProvider;
    providerUpdateId?: number;
    thread: Thread;
    trigger: ChatSdkMessageTrigger;
  }) {
    await input.callbacks.onMessage({
      endpointId: input.endpointId,
      provider: input.provider ?? "slack",
      providerUpdateId: input.providerUpdateId,
      thread: input.thread,
      message: input.message,
      trigger: input.trigger,
    });
  }

  it("creates a channel-purpose connection and rejects attempts to change its assigned agent", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const app = routesApp(db, fixture.companyId, service);

    const createResponse = await request(app)
      .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
      .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      provider: "slack",
      assignedAgentId: fixture.assignedAgentId,
      assignedAgentName: "Maya",
      status: "draft",
      setup: { command: expect.stringMatching(/^\/maya-[a-z0-9]{6}$/) },
    });
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, createResponse.body.connectionId));
    expect(connection).toMatchObject({
      connectionPurpose: "channel",
      transport: "chat_sdk",
    });

    await request(app)
      .patch(`/api/chat-endpoints/${createResponse.body.id}`)
      .send({ assignedAgentId: fixture.replacementAgentId })
      .expect(400);
    const [stored] = await db
      .select({ assignedAgentId: chatEndpoints.assignedAgentId })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, createResponse.body.id));
    expect(stored.assignedAgentId).toBe(fixture.assignedAgentId);
  });

  it("requires connection-manager authority for chat connector administration", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const memberUserId = `member-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: memberUserId,
      name: "Ordinary Member",
      email: `${memberUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: memberUserId,
      status: "active",
      membershipRole: "member",
    });

    const memberApp = routesApp(db, fixture.companyId, service, memberUserId);
    await request(memberApp)
      .get(`/api/chat-endpoints/${endpoint.id}`)
      .expect(200);
    await request(memberApp)
      .get(`/api/companies/${fixture.companyId}/chat-endpoints`)
      .expect(200);

    const deniedMutations = [
      request(memberApp)
        .post(`/api/companies/${fixture.companyId}/chat-endpoints`)
        .send({ provider: "slack", assignedAgentId: fixture.assignedAgentId }),
      request(memberApp)
        .patch(`/api/chat-endpoints/${endpoint.id}`)
        .send({ allowDirectMessages: true }),
      request(memberApp)
        .post(`/api/chat-endpoints/${endpoint.id}/setup`)
        .send({ action: "pause" }),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/setup-secret`,
      ),
      request(memberApp).post(`/api/chat-endpoints/${endpoint.id}/test`),
      request(memberApp)
        .put(`/api/chat-endpoints/${endpoint.id}/resources`)
        .send({ resources: [] }),
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/principals/${randomUUID()}/link-intent`,
        )
        .send({}),
      request(memberApp).delete(
        `/api/chat-endpoints/${endpoint.id}/principals/${randomUUID()}/link`,
      ),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/deliveries/${randomUUID()}/replay`,
      ),
      request(memberApp).post(
        `/api/chat-endpoints/${endpoint.id}/publications/${randomUUID()}/replay`,
      ),
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/publications/${randomUUID()}/resolve`,
        )
        .send({ action: "cancel" }),
    ];
    for (const mutation of deniedMutations) {
      const response = await mutation.expect(403);
      expect(response.body.error).toBe(
        "Missing permission: tools:manage_connections",
      );
    }

    const managerApp = routesApp(db, fixture.companyId, service);
    await request(managerApp)
      .patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ allowDirectMessages: true })
      .expect(200)
      .expect(({ body }) => {
        expect(body.allowDirectMessages).toBe(true);
      });
  });

  it("returns not found rather than revealing another company's chat endpoint", async () => {
    const viewerCompany = await seedCompany();
    const ownerCompany = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      ownerCompany.companyId,
      {
        provider: "telegram",
        assignedAgentId: ownerCompany.assignedAgentId,
      },
      "owner-user",
    );
    const app = routesApp(db, viewerCompany.companyId, service);

    await request(app).get(`/api/chat-endpoints/${endpoint.id}`).expect(404);
    await request(app)
      .patch(`/api/chat-endpoints/${endpoint.id}`)
      .send({ allowDirectMessages: true })
      .expect(404);
  });

  it("does not let two live agent connections claim the same native bot or spoof its verified identity", async () => {
    const fixture = await seedCompany();
    const { service } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-ONE-NATIVE-BOT") as typeof globalThis.fetch,
    );
    const first = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const second = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.replacementAgentId,
      },
      "owner-user",
    );
    await service.configure(
      first.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-first-agent",
          signingSecret: "first-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(
      service.configure(
        second.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-second-agent",
            signingSecret: "second-signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_bot_identity_in_use",
        endpointId: first.id,
        assignedAgentId: fixture.assignedAgentId,
      },
    });

    const app = routesApp(db, fixture.companyId, service);
    await request(app)
      .post(`/api/chat-endpoints/${second.id}/setup`)
      .send({
        action: "configure",
        providerAccountId: "T-SPOOFED",
        botExternalId: "U-SPOOFED",
        credentials: {
          botToken: "xoxb-spoof",
          signingSecret: "spoof-signing-secret",
        },
      })
      .expect(400);
  });

  it("configures a customer-owned GitHub App and only auto-enables the first addressed setup repository", async () => {
    const fixture = await seedCompany();
    const appId = "123456";
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let observedIssuer: string | null = null;
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/app") {
          const authorization = new Headers(init?.headers).get("authorization");
          const token = authorization?.replace(/^Bearer\s+/i, "");
          const payload = token?.split(".")[1];
          if (!payload) throw new Error("GitHub App JWT was not sent");
          observedIssuer = String(
            (
              JSON.parse(
                Buffer.from(payload, "base64url").toString("utf8"),
              ) as { iss?: unknown }
            ).iss,
          );
          return new Response(
            JSON.stringify({
              id: 789,
              slug: "maya-paperclip",
              name: "Maya Paperclip",
              owner: { login: "paperclipai" },
              permissions: {
                issues: "write",
                metadata: "read",
                pull_requests: "write",
              },
              events: [
                "github_app_authorization",
                "installation",
                "installation_repositories",
                "issue_comment",
                "pull_request_review_comment",
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://api.github.com/app/installations?per_page=100") {
          return new Response(
            JSON.stringify([
              {
                id: 2468,
                account: {
                  id: 1357,
                  login: "paperclipai",
                  type: "Organization",
                },
                suspended_at: null,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (
          url === "https://api.github.com/app/installations/2468/access_tokens"
        ) {
          return new Response(JSON.stringify({ token: "installation-token" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url ===
          "https://api.github.com/installation/repositories?per_page=100&page=1"
        ) {
          return new Response(
            JSON.stringify({
              repositories: [
                {
                  id: 97531,
                  full_name: "paperclipai/paperclip",
                  html_url: "https://github.com/paperclipai/paperclip",
                  owner: { id: 1357, login: "paperclipai" },
                  private: false,
                },
                {
                  id: 97532,
                  full_name: "paperclipai/paperclip-disabled",
                  html_url: "https://github.com/paperclipai/paperclip-disabled",
                  owner: { id: 1357, login: "paperclipai" },
                  private: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider request: ${url}`);
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const app = routesApp(db, fixture.companyId, service);
    const generatedSecretResponse = await request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
      .send({})
      .expect(201);
    const generatedWebhookSecret = generatedSecretResponse.body
      .webhookSecret as string;
    expect(generatedSecretResponse.headers["cache-control"]).toBe("no-store");
    expect(generatedWebhookSecret).toMatch(/^[a-f0-9]{64}$/);
    const endpointAfterGeneration = await request(app)
      .get(`/api/chat-endpoints/${endpoint.id}`)
      .expect(200);
    expect(endpointAfterGeneration.body.setup.webhookSecretConfigured).toBe(
      true,
    );
    expect(JSON.stringify(endpointAfterGeneration.body)).not.toContain(
      generatedWebhookSecret,
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          appId,
          privateKey,
        },
      },
      "owner-user",
    );

    expect(observedIssuer).toBe(appId);
    expect(configured).toMatchObject({
      status: "verifying",
      providerAccountId: "paperclipai",
      botUsername: "maya-paperclip[bot]",
      setup: { step: "test" },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: {
        appId,
        privateKey,
        installationId: 2468,
        webhookSecret: generatedWebhookSecret,
      },
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    const githubResources = await service.listResources(endpoint.id);
    expect(
      githubResources.map((resource) => ({
        providerResourceId: resource.providerResourceId,
        availability: resource.availability,
        enabled: resource.enabled,
      })),
    ).toEqual([
      {
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: false,
      },
      {
        providerResourceId: "paperclipai/paperclip-disabled",
        availability: "available",
        enabled: false,
      },
    ]);
    const githubCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!githubCallbacks) throw new Error("Expected GitHub callbacks");
    await deliverMessage({
      callbacks: githubCallbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "PaperclipAI/Paperclip",
        id: "github:PaperclipAI/Paperclip:issue:17",
        name: "paperclipai/paperclip",
      }).thread,
      message: makeMessage({
        id: "github-root-17",
        text: "@maya triage issue 17",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).resolves.toHaveLength(1);
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        providerResourceId: resource.providerResourceId,
        enabled: resource.enabled,
      })),
    ).toEqual([
      { providerResourceId: "paperclipai/paperclip", enabled: true },
      {
        providerResourceId: "paperclipai/paperclip-disabled",
        enabled: false,
      },
    ]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation_repositories",
          "x-github-delivery": "github-repository-removed",
        },
        body: JSON.stringify({
          action: "removed",
          repositories_added: [],
          repositories_removed: [
            {
              id: 97531,
              full_name: "paperclipai/paperclip",
              html_url: "https://github.com/paperclipai/paperclip",
              owner: { id: 1357, login: "paperclipai" },
            },
          ],
        }),
      }),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "removed",
        enabled: true,
      }),
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip-disabled",
        availability: "available",
        enabled: false,
      }),
    ]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "github-installation-suspended",
        },
        body: JSON.stringify({
          action: "suspend",
          installation: { id: 2468 },
        }),
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "GitHub App installation was suspended",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
  });

  it("rejects caller-controlled GitHub setup secrets and arbitrary credential fields", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async () => {
      throw new Error("Credential validation must run before provider access");
    }) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.generateSetupSecret(endpoint.id, "owner-user");
    const app = routesApp(db, fixture.companyId, service);

    await request(app)
      .post(`/api/chat-endpoints/${endpoint.id}/setup`)
      .send({
        action: "configure",
        credentials: {
          appId: "123456",
          privateKey: "private-key",
          webhookSecret: "caller-controlled-secret",
        },
      })
      .expect(422);
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            appId: "123456",
            privateKey: "private-key",
            installationId: "2468",
            unexpected: "value",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_endpoint_credentials_invalid",
        provider: "github",
        action: "configure",
        unsupportedKeys: ["installationId", "unexpected"],
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it("rejects over-scoped GitHub Apps while tolerating unavoidable lifecycle events", async () => {
    const fixture = await seedCompany();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const { service } = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://api.github.com/app") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          id: 991123,
          slug: "maya-over-scoped",
          name: "Maya Over-scoped",
          owner: { login: "paperclipai" },
          permissions: {
            contents: "read",
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
          events: [
            "github_app_authorization",
            "installation",
            "installation_repositories",
            "issue_comment",
            "pull_request_review_comment",
            "push",
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.generateSetupSecret(endpoint.id, "owner-user");

    await expect(
      service.configure(
        endpoint.id,
        { action: "configure", credentials: { appId: "991123", privateKey } },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: [],
        excessivePermissions: ["contents"],
        missingEvents: [],
        excessiveEvents: ["push"],
      },
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it("rejects under-scoped Slack and GitHub apps before saving provider credentials", async () => {
    const fixture = await seedCompany();
    const slack = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://slack.com/api/auth.test") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T-UNDER-SCOPED",
          team: "Under-scoped",
          user_id: "U-UNDER-SCOPED",
          user: "maya-under-scoped",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "chat:write",
          },
        },
      );
    }) as typeof globalThis.fetch);
    const slackEndpoint = await slack.service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await expect(
      slack.service.configure(
        slackEndpoint.id,
        {
          action: "configure",
          credentials: {
            botToken: "xoxb-under-scoped",
            signingSecret: "signing-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "slack",
      },
    });

    const appId = "991122";
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const github = createService(new FakeChatSdkRuntime(), (async (
      input: string | URL | Request,
    ) => {
      if (String(input) !== "https://api.github.com/app") {
        throw new Error(`Unexpected provider request: ${String(input)}`);
      }
      return new Response(
        JSON.stringify({
          id: 991122,
          slug: "maya-under-scoped",
          name: "Maya Under-scoped",
          owner: { login: "paperclipai" },
          permissions: {
            issues: "read",
            metadata: "read",
            pull_requests: "write",
          },
          events: ["issue_comment"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);
    const githubEndpoint = await github.service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await github.service.generateSetupSecret(githubEndpoint.id, "owner-user");
    await expect(
      github.service.configure(
        githubEndpoint.id,
        {
          action: "configure",
          credentials: {
            appId,
            privateKey,
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: ["issues"],
      },
    });

    const connections = await db
      .select({
        id: toolConnections.id,
        refs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(
        inArray(toolConnections.id, [
          slackEndpoint.connectionId,
          githubEndpoint.connectionId,
        ]),
      );
    expect(
      connections.find(
        (connection) => connection.id === slackEndpoint.connectionId,
      )?.refs,
    ).toEqual([]);
    expect(
      connections.find(
        (connection) => connection.id === githubEndpoint.connectionId,
      )?.refs,
    ).toEqual([
      expect.objectContaining({ configPath: "credentials.webhookSecret" }),
    ]);
  });

  it("rotates a live GitHub webhook secret fail-closed and reconnects with stored credentials", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );

    expect(webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "Update the GitHub webhook secret, then reconnect this App",
      setup: { step: "provider_setup", webhookSecretConfigured: true },
    });
    const [disabledConnection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(disabledConnection).toEqual({
      status: "disabled",
      enabled: false,
      healthStatus: "degraded",
    });

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );

    expect(reconnected).toMatchObject({
      status: "verifying",
      setup: { step: "test", webhookSecretConfigured: true },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        webhookSecret,
      },
    });
    expect(JSON.stringify(reconnected)).not.toContain(webhookSecret);
  });

  it("serializes concurrent GitHub setup-secret requests without losing stored credentials", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const app = routesApp(db, fixture.companyId, service);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
    ]);
    const rotatedSecrets = [
      first.body.webhookSecret as string,
      second.body.webhookSecret as string,
    ];
    expect(rotatedSecrets[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSecrets[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSecrets[0]).not.toBe(rotatedSecrets[1]);

    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    await expect(
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, endpoint.connectionId),
            eq(activityLog.action, "chat_endpoint.setup_secret_generated"),
          ),
        ),
    ).resolves.toHaveLength(3);
    await expect(
      db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);

    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    const providerConfig = runtime.configurations.get(
      endpoint.id,
    )?.providerConfig;
    expect(providerConfig).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        installationId: 2468,
        privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
      },
    });
    if (providerConfig?.provider !== "github")
      throw new Error("Expected GitHub provider configuration");
    expect(rotatedSecrets).toContain(providerConfig.credentials.webhookSecret);
  });

  it("serializes a GitHub secret rotation racing reconnect and preserves the rotated secret", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const app = routesApp(db, fixture.companyId, service);

    const [rotation] = await Promise.all([
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup`)
        .send({ action: "reconnect" })
        .expect(200),
    ]);
    const rotatedSecret = rotation.body.webhookSecret as string;
    expect(rotatedSecret).toMatch(/^[a-f0-9]{64}$/);

    // The final state depends on which request acquired the lease first. A
    // final reconnect must consume the complete, most recent credential set
    // in either ordering.
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    const providerConfig = runtime.configurations.get(
      endpoint.id,
    )?.providerConfig;
    expect(providerConfig).toMatchObject({
      provider: "github",
      credentials: {
        appId: "123456",
        installationId: 2468,
        privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
        webhookSecret: rotatedSecret,
      },
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection!.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.appId",
      "credentials.installationId",
      "credentials.privateKey",
      "credentials.webhookSecret",
    ]);
    await expect(
      db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);
  });

  it("does not rotate a GitHub webhook secret when stored credentials cannot be resolved", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const [connectionBefore] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const appIdRef = connectionBefore!.refs.find(
      (ref) => ref.configPath === "credentials.appId",
    );
    if (!appIdRef) throw new Error("Expected stored GitHub App ID");
    await db
      .update(companySecrets)
      .set({ status: "disabled" })
      .where(eq(companySecrets.id, appIdRef.secretId));

    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "secret_inactive" },
    });

    const [connectionAfter] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connectionAfter!.refs).toEqual(connectionBefore!.refs);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete", webhookSecretConfigured: true },
    });
  });

  it("keeps GitHub issues, PR conversations, and inline review threads on distinct tasks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredGitHubEndpoint(fixture);
    const cases = [
      {
        id: "github:paperclipai/paperclip:issue:51",
        rootId: "51001",
      },
      { id: "github:paperclipai/paperclip:52", rootId: "52001" },
      {
        id: "github:paperclipai/paperclip:52:rc:88001",
        rootId: "88001",
      },
    ];
    for (const item of cases) {
      const thread = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: item.id,
        name: "paperclipai/paperclip",
      });
      const rootDelivery = {
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: item.rootId,
          text: `@maya handle ${item.id}`,
          mentioned: true,
        }),
        trigger: "mention",
      } as const;
      await deliverMessage(rootDelivery);
      if (item === cases[0]) await deliverMessage(rootDelivery);
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id: `${item.rootId}-reply`,
          text: "Unmentioned follow-up",
        }),
        trigger: "subscribed_message",
      });
    }

    const conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversations).toHaveLength(3);
    expect(new Set(conversations.map((row) => row.issueId)).size).toBe(3);
    expect(conversations.map((row) => row.externalThreadId).sort()).toEqual(
      cases.map((item) => item.id).sort(),
    );
    const deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(deliveries).toHaveLength(6);
    expect(deliveries.every((row) => row.state === "processed")).toBe(true);
    expect(
      deliveries.find((row) => row.providerEventId.endsWith(":51001")),
    ).toMatchObject({
      normalizedEvent: { deduplication: { duplicateCount: 1 } },
    });
    expect(
      deliveries.filter(
        (row) => row.normalizedEvent.trigger === "subscribed_message",
      ),
    ).toHaveLength(3);
  });

  it("reorders same-second GitHub callbacks by comment id before starting the task", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:71",
      name: "paperclipai/paperclip",
    });
    const providerSentAt = new Date("2026-09-05T18:00:00.000Z");
    const laterReply = makeMessage({
      id: "71002",
      text: "unmentioned follow-up delivered first",
    });
    laterReply.metadata.dateSent = providerSentAt;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: laterReply,
      trigger: "unaddressed_message",
    });
    const earlierMention = makeMessage({
      id: "71001",
      text: "@maya start the GitHub task",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = providerSentAt;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });

    const durable = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(durable).toHaveLength(2);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));
      expect(rows).toHaveLength(1);
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    await vi.waitFor(async () => {
      const rows = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      expect(rows.map((row) => row.body)).toEqual([
        "@maya start the GitHub task",
        "unmentioned follow-up delivered first",
      ]);
    });
    expect(wakeup).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("holds a GitHub follow-up that arrives after the reorder window until its older root mention arrives", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:72",
      name: "paperclipai/paperclip",
    });
    const laterReply = makeMessage({
      id: "72002",
      text: "follow-up delivered well before its root callback",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:00:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: laterReply,
      trigger: "unaddressed_message",
    });
    const [replyDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, replyDelivery!.id));

    await service.processPendingDeliveries(25, replyDelivery!.id);

    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, replyDelivery!.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "retry",
        attempts: 1,
        redactedError: "Waiting briefly for an earlier root mention",
      }),
    ]);
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();

    const earlierMention = makeMessage({
      id: "72001",
      text: "@maya start the delayed GitHub task",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = new Date("2026-09-05T18:00:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });
    const mentionDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${thread.thread.id}:72001`),
        ),
      )
      .then((rows) => rows[0]);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, mentionDelivery!.id));
    await service.processPendingDeliveries(25, mentionDelivery!.id);

    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversation).toBeDefined();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, replyDelivery!.id));
    await service.processPendingDeliveries(25, replyDelivery!.id);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya start the delayed GitHub task",
      "follow-up delivered well before its root callback",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(1);
    await service.shutdown();
  });

  it("filters a standalone unaddressed GitHub comment after one orphan grace attempt", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:73",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "73001",
        text: "ordinary comment that never mentions the agent",
      }),
      trigger: "unaddressed_message",
    });
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    for (const expectedAttempt of [1, 2]) {
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date() })
        .where(eq(chatDeliveries.id, delivery!.id));
      await service.processPendingDeliveries(25, delivery!.id);
      const current = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery!.id))
        .then((rows) => rows[0]);
      expect(current).toMatchObject({
        state: expectedAttempt === 1 ? "retry" : "filtered",
        attempts: expectedAttempt,
      });
    }
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await service.shutdown();
  });

  it("recovers a revoked GitHub installation on the same endpoint with its new installation id", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, runtime, service } = context;
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:61",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "61001",
        text: "@maya establish the recoverable thread",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));

    await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "github-installation-deleted",
        },
        body: JSON.stringify({
          action: "deleted",
          installation: { id: 2468 },
        }),
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    context.setInstallationId(8642);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "github-installation-recreated",
        },
        body: JSON.stringify({
          action: "created",
          installation: { id: 8642 },
        }),
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: true,
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    const publication = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Recovered GitHub response",
      "recovered-github-response",
      "owner-user",
    );
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "github",
      credentials: { installationId: 8642 },
    });
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, publication!.id)),
    ).resolves.toEqual([expect.objectContaining({ state: "published" })]);
  });

  it("acknowledges signed GitHub webhooks from another installation without admitting them", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub runtime");
    providerRuntime.webhookRequest = null;
    const payload = JSON.stringify({
      action: "deleted",
      installation: { id: 9999 },
    });
    const signature = createHmac("sha256", "github-webhook-secret")
      .update(payload)
      .digest("hex");

    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "foreign-installation-deleted",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect(providerRuntime.webhookRequest).toBeNull();
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toHaveLength(0);
  });

  it("configures a customer-owned Microsoft Teams bot with the entered credentials", async () => {
    const fixture = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000001";
    const tenantId = "00000000-0000-4000-8000-000000000002";
    const clientSecret = "teams-client-secret";
    let observedTokenRequest: URLSearchParams | null = null;
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        );
        expect(init?.method).toBe("POST");
        observedTokenRequest = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { clientId, tenantId, clientSecret },
      },
      "owner-user",
    );

    expect(Object.fromEntries(observedTokenRequest ?? [])).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    expect(configured).toMatchObject({
      status: "verifying",
      providerAccountId: tenantId,
      botExternalId: clientId,
      capabilities: {
        nativeStreaming: false,
        messageEdits: true,
        messageDeletes: false,
      },
      setup: { step: "test" },
    });
    expect(
      runtime.configurations.get(endpoint.id)?.providerConfig,
    ).toMatchObject({
      provider: "microsoft-teams",
      credentials: {
        appId: clientId,
        appPassword: clientSecret,
        appTenantId: tenantId,
        appType: "SingleTenant",
      },
    });
  });

  it("coalesces one Microsoft Teams run into one provider reply", async () => {
    const fixture = await seedCompany();
    const context = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-run-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const endpoint = await context.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: "00000000-0000-4000-8000-000000000411",
          tenantId: "00000000-0000-4000-8000-000000000422",
          clientSecret: "teams-run-secret",
        },
      },
      "owner-user",
    );
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks) throw new Error("Expected Teams callbacks");
    const thread = makeThread({
      channelId: "teams-personal-run",
      id: "teams:personal-run:root-1",
      isDM: true,
      name: "Alex External",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-run-root-1",
        text: "@Maya produce one quiet Teams response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    if (!conversation) throw new Error("Expected Teams conversation");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "microsoft-teams",
        providerMessageId: "teams-run-root-1",
      }),
    });
    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${progressState}:${endpoint.id}`,
        payload: {
          text:
            progressState === "queued" ? "Maya is queued." : "Maya is working…",
          progressState,
        },
        state: "pending",
      });
      await context.service.processPendingPublications();
    }
    await issueService(db).addComment(
      conversation.issueId,
      "Final Teams result",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent" },
    );
    await context.service.processPendingPublications();

    const providerRuntime = context.runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is queued." },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya is working…",
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Final Teams result",
      },
    ]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      publications.every(
        (publication) =>
          publication.state === "published" &&
          publication.providerMessageId === "outbound-1",
      ),
    ).toBe(true);
  });

  it("configures Telegram by verifying getMe and registering the Paperclip webhook", async () => {
    const fixture = await seedCompany();
    const botToken = "123456:telegram-test-token";
    const botId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    const observedUrls: string[] = [];
    let existingWebhookUrl = "";
    let observedWebhook: Record<string, unknown> | null = null;
    let observedWebhookDelete: Record<string, unknown> | null = null;
    const providerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        observedUrls.push(url);
        if (url.endsWith("/getMe")) {
          expect(init).toBeUndefined();
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: botId,
                username: "maya_paperclip_bot",
                first_name: "Maya",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/getWebhookInfo")) {
          expect(init).toBeUndefined();
          return new Response(
            JSON.stringify({ ok: true, result: { url: existingWebhookUrl } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/setWebhook")) {
          expect(init?.method).toBe("POST");
          observedWebhook = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          existingWebhookUrl = String(observedWebhook.url ?? "");
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/deleteWebhook")) {
          expect(init?.method).toBe("POST");
          observedWebhookDelete = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      },
    ) as unknown as typeof globalThis.fetch;
    const { runtime, service } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken },
      },
      "owner-user",
    );

    expect(observedUrls).toEqual([
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
    ]);
    expect(configured).toMatchObject({
      status: "verifying",
      providerAccountId: String(botId),
      botExternalId: String(botId),
      botUsername: "maya_paperclip_bot",
      capabilities: { messageEdits: true, messageDeletes: false },
      setup: { step: "test" },
    });
    const providerConfig = runtime.configurations.get(
      endpoint.id,
    )?.providerConfig;
    expect(providerConfig).toMatchObject({
      provider: "telegram",
      credentials: { botToken, secretToken: expect.any(String) },
    });
    if (providerConfig?.provider !== "telegram")
      throw new Error("Telegram runtime configuration was not created");
    expect(observedWebhook).toEqual({
      url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/telegram`,
      secret_token: providerConfig.credentials.secretToken,
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "message_reaction",
        "my_chat_member",
      ],
      drop_pending_updates: true,
    });
    const [connection] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection.refs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.botToken",
      "credentials.webhookSecret",
    ]);

    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    existingWebhookUrl =
      "https://expired.example/api/chat-webhooks/old-public-id/telegram";
    observedUrls.length = 0;
    observedWebhook = null;

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );

    expect(reconnected).toMatchObject({
      status: "verifying",
      setup: { step: "test" },
    });
    expect(observedUrls).toEqual([
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getWebhookInfo`,
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
    ]);
    expect(observedWebhook).toMatchObject({
      url: `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/telegram`,
      drop_pending_updates: true,
    });

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    expect(observedWebhookDelete).toEqual({ drop_pending_updates: false });
    expect(observedUrls.at(-1)).toBe(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteWebhook`,
    );
  });

  it("reconciles Slack membership during configure, resume, and reconnect", async () => {
    const fixture = await seedCompany();
    let channels = [
      { id: "C-ONE", name: "one", is_member: true, is_archived: false },
    ];
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-RECONCILE",
            team: "Reconcile Test",
            user_id: "U-RECONCILE",
            user: "maya-reconcile",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels,
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-ONE",
        availability: "available",
        enabled: false,
      }),
    ]);

    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    channels = [
      { id: "C-TWO", name: "two", is_member: true, is_archived: false },
    ];
    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-TWO", availability: "available" },
    ]);

    await db
      .update(chatEndpoints)
      .set({ status: "attention" })
      .where(eq(chatEndpoints.id, endpoint.id));
    channels = [
      { id: "C-THREE", name: "three", is_member: true, is_archived: false },
    ];
    await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-reconcile",
          signingSecret: "reconcile-signing-secret",
        },
      },
      "owner-user",
    );
    expect(
      (await service.listResources(endpoint.id)).map((resource) => ({
        id: resource.providerResourceId,
        availability: resource.availability,
      })),
    ).toEqual([
      { id: "C-ONE", availability: "unavailable" },
      { id: "C-THREE", availability: "available" },
      { id: "C-TWO", availability: "unavailable" },
    ]);
  });

  it("rejects reconnect credentials for a different Slack bot without rotating secrets", async () => {
    const fixture = await seedCompany();
    let botId = "U-ORIGINAL-BOT";
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-IMMUTABLE",
            team: "Immutable Test",
            user_id: botId,
            user: botId === "U-ORIGINAL-BOT" ? "maya-original" : "maya-other",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-original",
          signingSecret: "original-secret",
        },
      },
      "owner-user",
    );
    const [before] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));

    botId = "U-DIFFERENT-BOT";
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: {
            botToken: "xoxb-different",
            signingSecret: "different-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });

    const [after] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(after.refs).toEqual(before.refs);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      botExternalId: "U-ORIGINAL-BOT",
    });
  });

  it("persists verified Slack membership and uninstall lifecycle before acknowledging", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const send = (payload: unknown) =>
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

    await send({
      event_id: "Ev-member-joined",
      event: {
        type: "member_joined_channel",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
        channel_type: "C",
      },
    });
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    expect(resource).toMatchObject({
      providerResourceId: "C-LIFECYCLE",
      availability: "available",
      enabled: false,
    });
    await service.replaceResources(endpoint.id, [
      { id: resource.id, enabled: true },
    ]);

    const thread = makeThread({
      channelId: "C-LIFECYCLE",
      id: "slack:C-LIFECYCLE:123.45",
      name: "lifecycle",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "123.45",
        text: "@maya preserve this task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversation).toBeDefined();

    const leftEvent = {
      event_id: "Ev-member-left",
      event: {
        type: "member_left_channel",
        user: configuredEndpoint.botExternalId,
        channel: "C-LIFECYCLE",
      },
    };
    await send(leftEvent);
    await send(leftEvent);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-LIFECYCLE",
        availability: "unavailable",
      }),
    ]);
    expect(
      await db
        .select({ state: chatConversations.state })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id)),
    ).toEqual([{ state: "unavailable" }]);
    expect(
      await db.select().from(issues).where(eq(issues.id, conversation.issueId)),
    ).toHaveLength(1);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: makeThread({
        channelId: "C-LIFECYCLE",
        id: "slack:C-LIFECYCLE:999.01",
        name: "lifecycle",
      }).thread,
      message: makeMessage({
        id: "999.01",
        text: "@maya this delayed root must stay blocked",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(1);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    expect(
      (
        await db
          .select()
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id))
      ).filter(
        (delivery) => delivery.providerEventId === "lifecycle:Ev-member-left",
      ),
    ).toHaveLength(1);

    await send({
      event_id: "Ev-uninstalled",
      event: { type: "app_uninstalled" },
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "Slack app was uninstalled",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toMatchObject({
      status: "disabled",
      enabled: false,
      healthStatus: "failed",
    });
  });

  it("applies Teams installation and Telegram membership resource lifecycle", async () => {
    const fixture = await seedCompany();
    const teams = createService(
      new FakeChatSdkRuntime(),
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const teamsEndpoint = await teams.service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const teamsClientId = "00000000-0000-4000-8000-000000000111";
    await teams.service.configure(
      teamsEndpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: teamsClientId,
          tenantId: "00000000-0000-4000-8000-000000000222",
          clientSecret: "teams-secret",
        },
      },
      "owner-user",
    );
    const teamsTenantId = "00000000-0000-4000-8000-000000000222";
    const teamsPayload = (action: "add" | "remove") => ({
      id: `teams-${action}`,
      type: "installationUpdate",
      action,
      conversation: {
        id: "19:conversation@thread.tacv2",
        isGroup: true,
        tenantId: teamsTenantId,
      },
      channelData: {
        tenant: { id: teamsTenantId },
        team: { id: "team-1", name: "Paperclip" },
        channel: { id: "channel-1", name: "Engineering" },
      },
    });
    const deliverTeamsLifecycle = (payload: unknown) =>
      teams.service.handleWebhook(
        teamsEndpoint.publicId,
        "microsoft-teams",
        new Request("https://paperclip.example/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    const foreignTenantPayload = teamsPayload("add");
    foreignTenantPayload.id = "teams-foreign-tenant";
    foreignTenantPayload.conversation.tenantId = "foreign-tenant";
    foreignTenantPayload.channelData.tenant.id = "foreign-tenant";
    await expect(
      deliverTeamsLifecycle(foreignTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    const missingTenantPayload = teamsPayload("add") as Omit<
      ReturnType<typeof teamsPayload>,
      "conversation" | "channelData"
    > & {
      conversation: Omit<
        ReturnType<typeof teamsPayload>["conversation"],
        "tenantId"
      >;
      channelData: Omit<
        ReturnType<typeof teamsPayload>["channelData"],
        "tenant"
      >;
    };
    delete (missingTenantPayload.conversation as { tenantId?: string })
      .tenantId;
    delete (missingTenantPayload.channelData as { tenant?: { id: string } })
      .tenant;
    missingTenantPayload.id = "teams-missing-tenant";
    await expect(
      deliverTeamsLifecycle(missingTenantPayload),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([]);
    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, teamsEndpoint.id)),
    ).resolves.toHaveLength(0);

    await deliverTeamsLifecycle(teamsPayload("add"));
    const [teamsResource] = await teams.service.listResources(teamsEndpoint.id);
    expect(teamsResource).toMatchObject({
      providerResourceId: "19:conversation@thread.tacv2",
      availability: "available",
      enabled: false,
    });
    await teams.service.replaceResources(teamsEndpoint.id, [
      { id: teamsResource!.id, enabled: true },
    ]);
    const teamsCallbacks = teams.runtime.configurations.get(
      teamsEndpoint.id,
    )?.callbacks;
    if (!teamsCallbacks) throw new Error("Expected Teams callbacks");
    const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
    const teamsConversationId = "19:conversation@thread.tacv2";
    const teamsChannelId = `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    const teamsThreadId = `teams:${Buffer.from(`${teamsConversationId};messageid=1729`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`;
    await deliverMessage({
      callbacks: teamsCallbacks,
      endpointId: teamsEndpoint.id,
      provider: "microsoft-teams",
      thread: makeThread({
        channelId: teamsChannelId,
        id: teamsThreadId,
        name: "Engineering",
      }).thread,
      message: makeMessage({
        id: "teams-root-1729",
        text: "@Maya investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, teamsEndpoint.id)),
    ).resolves.toHaveLength(1);
    await deliverTeamsLifecycle(teamsPayload("remove"));
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "19:conversation@thread.tacv2",
        label: "Engineering",
        availability: "removed",
      }),
    ]);

    const personalPayload = (action: "add" | "remove") => ({
      id: `teams-personal-${action}`,
      type: "installationUpdate",
      action,
      conversation: {
        id: "a:teams-personal-conversation",
        conversationType: "personal",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
    });
    await deliverTeamsLifecycle(personalPayload("add"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "available",
      }),
    ]);
    await deliverTeamsLifecycle(personalPayload("remove"));
    await expect(
      db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, teamsEndpoint.id),
            eq(
              chatEndpointResources.providerResourceId,
              "a:teams-personal-conversation",
            ),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "a:teams-personal-conversation",
        type: "direct_message",
        availability: "removed",
      }),
    ]);

    await deliverTeamsLifecycle({
      id: "teams-group-member-added",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "group",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersAdded: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "available",
        }),
      ]),
    );
    await deliverTeamsLifecycle({
      id: "teams-group-member-removed",
      type: "conversationUpdate",
      conversation: {
        id: "19:teams-group-conversation@unq.gbl.spaces",
        conversationType: "groupChat",
        tenantId: teamsTenantId,
      },
      channelData: { tenant: { id: teamsTenantId } },
      membersRemoved: [{ id: `28:${teamsClientId}` }],
    });
    await expect(
      teams.service.listResources(teamsEndpoint.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "19:teams-group-conversation@unq.gbl.spaces",
          type: "group_chat",
          availability: "unavailable",
        }),
      ]),
    );

    const telegram = createService(
      new FakeChatSdkRuntime(),
      fakeTelegramFetch(445566) as typeof globalThis.fetch,
    );
    const telegramEndpoint = await telegram.service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.replacementAgentId },
      "owner-user",
    );
    await telegram.service.configure(
      telegramEndpoint.id,
      {
        action: "configure",
        credentials: { botToken: "445566:telegram-lifecycle" },
      },
      "owner-user",
    );
    const telegramMembership = (updateId: number, status: string) =>
      telegram.service.handleWebhook(
        telegramEndpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: updateId,
            my_chat_member: {
              chat: { id: -100123, type: "supergroup", title: "Engineering" },
              new_chat_member: { status },
            },
          }),
        }),
      );
    await telegramMembership(1, "member");
    const [telegramResource] = await telegram.service.listResources(
      telegramEndpoint.id,
    );
    await telegram.service.replaceResources(telegramEndpoint.id, [
      { id: telegramResource!.id, enabled: true },
    ]);
    const telegramCallbacks = telegram.runtime.configurations.get(
      telegramEndpoint.id,
    )?.callbacks;
    if (!telegramCallbacks) throw new Error("Expected Telegram callbacks");
    await deliverMessage({
      callbacks: telegramCallbacks,
      endpointId: telegramEndpoint.id,
      provider: "telegram",
      thread: makeThread({
        channelId: "-100123",
        id: "telegram:-100123:77",
        name: "Engineering",
      }).thread,
      message: makeMessage({
        id: "telegram-root-77",
        text: "@paperclip investigate the alert",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(
      db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, telegramEndpoint.id)),
    ).resolves.toHaveLength(1);
    await telegramMembership(2, "left");
    await expect(
      telegram.service.listResources(telegramEndpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "-100123",
        label: "Engineering",
        availability: "unavailable",
      }),
    ]);
  });

  it("does not acknowledge lifecycle callbacks whose durable write fails", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected provider runtime");
    providerRuntime.handleWebhook = vi.fn(async () => {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      return new Response("accepted", { status: 202 });
    });
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: "Ev-must-persist",
            event: {
              type: "member_joined_channel",
              user: configuredEndpoint.botExternalId,
              channel: "C-MUST-PERSIST",
            },
          }),
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("retries a durable lifecycle row without treating it as a message delivery", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredSlackEndpoint(fixture);
    const configuredEndpoint = await service.get(endpoint.id);
    const transaction = vi.spyOn(db, "transaction");
    transaction.mockRejectedValueOnce(
      new Error("injected lifecycle persistence failure"),
    );
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "slack",
        new Request("https://paperclip.example/slack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: "Ev-lifecycle-retry",
            event: {
              type: "member_joined_channel",
              user: configuredEndpoint.botExternalId,
              channel: "C-RETRY-LIFECYCLE",
            },
          }),
        }),
      ),
    ).rejects.toThrow("injected lifecycle persistence failure");
    transaction.mockRestore();
    const [retry] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, "lifecycle:Ev-lifecycle-retry"),
        ),
      );
    expect(retry).toMatchObject({ state: "retry", attempts: 1 });

    await service.processPendingDeliveries(25, retry!.id);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, retry!.id)),
    ).resolves.toEqual([{ state: "processed" }]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "C-RETRY-LIFECYCLE",
        availability: "available",
      }),
    ]);
  });

  it("activates Slack only after provider verification and a real test message", async () => {
    const fixture = await seedCompany();
    const { runtime, service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    const configured = await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
        },
      },
      "owner-user",
    );
    expect(configured).toMatchObject({
      status: "verifying",
      setup: { step: "provider_setup" },
    });
    const [storedConfigured] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedConfigured.setup).toEqual({
      step: "provider_setup",
      testStartedAt: null,
      webhookVerifiedAt: null,
    });

    await expect(
      service.configure(endpoint.id, { action: "verify" }, "owner-user"),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_webhook_not_verified" },
    });
    await recordSlackUrlVerification(service, endpoint.publicId);

    const providerVerified = await service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    expect(providerVerified).toMatchObject({
      status: "verifying",
      setup: { step: "test" },
    });
    const [storedProviderVerified] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedProviderVerified.setup).toMatchObject({
      step: "test",
      testStartedAt: expect.any(String),
    });
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_message_missing" },
    });

    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive endpoint callbacks");
    const testThread = makeThread({
      channelId: "C-SETUP",
      id: "slack:C-SETUP:9000.1",
      name: "setup",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9000.1",
        text: "@maya verify this connection",
        mentioned: true,
      }),
      trigger: "mention",
    });

    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_test_follow_up_missing" },
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const activated = await service.test(endpoint.id);
    expect(activated).toMatchObject({
      status: "active",
      healthMessage: "Connected",
      activatedAt: expect.any(String),
      setup: { step: "complete" },
    });
    const [storedActivated] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedActivated.setup).toEqual({
      step: "complete",
      testStartedAt: null,
    });
  });

  it("accepts a published terminal failure for setup transport qualification", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const testThread = makeThread({
      channelId: "C-SETUP-FAILED",
      id: "slack:C-SETUP-FAILED:9001.1",
      name: "setup-failed",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9001.1",
        text: "@maya verify a failed setup turn",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: testThread.thread,
      message: makeMessage({
        id: "9001.2",
        text: "Setup follow-up",
      }),
      trigger: "subscribed_message",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    if (!conversation) throw new Error("Expected setup conversation");

    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `setup-transport:${progressState}:${endpoint.id}`,
        payload: {
          text: `Maya is ${progressState}.`,
          progressState,
        },
        state: "pending",
      });
      await service.processPendingPublications();
      await expect(service.test(endpoint.id)).rejects.toMatchObject({
        status: 409,
        details: { code: "chat_test_round_trip_incomplete" },
      });
    }

    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `setup-transport:failed:${endpoint.id}`,
      payload: {
        text: "Maya stopped before completing this turn.",
        progressState: "failed",
      },
      state: "pending",
    });
    await service.processPendingPublications();

    await expect(service.test(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
  });

  it("reorders rapid Slack callbacks by provider time before one conversation drain", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-async-ingress",
          signingSecret: "async-ingress-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId);
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected endpoint callbacks");
    const thread = makeThread({
      channelId: "C-ASYNC",
      id: "slack:C-ASYNC:9100.1",
      name: "async-ingress",
    });

    const laterReply = makeMessage({
      id: "9100.2",
      text: "and include the rollback status",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T17:50:03.517Z");
    // Slack Events API callbacks use independent HTTP requests. Reproduce the
    // live failure by receiving the later provider message first.
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });
    const earlierMention = makeMessage({
      id: "9100.1",
      text: "@maya acknowledge quickly",
      mentioned: true,
    });
    earlierMention.metadata.dateSent = new Date("2026-09-05T17:50:03.200Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: earlierMention,
      trigger: "mention",
    });
    for (let index = 3; index <= 8; index += 1) {
      const followUp = makeMessage({
        id: `9100.${index}`,
        text: `follow-up ${index}`,
      });
      followUp.metadata.dateSent = new Date(`2026-09-05T17:50:03.${index}00Z`);
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: followUp,
        trigger: "subscribed_message",
      });
    }

    const durable = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(durable).toHaveLength(8);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    // The first callback fixes one bounded batch deadline. Later arrivals do
    // not slide it forward and therefore cannot starve a busy conversation.
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: `${thread.thread.id}:9100.1`,
          state: "received",
          attempts: 0,
        }),
        expect.objectContaining({
          providerEventId: `${thread.thread.id}:9100.2`,
          state: "received",
          attempts: 0,
        }),
      ]),
    );
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).toHaveLength(0);
    expect(deferred).toHaveLength(1);

    const competingService = chatChannelService(db, {
      fetch: fakeSlackFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup },
      publicBaseUrl: "https://paperclip.example",
      runtime: new FakeChatSdkRuntime() as unknown as ChatSdkRuntime,
    });
    deferred.shift()?.();
    // Simulate another server process reconciling the same durable rows at
    // the same time as the webhook process's deferred drain.
    await competingService.processPendingDeliveries();
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));
      expect(rows).toHaveLength(1);
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    await vi.waitFor(async () => {
      const rows = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId));
      expect(rows).toHaveLength(8);
    });
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya acknowledge quickly",
      "follow-up 3",
      "follow-up 4",
      "follow-up 5",
      "and include the rollback status",
      "follow-up 6",
      "follow-up 7",
      "follow-up 8",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(8);
    expect(
      wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
    ).toEqual(comments.map((comment) => comment.id));
    expect(
      await db
        .select()
        .from(chatEndpointLeases)
        .where(eq(chatEndpointLeases.endpointId, endpoint.id)),
    ).toHaveLength(0);
    await competingService.shutdown();
    await service.shutdown();
  });

  it("reorders reverse-arrival Telegram webhooks by provider sequence before waking the agent", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeTelegramFetch() as typeof globalThis.fetch,
      heartbeat: { wakeup },
      publicBaseUrl: "https://paperclip.example",
      runtime: runtime as unknown as ChatSdkRuntime,
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-ordering-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram callbacks");
    const dm = makeThread({
      channelId: "77117711",
      id: "telegram:77117711",
      isDM: true,
      name: "Telegram ordered delivery",
    });
    const providerSecond = new Date("2026-09-05T19:15:20.000Z");
    const later = makeMessage({
      id: "telegram:77117711:102",
      raw: { message_id: 102 },
      text: "second Telegram turn",
      userId: "77117711",
    });
    later.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7002,
      thread: dm.thread,
      message: later,
      trigger: "direct_message",
    });
    const earlier = makeMessage({
      id: "telegram:77117711:101",
      raw: { message_id: 101 },
      text: "first Telegram turn",
      userId: "77117711",
    });
    earlier.metadata.dateSent = providerSecond;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      providerUpdateId: 7001,
      thread: dm.thread,
      message: earlier,
      trigger: "direct_message",
    });

    const durable = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(durable).toHaveLength(2);
    expect(durable.every((delivery) => delivery.nextAttemptAt !== null)).toBe(
      true,
    );
    expect(
      new Set(
        durable.map((delivery) => delivery.nextAttemptAt?.getTime() ?? null),
      ).size,
    ).toBe(1);
    expect(durable.map((delivery) => delivery.normalizedEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 101,
            providerUpdateId: 7001,
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            providerMessageSequence: 102,
            providerUpdateId: 7002,
          }),
        }),
      ]),
    );
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    if (!conversation) throw new Error("Expected Telegram conversation");
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map((comment) => comment.body)).toEqual([
      "first Telegram turn",
      "second Telegram turn",
    ]);
    expect(
      wakeup.mock.calls.map((call) => call[1]?.payload?.wakeCommentId),
    ).toEqual(comments.map((comment) => comment.id));
    await service.shutdown();
  });

  it("holds a delayed Slack thread reply until its older root mention arrives", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-DELAYED-ROOT",
      label: "delayed-root",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: "C-DELAYED-ROOT",
      id: "slack:C-DELAYED-ROOT:9110.1",
      name: "delayed-root",
    });
    const laterReply = makeMessage({
      id: "9110.2",
      text: "follow-up whose callback arrived first",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:20:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });

    const [deferredReply] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(deferredReply).toMatchObject({
      state: "retry",
      attempts: 1,
      redactedError: "Waiting briefly for an earlier root mention",
    });
    expect(deferredReply.nextAttemptAt).not.toBeNull();
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);

    const earlierRoot = makeMessage({
      id: "9110.1",
      text: "@maya keep both messages",
      mentioned: true,
    });
    earlierRoot.metadata.dateSent = new Date("2026-09-05T18:20:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: earlierRoot,
      trigger: "mention",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, deferredReply.id));
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({ externalThreadId: thread.thread.id });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya keep both messages" },
      { body: "follow-up whose callback arrived first" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("filters a standalone unaddressed Slack thread reply after one grace attempt", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-ORPHAN-ONLY",
      label: "orphan-only",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: "C-ORPHAN-ONLY",
      id: "slack:C-ORPHAN-ONLY:9120.1",
      name: "orphan-only",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({ id: "9120.2", text: "not for the bot" }),
      trigger: "subscribed_message",
    });
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(delivery).toMatchObject({ state: "retry", attempts: 1 });

    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));
    await service.processPendingDeliveries();

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          attempts: chatDeliveries.attempts,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([{ state: "filtered", attempts: 2 }]);
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("uses the Teams group-chat toggle without weakening channel resource gates", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTeamsEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.update(endpoint.id, { allowGroupChats: false }, "owner-user");

    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const groupConversationId = "19:teams-group-reach@unq.gbl.spaces";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "group_chat",
      providerResourceId: groupConversationId,
      label: "Launch group",
      availability: "available",
      enabled: false,
    });
    const groupThread = makeThread({
      channelId: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Launch group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-group-disabled",
        text: "@maya do not start yet",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      0,
    );

    await service.update(endpoint.id, { allowGroupChats: true }, "owner-user");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-group-enabled",
        text: "@maya start the group task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalConversationId: groupThread.thread.channelId,
        isDirectMessage: false,
      }),
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: groupConversationId,
          type: "group_chat",
          enabled: false,
          availability: "available",
        }),
      ]),
    );

    const channelConversationId = "19:teams-channel-reach@thread.tacv2";
    const channelRootId = "1740000000101";
    const [channelResource] = await db
      .insert(chatEndpointResources)
      .values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        type: "channel",
        providerResourceId: channelConversationId,
        label: "Engineering",
        availability: "available",
        enabled: false,
      })
      .returning();
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Engineering",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: channelRootId,
        text: "@maya channel still requires enablement",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );

    await service.replaceResources(endpoint.id, [
      { id: channelResource!.id, enabled: true },
    ]);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: `${channelRootId}-enabled`,
        text: "@maya channel is enabled now",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      2,
    );
  });

  it("holds a delayed Teams channel reply until its older root mention arrives", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-delayed-root@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const rootMessageId = "1740000000001";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: conversationId,
      label: "delayed-root",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "delayed-root",
    });
    const laterReply = makeMessage({
      id: "1740000000002",
      text: "Teams follow-up whose callback arrived first",
    });
    laterReply.metadata.dateSent = new Date("2026-09-05T18:20:02.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: laterReply,
      trigger: "subscribed_message",
    });
    await service.processPendingDeliveries();

    const [deferredReply] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(deferredReply).toMatchObject({
      state: "retry",
      attempts: 1,
      redactedError: "Waiting briefly for an earlier root mention",
    });
    expect(deferredReply.nextAttemptAt).not.toBeNull();
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);

    const earlierRoot = makeMessage({
      id: rootMessageId,
      text: "@maya keep both Teams messages",
      mentioned: true,
    });
    earlierRoot.metadata.dateSent = new Date("2026-09-05T18:20:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: earlierRoot,
      trigger: "mention",
    });
    await service.processPendingDeliveries();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, deferredReply.id));
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({ externalThreadId: thread.thread.id });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya keep both Teams messages" },
      { body: "Teams follow-up whose callback arrived first" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("filters a standalone unaddressed Teams channel reply after one grace attempt", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-orphan-only@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: conversationId,
      label: "orphan-only",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=1740000000011`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "orphan-only",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "1740000000012",
        text: "not for the Teams bot",
      }),
      trigger: "subscribed_message",
    });
    await service.processPendingDeliveries();
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(delivery).toMatchObject({ state: "retry", attempts: 1 });

    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));
    await service.processPendingDeliveries();

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          attempts: chatDeliveries.attempts,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([{ state: "filtered", attempts: 2 }]);
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("rehydrates a durable attachment descriptor after restart and stores the file on the issue", async () => {
    const fixture = await seedCompany();
    const recoveryKey = `restart-attachment-${randomUUID()}`;
    const attachmentBody = Buffer.from("restart-safe attachment body", "utf8");
    const attachmentBodies = new Map([[recoveryKey, attachmentBody]]);
    const firstRuntime = new FakeChatSdkRuntime(attachmentBodies);
    const deferred: Array<() => void> = [];
    const storage = createStorageService();
    const first = createService(
      firstRuntime,
      fakeSlackFetch() as typeof globalThis.fetch,
      {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
        storage: storage.storage,
      },
    );
    const endpoint = await first.service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await first.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-restart-attachment",
          signingSecret: "restart-attachment-signing-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(first.service, endpoint.publicId);
    await first.service.configure(
      endpoint.id,
      { action: "verify" },
      "owner-user",
    );
    const callbacks = firstRuntime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected first-process callbacks");
    const thread = makeThread({
      channelId: "C-RESTART-FILE",
      id: "slack:C-RESTART-FILE:9150.1",
      name: "restart-files",
    });
    const liveFetch = vi.fn(async () => {
      throw new Error("the original attachment closure must not survive");
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "restart-note.txt",
            mimeType: "text/plain",
            size: attachmentBody.length,
            fetchData: liveFetch,
            fetchMetadata: { testRecoveryKey: recoveryKey },
          } as Attachment,
        ],
        id: "9150.1",
        text: "@maya preserve this attachment",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [durableDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(durableDelivery).toMatchObject({ state: "received", attempts: 0 });
    expect(JSON.stringify(durableDelivery.normalizedEvent)).not.toContain(
      "xoxb-restart-attachment",
    );
    expect(deferred).toHaveLength(1);
    expect(liveFetch).not.toHaveBeenCalled();
    await first.service.shutdown();
    // Restart after the bounded Slack reorder window has elapsed.
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, durableDelivery.id));

    const restartedRuntime = new FakeChatSdkRuntime(attachmentBodies);
    const restarted = createService(
      restartedRuntime,
      fakeSlackFetch() as typeof globalThis.fetch,
      { storage: storage.storage },
    );
    await restarted.service.processPendingDeliveries();

    const restartedEndpointRuntime = restartedRuntime.endpoints.get(
      endpoint.id,
    );
    expect(
      restartedEndpointRuntime?.rehydratedAttachmentDescriptors,
    ).toHaveLength(1);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: fixture.companyId,
        originalFilename: "restart-note.txt",
        contentType: "text/plain",
        body: attachmentBody,
      }),
    );
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const storedAttachments = await db
      .select({
        attachmentId: issueAttachments.id,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(eq(issueAttachments.issueId, conversation.issueId));
    expect(storedAttachments).toEqual([
      expect.objectContaining({
        issueId: conversation.issueId,
        issueCommentId: expect.any(String),
        contentType: "text/plain",
        byteSize: attachmentBody.length,
        originalFilename: "restart-note.txt",
      }),
    ]);
    await restarted.service.shutdown();
  });

  it("ignores signed Slack callbacks from a different workspace before SDK dispatch", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      fakeSlackFetch("U-BOT-WORKSPACE-SCOPE") as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const signingSecret = "workspace-scope-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-workspace-scope",
          signingSecret,
        },
      },
      "owner-user",
    );
    const endpointRuntime = runtime.endpoints.get(endpoint.id)!;
    expect(endpointRuntime).toBeDefined();

    const signedRequest = (body: string, contentType: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      return new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": contentType,
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
          },
          body,
        },
      );
    };
    const formBody = (values: Record<string, string>) =>
      new URLSearchParams(values).toString();
    const cases = [
      {
        name: "Events API JSON",
        contentType: "application/json",
        foreignBody: JSON.stringify({
          type: "event_callback",
          team_id: "T-FOREIGN",
          event: { type: "app_mention" },
        }),
        localBody: JSON.stringify({
          type: "event_callback",
          team_id: "T-PAPERCLIP",
          enterprise_id: "E-PAPERCLIP",
          event: { type: "app_mention" },
        }),
      },
      {
        name: "interactive form payload",
        contentType: "application/x-www-form-urlencoded",
        foreignBody: formBody({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T-FOREIGN" },
          }),
        }),
        localBody: formBody({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T-PAPERCLIP" },
          }),
        }),
      },
      {
        name: "slash command",
        contentType: "application/x-www-form-urlencoded",
        foreignBody: formBody({
          team_id: "T-FOREIGN",
          command: "/maya",
          text: "status",
        }),
        localBody: formBody({
          team_id: "T-PAPERCLIP",
          command: "/maya",
          text: "status",
        }),
      },
      {
        name: "enterprise-scoped callback",
        contentType: "application/json",
        foreignBody: JSON.stringify({
          type: "event_callback",
          enterprise_id: "E-FOREIGN",
          event: { type: "app_mention" },
        }),
        localBody: JSON.stringify({
          type: "event_callback",
          enterprise_id: "T-PAPERCLIP",
          event: { type: "app_mention" },
        }),
      },
    ];

    for (const testCase of cases) {
      endpointRuntime.webhookRequest = null;
      const ignored = await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedRequest(testCase.foreignBody, testCase.contentType),
      );
      expect(ignored.status, testCase.name).toBe(200);
      await expect(ignored.text()).resolves.toBe("ignored");
      expect(endpointRuntime.webhookRequest, testCase.name).toBeNull();

      const accepted = await service.handleWebhook(
        endpoint.publicId,
        "slack",
        signedRequest(testCase.localBody, testCase.contentType),
      );
      expect(accepted.status, testCase.name).toBe(202);
      expect(endpointRuntime.webhookRequest, testCase.name).not.toBeNull();
    }

    // Scope inspection is not a substitute for the adapter's signature gate.
    // An invalid request must continue to the SDK so it receives the normal
    // authentication failure instead of Paperclip acknowledging it as foreign.
    endpointRuntime.webhookRequest = null;
    const forgedForeign = signedRequest(
      cases[0]!.foreignBody,
      cases[0]!.contentType,
    );
    forgedForeign.headers.set("x-slack-signature", "v0=forged");
    const forgedResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      forgedForeign,
    );
    expect(forgedResponse.status).toBe(202);
    expect(endpointRuntime.webhookRequest).not.toBeNull();

    await service.shutdown();
  });

  it("returns a retryable webhook failure when the delivery insert fails before durable receipt", async () => {
    const fixture = await seedCompany();
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch("U-BOT-DURABILITY") as typeof globalThis.fetch,
      heartbeat: { wakeup: vi.fn(async () => ({ accepted: true })) },
      publicBaseUrl: "https://paperclip.example",
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const signingSecret = "durable-ingress-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-durable-ingress",
          signingSecret,
        },
      },
      "owner-user",
    );

    const body = JSON.stringify({
      type: "event_callback",
      event_id: `Ev-${randomUUID()}`,
      event_time: Math.floor(Date.now() / 1000),
      team_id: "T-PAPERCLIP",
      event: {
        type: "app_mention",
        user: "U-EXTERNAL",
        username: "alex",
        text: "@maya prove durable receipt",
        ts: "9200.1",
        channel: "C-DURABILITY",
        channel_type: "channel",
        team: "T-PAPERCLIP",
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const providerRequest = (retry = false) =>
      new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
            ...(retry ? { "x-slack-retry-num": "1" } : {}),
          },
          body,
        },
      );

    const forged = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": "v0=forged",
          },
          body,
        },
      ),
    );
    expect(forged.status).toBe(401);
    expect(
      await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).toHaveLength(0);

    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("injected durable admission failure"));

    const rejected = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      providerRequest(),
    );
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(
      await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).toHaveLength(0);

    transactionSpy.mockRestore();
    const acceptedRetry = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      providerRequest(true),
    );
    expect(acceptedRetry.status).toBe(200);
    await vi.waitFor(async () => {
      const deliveries = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].state).toBe("processed");
    });
    const [initialDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    const initialDuplicateCount = Number(
      initialDelivery.normalizedEvent.deduplication?.duplicateCount ?? 0,
    );
    const acceptedRedelivery = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      providerRequest(true),
    );
    expect(acceptedRedelivery.status).toBe(200);
    await vi.waitFor(async () => {
      const [delivery] = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(
        Number(delivery.normalizedEvent.deduplication?.duplicateCount ?? 0),
      ).toBeGreaterThan(initialDuplicateCount);
      expect(
        await db
          .select()
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).toHaveLength(1);
    });
    await service.shutdown();
  });

  it("acknowledges durable Slack ingress promptly and never replays paused traffic on resume", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const wakeup = vi.fn(async () => ({ accepted: true }));
    const service = chatChannelService(db, {
      deferWebhookProcessing: true,
      fetch: fakeSlackFetch("U-BOT-PAUSE") as typeof globalThis.fetch,
      heartbeat: { wakeup },
      publicBaseUrl: "https://paperclip.example",
      scheduleDeferredWork: (task) => deferred.push(task),
    });
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const signingSecret = "pause-ingress-signing-secret";
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-pause-ingress",
          signingSecret,
        },
      },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));

    const signedRequest = (input: {
      eventId: string;
      messageId: string;
      text: string;
    }) => {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: input.eventId,
        event_time: Math.floor(Date.now() / 1000),
        team_id: "T-PAPERCLIP",
        event: {
          type: "app_mention",
          user: "U-PAUSED-SENDER",
          username: "alex",
          text: input.text,
          ts: input.messageId,
          channel: "C-PAUSED-INGRESS",
          channel_type: "channel",
          team: "T-PAPERCLIP",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      return new Request(
        `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/slack`,
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
    };

    const activeResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedRequest({
        eventId: "Ev-before-pause",
        messageId: "9300.1",
        text: "@maya queued just before pause",
      }),
    );
    expect(activeResponse.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(wakeup).not.toHaveBeenCalled();

    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    const pausedResponse = await service.handleWebhook(
      endpoint.publicId,
      "slack",
      signedRequest({
        eventId: "Ev-during-pause",
        messageId: "9300.2",
        text: "@maya this must stay ignored after resume",
      }),
    );
    expect(pausedResponse.status).toBe(200);
    expect(deferred).toHaveLength(1);

    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    deferred.shift()?.();
    await service.shutdown();

    const deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .orderBy(asc(chatDeliveries.receivedAt));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.state)).toEqual([
      "filtered",
      "filtered",
    ]);
    expect(deliveries.map((delivery) => delivery.redactedError)).toEqual([
      "Connection was paused before processing",
      "Connection is not active",
    ]);
    expect(deliveries.every((delivery) => delivery.processedAt)).toBe(true);
    expect(await service.get(endpoint.id)).toMatchObject({
      status: "active",
      lastActivityAt: expect.any(String),
    });
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.companyId, fixture.companyId)),
    ).toHaveLength(0);
  });

  it("keeps processing audit truth and rejects stale Slack runtime callbacks across resume", async () => {
    const fixture = await seedCompany();
    const { runtime, service, wakeup } = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch() as typeof globalThis.fetch,
      { deferWebhookProcessing: true },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-generation-boundary",
          signingSecret: "generation-boundary-secret",
        },
      },
      "owner-user",
    );
    await recordSlackUrlVerification(service, endpoint.publicId);
    await service.configure(endpoint.id, { action: "verify" }, "owner-user");
    const staleCallbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!staleCallbacks) throw new Error("Expected endpoint callbacks");
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        setup: { step: "complete" },
        activatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    const thread = makeThread({
      channelId: "C-PAUSE-RACE",
      id: "slack:C-PAUSE-RACE:9400.1",
      name: "pause-race",
    });
    const processingMessage = makeMessage({
      id: "9400.1",
      text: "@maya processing before pause",
      mentioned: true,
    });
    const providerEventId = `${thread.thread.id}:${processingMessage.id}`;
    await db.insert(chatDeliveries).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      providerEventId,
      deduplicationKey: createHash("sha256")
        .update(providerEventId)
        .digest("hex"),
      eventKind: "mention",
      normalizedEvent: {},
      state: "processing",
      attempts: 1,
    });

    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: processingMessage,
      trigger: "mention",
    });
    const [processingDuplicate] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.providerEventId, providerEventId));
    expect(processingDuplicate.state).toBe("processing");
    expect(processingDuplicate.processedAt).toBeNull();
    expect(
      Number(
        processingDuplicate.normalizedEvent.deduplication?.duplicateCount ?? 0,
      ),
    ).toBe(1);

    await service.configure(endpoint.id, { action: "resume" }, "owner-user");
    const staleMessage = makeMessage({
      id: "9400.2",
      text: "@maya parsed before the pause",
      mentioned: true,
    });
    await deliverMessage({
      callbacks: staleCallbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: staleMessage,
      trigger: "mention",
    });

    const deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .orderBy(asc(chatDeliveries.receivedAt));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      state: "processing",
      processedAt: null,
    });
    expect(deliveries[1]).toMatchObject({
      state: "filtered",
      redactedError: "Connection activation changed before admission",
      processedAt: expect.any(Date),
    });
    expect(JSON.stringify(await service.get(endpoint.id))).not.toContain(
      "runtimeGeneration",
    );
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(0);
    await service.shutdown();
  });

  it("deduplicates inbound events, keeps one task per thread, and requires enablement for newly discovered channels", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const serializedEndpointResponses = JSON.stringify({
      detail: await service.get(endpoint.id),
      list: await service.list(fixture.companyId),
    });
    expect(serializedEndpointResponses).not.toContain("xoxb-test-token");
    expect(serializedEndpointResponses).not.toContain("test-signing-secret");
    const first = makeThread({
      channelId: "C-ENGINEERING",
      id: "slack:C-ENGINEERING:1000.1",
      name: "engineering",
    });
    const firstMessage = makeMessage({
      id: "1000.1",
      text: "@maya investigate the deploy",
      mentioned: true,
    });

    await Promise.all(
      Array.from({ length: 12 }, () =>
        deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          thread: first.thread,
          message: firstMessage,
          trigger: "mention",
        }),
      ),
    );
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: first.thread,
      message: firstMessage,
      trigger: "mention",
    });

    let conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    let endpointIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    let deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    let comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversations[0].issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(conversations).toHaveLength(1);
    expect(endpointIssues).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].normalizedEvent).toMatchObject({
      deduplication: {
        duplicateCount: 12,
        lastDuplicateAt: expect.any(String),
      },
    });
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya investigate the deploy",
    ]);
    expect(first.addReaction).toHaveBeenCalledWith(
      first.thread.id,
      firstMessage.id,
      "eyes",
    );
    expect(first.startTyping).not.toHaveBeenCalled();
    expect(first.subscribe).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: first.thread,
      message: makeMessage({ id: "1000.2", text: "Here is another detail" }),
      trigger: "subscribed_message",
    });
    conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    endpointIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversations[0].issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(conversations).toHaveLength(1);
    expect(endpointIssues).toHaveLength(1);
    expect(comments.map((comment) => comment.body)).toEqual([
      "@maya investigate the deploy",
      "Here is another detail",
    ]);

    const second = makeThread({
      channelId: "C-FINANCE",
      id: "slack:C-FINANCE:2000.1",
      name: "finance",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: second.thread,
      message: makeMessage({
        id: "2000.1",
        text: "@maya summarize spend",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const resources = await service.listResources(endpoint.id);
    expect(
      resources.map((resource) => ({
        label: resource.label,
        enabled: resource.enabled,
      })),
    ).toEqual([
      { label: "engineering", enabled: true },
      { label: "finance", enabled: false },
    ]);
    deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(
      deliveries.find((delivery) => delivery.providerEventId.includes("2000.1"))
        ?.state,
    ).toBe("filtered");
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(1);

    const finance = resources.find((resource) => resource.label === "finance");
    if (!finance) throw new Error("Expected discovered finance resource");
    await service.replaceResources(endpoint.id, [
      { id: finance.id, enabled: true },
    ]);
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: second.thread,
      message: makeMessage({
        id: "2000.2",
        text: "@maya summarize spend",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "records a successful GitHub receipt reaction once",
      failures: [] as Error[],
      terminalFailure: null as Error | null,
      expectedAttempts: 1,
      expectedDiagnostic: null as RegExp | null,
    },
    {
      label: "keeps an accepted task authoritative after a GitHub 403",
      failures: [] as Error[],
      terminalFailure: Object.assign(new Error("GitHub reaction forbidden"), {
        status: 403,
      }),
      expectedAttempts: 1,
      expectedDiagnostic:
        /Receipt reaction failed after 1 attempt \(endpoint_attention\): GitHub reaction forbidden/,
    },
    {
      label: "retries a GitHub 429 receipt reaction with bounded backoff",
      failures: [
        Object.assign(new Error("GitHub reaction rate limited"), {
          status: 429,
          retryAfterMs: 1,
        }),
      ],
      terminalFailure: null as Error | null,
      expectedAttempts: 2,
      expectedDiagnostic: null as RegExp | null,
    },
    {
      label: "retries idempotent GitHub receipt reactions after network errors",
      failures: [
        Object.assign(new Error("connection reset before response"), {
          code: "ECONNRESET",
          name: "NetworkError",
        }),
        Object.assign(new Error("temporary network timeout"), {
          code: "ETIMEDOUT",
          name: "NetworkError",
        }),
      ],
      terminalFailure: null as Error | null,
      expectedAttempts: 3,
      expectedDiagnostic: null as RegExp | null,
    },
  ])(
    "$label",
    async ({
      expectedAttempts,
      expectedDiagnostic,
      failures,
      terminalFailure,
    }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, service, wakeup } =
        await configuredGitHubEndpoint(fixture);
      const github = makeThread({
        channelId: "github:paperclipai/paperclip",
        id: "github:paperclipai/paperclip:issue:receipt-reaction",
        name: "paperclipai/paperclip",
      });
      github.addReaction.mockReset();
      for (const failure of failures) {
        github.addReaction.mockRejectedValueOnce(failure);
      }
      if (terminalFailure) {
        github.addReaction.mockRejectedValue(terminalFailure);
      } else {
        github.addReaction.mockResolvedValue(undefined);
      }

      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: github.thread,
        message: makeMessage({
          id: "880011",
          text: "@maya verify receipt reaction reliability",
          mentioned: true,
        }),
        trigger: "mention",
      });

      expect(github.addReaction).toHaveBeenCalledTimes(expectedAttempts);
      expect(github.addReaction).toHaveBeenCalledWith(
        github.thread.id,
        "880011",
        "eyes",
      );
      const [delivery] = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(delivery).toMatchObject({ state: "processed", attempts: 1 });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(
        await db
          .select()
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).toHaveLength(1);
      const activity = (await service.listActivity(endpoint.id)).find(
        (item) => item.id === delivery.id,
      );
      if (expectedDiagnostic) {
        expect(delivery.redactedError).toMatch(expectedDiagnostic);
        expect(activity?.detail).toMatch(expectedDiagnostic);
        await expect(service.get(endpoint.id)).resolves.toMatchObject({
          status: "verifying",
        });
      } else {
        expect(delivery.redactedError).toBeNull();
        expect(activity?.detail).toBeNull();
      }
    },
  );

  it("canonicalizes prefixed Chat SDK channel ids onto provider inventory resources", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://slack.com/api/auth.test") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T-PREFIXED",
            team: "Prefixed Workspace",
            user_id: "U-PREFIXED-BOT",
            user: "maya-prefixed",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-oauth-scopes": TEST_SLACK_BOT_SCOPES,
            },
          },
        );
      }
      if (url.startsWith("https://slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [
              {
                id: "C-PREFIXED",
                name: "prefixed-channel",
                is_member: true,
                is_archived: false,
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(runtime, providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "slack", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          botToken: "xoxb-prefixed-channel",
          signingSecret: "prefixed-channel-secret",
        },
      },
      "owner-user",
    );
    const [inventoryResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: inventoryResource!.id, enabled: true },
    ]);
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Slack callbacks");
    const thread = makeThread({
      channelId: "slack:C-PREFIXED",
      id: "slack:C-PREFIXED:2200.1",
      name: "prefixed-channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "2200.1",
        text: "@maya use the inventoried destination",
        mentioned: true,
      }),
      trigger: "mention",
    });

    const resources = await service.listResources(endpoint.id);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      id: inventoryResource!.id,
      providerResourceId: "C-PREFIXED",
      availability: "available",
      enabled: true,
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ externalThreadId: thread.thread.id }),
    ]);
  });

  it("refuses to enable a destination the provider no longer exposes", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REMOVED",
      id: "slack:C-REMOVED:2100.1",
      name: "removed-channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "2100.1",
        text: "This unaddressed event only discovers the channel",
      }),
      trigger: "unaddressed_message",
    });
    const [resource] = await db
      .select()
      .from(chatEndpointResources)
      .where(eq(chatEndpointResources.endpointId, endpoint.id));
    await db
      .update(chatEndpointResources)
      .set({ availability: "removed", updatedAt: new Date() })
      .where(eq(chatEndpointResources.id, resource.id));

    await expect(
      service.replaceResources(endpoint.id, [
        { id: resource.id, enabled: true },
      ]),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_resource_unavailable",
        resourceId: resource.id,
      },
    });
  });

  it("filters unlinked people when configured, then honors a confirmed active-member identity link", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } = await configuredSlackEndpoint(
      fixture,
      { allowUnlinkedPeople: false },
    );
    const channel = makeThread({
      channelId: "C-PRIVATE",
      id: "slack:C-PRIVATE:3000.1",
      name: "private",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.1",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).toHaveLength(0);
    const [filtered] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(filtered.state).toBe("filtered");

    const now = new Date();
    await db.insert(authUsers).values({
      id: "linked-paperclip-user",
      name: "Linked User",
      email: `linked-${fixture.companyId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: "linked-paperclip-user",
      status: "active",
      membershipRole: "viewer",
    });
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, "U-LINK-ME"));
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Identity-link confirmation token was absent");
    await expect(service.previewIdentityLink(token)).resolves.toMatchObject({
      endpointId: endpoint.id,
      companyId: fixture.companyId,
      provider: "slack",
      externalLabel: "Alex External",
    });
    await expect(
      service.confirmIdentityLink(token, "linked-paperclip-user"),
    ).resolves.toEqual({
      ok: true,
      endpointId: endpoint.id,
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.2",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id)),
    ).toHaveLength(0);
    const viewerDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .then((rows) =>
        rows.find((delivery) => delivery.providerEventId.includes("3000.2")),
      );
    expect(viewerDelivery?.state).toBe("filtered");

    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(eq(companyMemberships.principalId, "linked-paperclip-user"));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.3",
        text: "@maya private task",
        mentioned: true,
        userId: "U-LINK-ME",
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-LINK-ME");
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversation).toBeDefined();
    const [comment] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.authorType, "user"),
        ),
      );
    expect(comment.authorType).toBe("user");
    expect(comment.authorUserId).toBe("linked-paperclip-user");
    const userCommentCountBeforeSuspend = (
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
    ).filter((candidate) => candidate.authorType === "user").length;

    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, "linked-paperclip-user"));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "3000.4",
        text: "This must no longer pass",
        userId: "U-LINK-ME",
      }),
      trigger: "subscribed_message",
    });
    const allComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId));
    expect(
      allComments.filter((candidate) => candidate.authorType === "user"),
    ).toHaveLength(userCommentCountBeforeSuspend);
    const allDeliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(
      allDeliveries.find((delivery) =>
        delivery.providerEventId.includes("3000.4"),
      )?.state,
    ).toBe("filtered");
  });

  it("filters an unlinked guest when the endpoint sponsor is suspended and exposes the reason and duplicate count", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, "owner-user"),
        ),
      );
    const channel = makeThread({
      channelId: "C-SPONSOR-SUSPENDED",
      id: "slack:C-SPONSOR-SUSPENDED:3100.1",
      name: "sponsor-suspended",
    });
    const message = makeMessage({
      id: "3100.1",
      text: "@maya this guest no longer has a sponsor",
      mentioned: true,
      userId: `U-UNLINKED-${randomUUID()}`,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message,
        trigger: "mention",
      });
    }

    expect(await service.listConversations(endpoint.id)).toEqual([]);
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(delivery).toMatchObject({
      state: "filtered",
      redactedError: "Endpoint sponsor can no longer authorize external guests",
      normalizedEvent: {
        deduplication: { duplicateCount: 2 },
      },
    });
    await expect(service.listActivity(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: delivery.id,
        kind: "delivery",
        status: "filtered",
        summary: "mention ignored · 2 duplicates ignored",
        detail: "Endpoint sponsor can no longer authorize external guests",
        replayable: false,
      }),
    ]);
  });

  it("guides empty Slack mentions once without creating a task or run", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const configured = await service.get(endpoint.id);
    const variants = [
      "",
      "   \t\n",
      `<@${configured.botExternalId}>`,
      ` \u200b <@${configured.botExternalId}>  @maya !!! `,
    ];

    for (const [index, text] of variants.entries()) {
      const root = makeThread({
        channelId: "C-EMPTY-MENTION",
        id: `slack:C-EMPTY-MENTION:3200.${index}`,
        name: "empty-mention",
      });
      const message = makeMessage({
        id: `3200.${index}`,
        text,
        mentioned: true,
        userId: "U-EMPTY-MENTION",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: root.thread,
        message,
        trigger: "mention",
      });

      expect(root.post).toHaveBeenCalledTimes(1);
      expect(root.post).toHaveBeenCalledWith(
        "Please include a request after mentioning me.",
      );
      expect(root.addReaction).toHaveBeenCalledTimes(1);
    }

    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.companyId, fixture.companyId)),
    ).toHaveLength(0);
    const deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(deliveries).toHaveLength(variants.length);
    expect(
      deliveries.every(
        (delivery) =>
          delivery.state === "processed" &&
          delivery.normalizedEvent.deduplication?.duplicateCount === 1,
      ),
    ).toBe(true);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps one Paperclip account mapping for the same provider principal across endpoints", async () => {
    const fixture = await seedCompany();
    const firstContext = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-BOT-IDENTITY-A") as typeof globalThis.fetch,
    );
    const secondContext = createService(
      new FakeChatSdkRuntime(),
      fakeSlackFetch("U-BOT-IDENTITY-B") as typeof globalThis.fetch,
    );
    const first = await firstContext.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );
    const second = await secondContext.service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.replacementAgentId,
      },
      "owner-user",
    );
    for (const [context, endpoint, suffix] of [
      [firstContext, first, "a"],
      [secondContext, second, "b"],
    ] as const) {
      await context.service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: {
            botToken: `xoxb-identity-${suffix}`,
            signingSecret: `identity-secret-${suffix}`,
          },
        },
        "owner-user",
      );
      await recordSlackUrlVerification(context.service, endpoint.publicId);
      await context.service.configure(
        endpoint.id,
        { action: "verify" },
        "owner-user",
      );
      const callbacks = context.runtime.configurations.get(
        endpoint.id,
      )?.callbacks;
      if (!callbacks) throw new Error("Expected endpoint callbacks");
      const thread = makeThread({
        channelId: `C-IDENTITY-${suffix.toUpperCase()}`,
        id: `slack:C-IDENTITY-${suffix.toUpperCase()}:1`,
        name: `identity-${suffix}`,
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({
          id: `identity-${suffix}`,
          text: `@bot identify ${suffix}`,
          mentioned: true,
          userId: "U-SHARED-HUMAN",
        }),
        trigger: "mention",
      });
    }

    const now = new Date();
    await db.insert(authUsers).values([
      {
        id: "paperclip-user-a",
        name: "Paperclip User A",
        email: `identity-a-${fixture.companyId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "paperclip-user-b",
        name: "Paperclip User B",
        email: `identity-b-${fixture.companyId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId: fixture.companyId,
        principalType: "user",
        principalId: "paperclip-user-a",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: fixture.companyId,
        principalType: "user",
        principalId: "paperclip-user-b",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, "U-SHARED-HUMAN"))
      .then((rows) => rows[0]);
    const firstIntent = await firstContext.service.createLinkIntent(
      first.id,
      principal.id,
      1_800,
    );
    const firstToken = new URL(firstIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!firstToken) throw new Error("First identity token was absent");
    await firstContext.service.confirmIdentityLink(
      firstToken,
      "paperclip-user-a",
    );

    const secondIntent = await secondContext.service.createLinkIntent(
      second.id,
      principal.id,
      1_800,
    );
    const secondToken = new URL(secondIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!secondToken) throw new Error("Second identity token was absent");
    await expect(
      secondContext.service.confirmIdentityLink(
        secondToken,
        "paperclip-user-b",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_identity_link_conflict" },
    });
  });

  it("publishes only the safe projection once and locks reassignment of a bound task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-SAFE",
      id: "slack:C-SAFE:4000.1",
      name: "safe-output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4000.1",
        text: "@maya give me the public result",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Visible answer. <analysis>never expose this reasoning</analysis>",
      { userId: "owner-user" },
      { authorType: "user" },
    );

    const first = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    const second = await service.publishComment(
      endpoint.id,
      conversation.id,
      comment.id,
    );
    expect(first.id).toBe(second.id);
    // The first call returns the newly inserted outbox row, while the second
    // observes that same durable row after the synchronous delivery attempt.
    expect(first.state).toBe("pending");
    expect(second.state).toBe("published");
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: channel.thread.id, text: "Visible answer." },
    ]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.endpointId, endpoint.id));
    const links = await db
      .select()
      .from(chatMessageLinks)
      .where(eq(chatMessageLinks.endpointId, endpoint.id));
    const explicitPublications = publications.filter(
      (publication) => publication.commentId === comment.id,
    );
    expect(explicitPublications).toHaveLength(1);
    expect(explicitPublications[0]).toMatchObject({
      state: "published",
      providerMessageId: expect.stringMatching(/^outbound-\d+$/),
    });
    expect(
      links.filter(
        (link) => link.direction === "inbound" || link.commentId === comment.id,
      ),
    ).toHaveLength(3);
    expect(
      links.find(
        (link) =>
          link.direction === "outbound" && link.commentId === comment.id,
      )?.providerMessageId,
    ).toBe(explicitPublications[0]?.providerMessageId);

    await expect(
      issueService(db).update(conversation.issueId, {
        assigneeAgentId: fixture.replacementAgentId,
        actorUserId: "owner-user",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_binding_agent_locked",
        conversationId: conversation.id,
      },
    });
    const [boundIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, conversation.issueId));
    expect(boundIssue.assigneeAgentId).toBe(fixture.assignedAgentId);

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    await expect(
      issueService(db).update(conversation.issueId, {
        assigneeAgentId: fixture.replacementAgentId,
        actorUserId: "owner-user",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "chat_binding_agent_locked",
        conversationId: conversation.id,
      },
    });
    await expect(
      service.getIssueBinding(conversation.issueId),
    ).resolves.toMatchObject({
      endpointId: endpoint.id,
      conversationId: conversation.id,
      assignedAgentLocked: true,
    });
  });

  it("coalesces one GitHub run's progress and final response into one provider comment", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:417",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "41701",
        text: "@maya produce one quiet GitHub response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "github",
        providerMessageId: "41701",
      }),
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${runId}:queued:${endpoint.id}`,
      payload: { text: "Maya is queued.", progressState: "queued" },
      state: "pending",
    });
    await service.processPendingPublications();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${runId}:working:${endpoint.id}`,
      payload: { text: "Maya is working…", progressState: "working" },
      state: "pending",
    });
    await service.processPendingPublications();
    const finalComment = await issueService(db).addComment(
      conversation.issueId,
      "Final GitHub result",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent" },
    );
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      {
        threadId: thread.thread.id,
        text: "Maya is queued.",
      },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya is working…",
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Final GitHub result",
      },
    ]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      publications.every(
        (publication) =>
          publication.state === "published" &&
          publication.providerMessageId === "outbound-1",
      ),
    ).toBe(true);
    const [providerLink] = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.direction, "outbound"),
        ),
      );
    expect(providerLink).toMatchObject({
      providerMessageId: "outbound-1",
      commentId: finalComment.id,
    });

    await service.processPendingPublications();
    expect(providerRuntime?.posts).toHaveLength(1);
    expect(providerRuntime?.edits).toHaveLength(2);

    const replacementRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: replacementRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: { issueId: conversation.issueId },
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${replacementRunId}:queued:${endpoint.id}`,
      payload: {
        text: "A replacement run is queued.",
        progressState: "queued",
      },
      state: "pending",
    });
    await service.processPendingPublications();
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.editError = Object.assign(new Error("comment gone"), {
      status: 404,
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${replacementRunId}:working:${endpoint.id}`,
      payload: {
        text: "A replacement run is working…",
        progressState: "working",
      },
      state: "pending",
    });
    await service.processPendingPublications();
    const replacementEdit = await db
      .select()
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `run:${replacementRunId}:working:${endpoint.id}`,
        ),
      )
      .then((rows) => rows[0]);
    expect(replacementEdit).toMatchObject({
      state: "published",
      providerMessageId: "outbound-3",
      attempts: 1,
    });
    expect(providerRuntime.editAttempts.at(-1)).toEqual({
      threadId: thread.thread.id,
      messageId: "outbound-2",
    });
    expect(providerRuntime.posts.at(-1)).toEqual({
      threadId: thread.thread.id,
      text: "A replacement run is working…",
    });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation.id, state: "active" }),
    ]);
    providerRuntime.editError = null;

    const ambiguousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ambiguousRunId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: { issueId: conversation.issueId },
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${ambiguousRunId}:queued:${endpoint.id}`,
      payload: { text: "A second run is queued.", progressState: "queued" },
      state: "pending",
    });
    await service.processPendingPublications();
    providerRuntime.postError = new Error("socket reset after write");
    await db.insert(chatPublications).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      issueId: conversation.issueId,
      idempotencyKey: `run:${ambiguousRunId}:working:${endpoint.id}`,
      payload: {
        text: "A second run is working…",
        progressState: "working",
      },
      state: "pending",
    });
    await service.processPendingPublications();
    const ambiguousEdit = await db
      .select()
      .from(chatPublications)
      .where(
        eq(
          chatPublications.idempotencyKey,
          `run:${ambiguousRunId}:working:${endpoint.id}`,
        ),
      )
      .then((rows) => rows[0]);
    expect(ambiguousEdit).toMatchObject({
      state: "delivery_unknown",
      providerMessageId: null,
      attempts: 1,
    });
    expect(providerRuntime.posts).toHaveLength(4);
    expect(providerRuntime.edits).toHaveLength(2);
    await service.processPendingPublications();
    expect(providerRuntime.posts).toHaveLength(4);
    expect(providerRuntime.edits).toHaveLength(2);
  });

  it.each(["slack", "github"] as const)(
    "preserves every %s agent comment after replacing one run placeholder",
    async (provider) => {
      const fixture = await seedCompany();
      const configured =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture)
          : await configuredGitHubEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = configured;
      const thread = makeThread({
        channelId:
          provider === "slack"
            ? "C-MULTI-FINAL"
            : "github:paperclipai/paperclip",
        id:
          provider === "slack"
            ? "slack:C-MULTI-FINAL:4045.1"
            : "github:paperclipai/paperclip:issue:418",
        name: provider === "slack" ? "multi-final" : "paperclipai/paperclip",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: provider === "slack" ? "4045.1" : "41801",
          text: "@maya return three separately visible answers",
          mentioned: true,
        }),
        trigger: "mention",
      });
      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: conversation.issueId,
          provider,
          providerMessageId: provider === "slack" ? "4045.1" : "41801",
        }),
      });
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:working:${endpoint.id}`,
        payload: { text: "Maya is working…", progressState: "working" },
        state: "pending",
      });
      await service.processPendingPublications();

      const comments = [];
      for (const body of ["answer-one", "answer-two", "answer-three"]) {
        comments.push(
          await issueService(db).addComment(
            conversation.issueId,
            body,
            { agentId: fixture.assignedAgentId, runId },
            { authorType: "agent" },
          ),
        );
      }
      await Promise.all([
        service.processPendingPublications(),
        service.processPendingPublications(),
        service.processPendingPublications(),
      ]);

      const providerRuntime = runtime.endpoints.get(endpoint.id);
      expect(providerRuntime?.posts.map((post) => post.text)).toEqual([
        "Maya is working…",
        "answer-two",
        "answer-three",
      ]);
      expect(providerRuntime?.edits).toEqual([
        {
          threadId: thread.thread.id,
          messageId: "outbound-1",
          text: "answer-one",
        },
      ]);
      const commentPublications = await db
        .select()
        .from(chatPublications)
        .where(
          inArray(
            chatPublications.commentId,
            comments.map((comment) => comment.id),
          ),
        )
        .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id));
      expect(commentPublications).toEqual([
        expect.objectContaining({
          commentId: comments[0].id,
          state: "published",
          providerMessageId: "outbound-1",
        }),
        expect.objectContaining({
          commentId: comments[1].id,
          state: "published",
          providerMessageId: "outbound-2",
        }),
        expect.objectContaining({
          commentId: comments[2].id,
          state: "published",
          providerMessageId: "outbound-3",
        }),
      ]);
      expect(
        await db
          .select()
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          ),
      ).toHaveLength(3);
      await service.shutdown();
    },
  );

  it("coalesces one Slack run's lifecycle and final response into one thread reply", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-QUIET-RUN",
      id: "slack:C-QUIET-RUN:4050.1",
      name: "quiet-run",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4050.1",
        text: "@maya produce one quiet Slack response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "slack",
        providerMessageId: "4050.1",
      }),
    });
    for (const milestone of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${milestone}:${endpoint.id}`,
        payload: {
          text: milestone === "queued" ? "Maya is queued." : "Maya is working…",
          progressState: milestone,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }
    const finalText =
      `Final Slack result ${"with enough safe detail. ".repeat(20)}`.trim();
    const finalComment = await issueService(db).addComment(
      conversation.issueId,
      finalText,
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent" },
    );
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is queued." },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya is working…",
      },
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: finalText,
      },
    ]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      publications.every(
        (publication) =>
          publication.state === "published" &&
          publication.providerMessageId === "outbound-1",
      ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(chatMessageLinks.direction, "outbound"),
          ),
        ),
    ).toEqual([
      expect.objectContaining({
        providerMessageId: "outbound-1",
        commentId: finalComment.id,
      }),
    ]);
  });

  it("edits a Slack working reply into one terminal failure reply", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-FAILED-RUN",
      id: "slack:C-FAILED-RUN:4060.1",
      name: "failed-run",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4060.1",
        text: "@maya exercise a failed turn",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "failed",
      contextSnapshot: { issueId: conversation.issueId },
    });
    for (const milestone of ["working", "failed"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${milestone}:${endpoint.id}`,
        payload: {
          text:
            milestone === "working"
              ? "Maya is working…"
              : "Maya stopped before completing this turn.",
          progressState: milestone,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: thread.thread.id, text: "Maya is working…" },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: thread.thread.id,
        messageId: "outbound-1",
        text: "Maya stopped before completing this turn.",
      },
    ]);
  });

  it("drains bounded Slack chat-origin milestones without admitting an internal issue run", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-MILESTONE-DRAIN",
      id: "slack:C-MILESTONE-DRAIN:4065.1",
      name: "milestone-drain",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4065.1",
        text: "@maya exercise bounded milestone draining",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const [inboundLink] = await db
      .select({ commentId: chatMessageLinks.commentId })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.providerMessageId, "4065.1"),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      );
    if (!inboundLink?.commentId) {
      throw new Error("Expected the inbound Slack comment link");
    }
    const runCases = [
      { id: randomUUID(), status: "queued", milestone: "queued" },
      { id: randomUUID(), status: "running", milestone: "working" },
      { id: randomUUID(), status: "failed", milestone: "failed" },
    ] as const;
    const internalRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: internalRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "running",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "issue.comment",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
        updatedAt: new Date("2026-09-05T14:59:59.000Z"),
      },
      ...runCases.map(({ id, status }, index) => ({
        id,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status,
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:slack",
          wakeCommentId: inboundLink.commentId,
          wakeCommentIds: [inboundLink.commentId],
        },
        updatedAt: new Date(`2026-09-05T15:00:0${index}.000Z`),
      })),
    ]);

    const inserted: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      inserted.push(
        await enqueueChatRunMilestones(db, {
          since: new Date("2026-09-05T14:00:00.000Z"),
          limit: 1,
        }),
      );
    }
    expect(inserted).toEqual([1, 1, 1, 0]);
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversation.id));
    expect(publications).toHaveLength(3);
    expect(
      new Set(publications.map((publication) => publication.idempotencyKey)),
    ).toEqual(
      new Set(
        runCases.map(
          ({ id, milestone }) => `run:${id}:${milestone}:${endpoint.id}`,
        ),
      ),
    );
    expect(
      publications.find((publication) =>
        publication.idempotencyKey.startsWith(`run:${internalRunId}:`),
      ),
    ).toBeUndefined();
  });

  it("publishes equal-time Slack outbox rows once in stable order across concurrent drains", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const thread = makeThread({
      channelId: "C-STABLE-OUTBOX",
      id: "slack:C-STABLE-OUTBOX:4075.1",
      name: "stable-outbox",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: thread.thread,
      message: makeMessage({
        id: "4075.1",
        text: "@maya preserve publication order",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const createdAt = new Date("2026-09-05T15:00:00.000Z");
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    await db.insert(chatPublications).values([
      {
        id: secondId,
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `ordering:second:${endpoint.id}`,
        payload: { text: "Second publication" },
        state: "pending",
        createdAt,
      },
      {
        id: firstId,
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `ordering:first:${endpoint.id}`,
        payload: { text: "First publication" },
        state: "pending",
        createdAt,
      },
    ]);

    await Promise.all([
      service.processPendingPublications(),
      service.processPendingPublications(),
    ]);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: thread.thread.id, text: "First publication" },
      { threadId: thread.thread.id, text: "Second publication" },
    ]);
    expect(
      await db
        .select({ id: chatPublications.id, state: chatPublications.state })
        .from(chatPublications)
        .where(inArray(chatPublications.id, [firstId, secondId]))
        .orderBy(asc(chatPublications.id)),
    ).toEqual([
      { id: firstId, state: "published" },
      { id: secondId, state: "published" },
    ]);
  });

  it("does not let one blocked Slack conversation starve another outbox head", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const blockedThread = makeThread({
      channelId: "C-OUTBOX-FAIRNESS",
      id: "slack:C-OUTBOX-FAIRNESS:4080.1",
      name: "outbox-fairness",
    });
    const readyThread = makeThread({
      channelId: "C-OUTBOX-FAIRNESS",
      id: "slack:C-OUTBOX-FAIRNESS:4080.2",
      name: "outbox-fairness",
    });
    for (const [thread, id, text] of [
      [blockedThread, "4080.1", "@maya create the blocked task"],
      [readyThread, "4080.2", "@maya create the ready task"],
    ] as const) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: thread.thread,
        message: makeMessage({ id, text, mentioned: true }),
        trigger: "mention",
      });
    }
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const blockedConversation = conversations.find(
      (conversation) =>
        conversation.externalThreadId === blockedThread.thread.id,
    );
    const readyConversation = conversations.find(
      (conversation) => conversation.externalThreadId === readyThread.thread.id,
    );
    if (!blockedConversation || !readyConversation) {
      throw new Error("Expected both Slack task conversations");
    }

    const baseTime = new Date("2026-09-05T15:10:00.000Z");
    await db.insert(chatPublications).values([
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `fairness:unknown:${endpoint.id}`,
        payload: { text: "Ambiguous predecessor" },
        state: "delivery_unknown",
        createdAt: baseTime,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: blockedConversation.id,
        issueId: blockedConversation.issueId,
        idempotencyKey: `fairness:blocked:${index}:${endpoint.id}`,
        payload: { text: `Blocked publication ${index}` },
        state: "pending",
        createdAt: new Date(baseTime.getTime() + index + 1),
      })),
      {
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: readyConversation.id,
        issueId: readyConversation.issueId,
        idempotencyKey: `fairness:ready:${endpoint.id}`,
        payload: { text: "Ready publication" },
        state: "pending",
        createdAt: new Date(baseTime.getTime() + 60_000),
      },
    ]);

    await service.processPendingPublications(25);

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: readyThread.thread.id, text: "Ready publication" },
    ]);
    await expect(
      db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(
          eq(chatPublications.idempotencyKey, `fairness:ready:${endpoint.id}`),
        ),
    ).resolves.toEqual([{ state: "published" }]);
    expect(
      await db
        .select({ state: chatPublications.state })
        .from(chatPublications)
        .where(eq(chatPublications.conversationId, blockedConversation.id)),
    ).toEqual(
      expect.arrayContaining([
        { state: "delivery_unknown" },
        ...Array.from({ length: 30 }, () => ({ state: "pending" })),
      ]),
    );
  });

  it("streams long output in bounded chunks after applying the safe external projection", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LONG-SAFE",
      id: "slack:C-LONG-SAFE:4100.1",
      name: "long-safe-output",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4100.1",
        text: "@maya send the long public summary",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const publicParagraph = "External-safe result. ".repeat(45).trim();
    const comment = await issueService(db).addComment(
      conversation.issueId,
      `${publicParagraph}\n\n<analysis>private chain of thought must never stream</analysis>`,
      { userId: "owner-user" },
      { authorType: "user" },
    );

    await service.publishComment(endpoint.id, conversation.id, comment.id);
    const [publication] = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.commentId, comment.id));
    expect(publication).toMatchObject({
      state: "published",
      payload: { text: publicParagraph },
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    const streamed = providerRuntime?.posts.at(-1);
    expect(streamed?.chunks?.length).toBeGreaterThan(1);
    expect(
      streamed?.chunks?.every((chunk) => Array.from(chunk).length <= 280),
    ).toBe(true);
    expect(streamed?.chunks?.join("")).toBe(publication.payload.text);
    expect(streamed?.text).toBe(publicParagraph);
    expect(JSON.stringify(streamed)).not.toContain("private chain of thought");
  });

  it.each([
    {
      label: "rate limits as an automatic retry",
      error: Object.assign(new Error("provider rate limit"), {
        status: 429,
        retryAfterMs: 5_000,
      }),
      expectedPublicationState: "retry",
      expectedEndpointStatus: "active",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      label: "authentication failures as endpoint attention",
      error: Object.assign(new Error("provider token expired"), {
        status: 401,
      }),
      expectedPublicationState: "failed",
      expectedEndpointStatus: "attention",
      expectedConversationState: "active",
      expectedResourceAvailability: "available",
    },
    {
      label: "missing destinations as resource unavailable",
      error: Object.assign(new Error("provider destination missing"), {
        status: 404,
      }),
      expectedPublicationState: "cancelled",
      expectedEndpointStatus: "active",
      expectedConversationState: "unavailable",
      expectedResourceAvailability: "unavailable",
    },
  ])(
    "classifies publication $label",
    async ({
      error,
      expectedConversationState,
      expectedEndpointStatus,
      expectedPublicationState,
      expectedResourceAvailability,
    }) => {
      const fixture = await seedCompany();
      const { callbacks, endpoint, runtime, service } =
        await configuredSlackEndpoint(fixture);
      const channelId = `C-PUBLICATION-ERROR-${randomUUID().slice(0, 8)}`;
      const channel = makeThread({
        channelId,
        id: `slack:${channelId}:4200.1`,
        name: "publication-errors",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        thread: channel.thread,
        message: makeMessage({
          id: "4200.1",
          text: "@maya exercise provider failure handling",
          mentioned: true,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id);
      await service.test(endpoint.id, "owner-user");
      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));
      const comment = await issueService(db).addComment(
        conversation.issueId,
        "Safe provider response",
        { userId: "owner-user" },
        { authorType: "user" },
      );
      const providerRuntime = runtime.endpoints.get(endpoint.id);
      if (!providerRuntime) throw new Error("Expected provider runtime");
      providerRuntime.postError = error;
      const beforeAttempt = Date.now();
      await service.publishComment(endpoint.id, conversation.id, comment.id);

      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.commentId, comment.id));
      expect(publication).toMatchObject({
        state: expectedPublicationState,
        attempts: 1,
        redactedError: error.message,
      });
      if (expectedPublicationState === "retry") {
        expect(publication.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
          beforeAttempt + 4_500,
        );
      } else {
        expect(publication.nextAttemptAt).toBeNull();
      }
      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: expectedEndpointStatus,
      });
      const [storedConversation] = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, conversation.id));
      expect(storedConversation.state).toBe(expectedConversationState);
      const [resource] = await db
        .select()
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.id, conversation.resourceId!));
      expect(resource.availability).toBe(expectedResourceAvailability);
      if (expectedEndpointStatus === "attention") {
        expect(runtime.endpoints.has(endpoint.id)).toBe(false);
        const [connection] = await db
          .select()
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId));
        expect(connection).toMatchObject({
          status: "disabled",
          enabled: false,
          healthStatus: "degraded",
        });
      }
    },
  );

  it("publishes a closed-choice question and resolves only its exact issued action as a linked writer", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    if (!callbacks.onAction)
      throw new Error("Slack question action callback was not registered");
    const channel = makeThread({
      channelId: "C-QUESTION",
      id: "slack:C-QUESTION:4500.1",
      name: "questions",
    });
    const externalUserId = `U-QUESTION-${randomUUID()}`;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4500.1",
        text: "@maya help me choose a priority",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));

    const interaction = await issueThreadInteractionService(db).create(
      {
        id: conversation.issueId,
        companyId: fixture.companyId,
      },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        title: "Choose the priority",
        payload: {
          version: 1,
          title: "Choose the priority",
          questions: [
            {
              id: "priority",
              prompt: "Which priority should we use?",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "high", label: "High" },
                { id: "normal", label: "Normal" },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    await service.processPendingPublications();
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.issueId, conversation.issueId),
        ),
      )
      .then((rows) =>
        rows.find((row) => row.idempotencyKey.startsWith("interaction:")),
      );
    if (!publication?.providerMessageId)
      throw new Error("Question publication was not delivered");
    expect(publication).toMatchObject({
      state: "published",
      payload: {
        interactionId: interaction.id,
        progressState: "waiting_for_input",
        card: {
          kind: "question",
          title: "Which priority should we use?",
        },
      },
    });
    const callbackActions = publication.payload.card?.actions?.filter(
      (action) => action.type === "callback",
    );
    expect(callbackActions).toHaveLength(2);
    const highAction = callbackActions?.find(
      (action) => action.label === "High",
    );
    if (!highAction || highAction.type !== "callback")
      throw new Error("High-priority callback was not projected");

    const linkedUserId = `question-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Question User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, externalUserId))
      .then((rows) => rows[0]);
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token) throw new Error("Question-user identity token was absent");
    await service.confirmIdentityLink(token, linkedUserId);

    const actionEvent = (
      overrides: Partial<{
        actionId: string;
        messageId: string;
        threadId: string;
        userId: string;
        value: string;
      }> = {},
    ) => ({
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        actionId: overrides.actionId ?? highAction.actionId,
        adapter: {} as never,
        messageId: overrides.messageId ?? publication.providerMessageId!,
        openModal: async () => undefined,
        raw: { type: "block_actions" },
        thread: channel.thread,
        threadId: overrides.threadId ?? channel.thread.id,
        user: {
          userId: overrides.userId ?? externalUserId,
          userName: "question-user",
          fullName: "Question User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: overrides.value ?? interaction.id,
      },
    });

    const unlinkedAction = actionEvent({
      userId: `U-UNLINKED-${randomUUID()}`,
    });
    await expect(callbacks.onAction(unlinkedAction)).rejects.toMatchObject({
      status: 403,
      message: "This chat action is not a current Paperclip question",
    });
    await expect(callbacks.onAction(unlinkedAction)).rejects.toMatchObject({
      status: 403,
      message: "This chat action is not a current Paperclip question",
    });
    const deniedSlackActions = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "action"),
        ),
      );
    expect(deniedSlackActions).toEqual([
      expect.objectContaining({
        conversationId: null,
        principalId: expect.any(String),
        state: "filtered",
        attempts: 1,
        redactedError: "External action denied by Paperclip authorization",
        normalizedEvent: {
          providerEventId: expect.stringMatching(
            /^action-denied:[a-f0-9]{64}$/,
          ),
          kind: "action",
          authorization: { outcome: "denied" },
        },
      }),
    ]);
    expect(JSON.stringify(deniedSlackActions[0])).not.toContain(
      highAction.actionId,
    );
    expect(JSON.stringify(deniedSlackActions[0])).not.toContain(interaction.id);
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deniedSlackActions[0]!.id,
          kind: "delivery",
          status: "filtered",
          summary: "action ignored",
          detail: "External action denied by Paperclip authorization",
          replayable: false,
        }),
      ]),
    );
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await expect(callbacks.onAction(actionEvent())).rejects.toMatchObject({
      status: 403,
    });
    await db
      .update(companyMemberships)
      .set({ membershipRole: "operator" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );

    const otherChannel = makeThread({
      channelId: "C-QUESTION-OTHER",
      id: "slack:C-QUESTION-OTHER:4501.1",
      name: "other-question",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: otherChannel.thread,
      message: makeMessage({
        id: "4501.1",
        text: "@maya a separate task",
        mentioned: true,
        userId: externalUserId,
      }),
      trigger: "mention",
    });
    await expect(
      callbacks.onAction(actionEvent({ threadId: otherChannel.thread.id })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      callbacks.onAction(actionEvent({ messageId: "outbound-forged" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      callbacks.onAction(actionEvent({ actionId: "pcq:forged" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      callbacks.onAction(actionEvent({ value: randomUUID() })),
    ).rejects.toMatchObject({ status: 403 });

    await callbacks.onAction(actionEvent());
    const [storedInteraction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interaction.id));
    expect(storedInteraction).toMatchObject({
      status: "answered",
      resolvedByUserId: linkedUserId,
      result: {
        version: 1,
        answers: [{ questionId: "priority", optionIds: ["high"] }],
      },
    });
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
        ),
    ).toHaveLength(1);
    const actions = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.endpointId, endpoint.id));
    expect(actions).toHaveLength(2);
    expect(
      actions.find((action) => action.status === "processed"),
    ).toMatchObject({
      status: "processed",
      kind: "question_answer",
      payload: {
        publicationId: publication.id,
        interactionId: interaction.id,
        questionId: "priority",
        optionId: "high",
      },
    });
    expect(actions.find((action) => action.status === "expired")).toMatchObject(
      {
        kind: "question_answer",
        result: { code: "interaction_resolved_by_sibling_action" },
      },
    );
    const answeredActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, fixture.companyId),
          eq(activityLog.action, "issue.thread_interaction_answered"),
          eq(activityLog.entityId, conversation.issueId),
        ),
      );
    expect(answeredActivity).toHaveLength(1);
    expect(answeredActivity[0]).toMatchObject({
      actorType: "user",
      actorId: linkedUserId,
      details: {
        source: "external_chat",
        endpointId: endpoint.id,
        publicationId: publication.id,
        interactionId: interaction.id,
      },
    });

    await expect(callbacks.onAction(actionEvent())).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
        ),
    ).toHaveLength(1);
  });

  it.each([
    { provider: "slack" as const, label: "Slack" },
    { provider: "microsoft-teams" as const, label: "Microsoft Teams" },
  ])(
    "round-trips a $label question modal and rejects forged or replayed tokens",
    async ({ provider }) => {
      const fixture = await seedCompany();
      const context =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture)
          : await (async () => {
              const created = createService(
                new FakeChatSdkRuntime(),
                (async () =>
                  new Response(
                    JSON.stringify({ access_token: "teams-modal-access" }),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    },
                  )) as typeof globalThis.fetch,
              );
              const endpoint = await created.service.create(
                fixture.companyId,
                {
                  provider: "microsoft-teams",
                  assignedAgentId: fixture.assignedAgentId,
                },
                "owner-user",
              );
              await created.service.configure(
                endpoint.id,
                {
                  action: "configure",
                  credentials: {
                    clientId: "00000000-0000-4000-8000-000000000311",
                    tenantId: "00000000-0000-4000-8000-000000000322",
                    clientSecret: "teams-modal-secret",
                  },
                },
                "owner-user",
              );
              const callbacks = created.runtime.configurations.get(
                endpoint.id,
              )?.callbacks;
              if (!callbacks) throw new Error("Expected Teams modal callbacks");
              return { ...created, endpoint, callbacks };
            })();
      const { callbacks, endpoint, service } = context;
      if (!callbacks.onAction || !callbacks.onModalSubmit) {
        throw new Error("Expected question action and modal callbacks");
      }
      const externalUserId = `${provider}-modal-user-${randomUUID()}`;
      const teamsConversationId = "19:modal-conversation@thread.tacv2";
      const teamsServiceUrl = "https://smba.trafficmanager.net/amer/";
      const channel =
        provider === "slack"
          ? makeThread({
              channelId: "C-MODAL-ROUNDTRIP",
              id: `slack:C-MODAL-ROUNDTRIP:${randomUUID()}`,
              name: "modal-roundtrip",
            })
          : makeThread({
              channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
              id: `teams:${Buffer.from(`${teamsConversationId};messageid=modal-root`).toString("base64url")}:${Buffer.from(teamsServiceUrl).toString("base64url")}`,
              name: "modal-roundtrip",
            });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: channel.thread,
        message: makeMessage({
          id: `modal-root-${randomUUID()}`,
          text: "@maya collect the deployment details",
          mentioned: true,
          userId: externalUserId,
        }),
        trigger: "mention",
      });
      await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
      await service.test(endpoint.id, "owner-user");
      const [conversation] = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, endpoint.id));

      const linkedUserId = `modal-paperclip-user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: linkedUserId,
        name: "Modal User",
        email: `${linkedUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: linkedUserId,
        status: "active",
        membershipRole: "operator",
      });
      const principal = await db
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, provider),
            eq(chatExternalPrincipals.externalId, externalUserId),
          ),
        )
        .then((rows) => rows[0]);
      const intent = await service.createLinkIntent(
        endpoint.id,
        principal.id,
        1_800,
      );
      const identityToken = new URL(intent.confirmationUrl).searchParams.get(
        "token",
      );
      if (!identityToken) throw new Error("Modal identity token was absent");
      await service.confirmIdentityLink(identityToken, linkedUserId);

      const interaction = await issueThreadInteractionService(db).create(
        { id: conversation.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title: "Deployment details",
          payload: {
            version: 1,
            title: "Deployment details",
            submitLabel: "Continue",
            questions: [
              {
                id: "environment",
                prompt: "Where should I deploy?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "staging", label: "Staging" },
                  { id: "production", label: "Production" },
                ],
              },
              {
                id: "reason",
                prompt: "What should the release note say?",
                selectionMode: "single",
                required: true,
                allowOther: true,
                options: [
                  {
                    id: "__paperclip_text__",
                    label: "Type an answer",
                    freeText: true,
                  },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      await service.processPendingPublications();
      const publication = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.issueId, conversation.issueId),
          ),
        )
        .then((rows) =>
          rows.find((row) => row.payload.interactionId === interaction.id),
        );
      if (!publication?.providerMessageId) {
        throw new Error("Question form publication was not delivered");
      }
      const openAction = publication.payload.card?.actions?.find(
        (action) => action.type === "callback",
      );
      if (!openAction || openAction.type !== "callback") {
        throw new Error("Question form opener was not projected");
      }
      const modalUser = {
        userId: externalUserId,
        userName: "modal-user",
        fullName: "Modal User",
        isBot: false,
        isMe: false,
        isSystem: false,
      };
      const actionEvent = (actionId: string) => ({
        endpointId: endpoint.id,
        provider,
        event: {
          actionId,
          adapter: {} as never,
          messageId: publication.providerMessageId!,
          openModal: vi.fn(async () => ({ viewId: "modal-view" })),
          raw: {},
          thread: channel.thread,
          threadId: channel.thread.id,
          user: modalUser,
          value: interaction.id,
        },
      });
      await expect(
        callbacks.onAction(
          actionEvent(`pcf:${"A".repeat(22)}`) as Parameters<
            NonNullable<typeof callbacks.onAction>
          >[0],
        ),
      ).rejects.toMatchObject({ status: 403 });

      const validOpen = actionEvent(openAction.actionId);
      await callbacks.onAction(
        validOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
      );
      expect(validOpen.event.openModal).toHaveBeenCalledTimes(1);
      const modal = validOpen.event.openModal.mock.calls[0]?.[0] as {
        callbackId: string;
        children: Array<{
          id: string;
          options?: Array<{ label: string; value: string }>;
          type: string;
        }>;
        privateMetadata?: string;
      };
      const selectField = modal.children.find(
        (child) => child.type === "select",
      );
      const textField = modal.children.find(
        (child) => child.type === "text_input",
      );
      const productionValue = selectField?.options?.find(
        (option) => option.label === "Production",
      )?.value;
      if (!selectField || !textField || !productionValue) {
        throw new Error("Question modal fields were incomplete");
      }
      const modalEvent = (callbackId: string) => ({
        endpointId: endpoint.id,
        provider,
        event: {
          adapter: {} as never,
          callbackId,
          ...(provider === "slack"
            ? { privateMetadata: modal.privateMetadata }
            : {}),
          raw: {},
          relatedMessage: { id: publication.providerMessageId } as never,
          relatedThread: channel.thread,
          user: modalUser,
          values: {
            [selectField.id]: productionValue,
            [textField.id]: "Add regional failover",
          },
          viewId: "modal-view",
        },
      });
      await expect(
        callbacks.onModalSubmit(
          modalEvent(`pcfs:${"A".repeat(22)}`) as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).rejects.toMatchObject({ status: 403 });

      const validSubmit = modalEvent(modal.callbackId);
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      const [answered] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id));
      expect(answered).toMatchObject({
        status: "answered",
        resolvedByUserId: linkedUserId,
        result: {
          version: 1,
          answers: [
            { questionId: "environment", optionIds: ["production"] },
            {
              questionId: "reason",
              optionIds: [],
              otherText: "Add regional failover",
            },
          ],
        },
      });
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await db
          .select()
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
      ).toHaveLength(1);
    },
  );

  it("uses compact single-use Telegram action tokens and rejects forged, expired, and oversized callbacks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTelegramEndpoint(fixture);
    const externalUserId = "771234567";
    const channel = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Maya direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: channel.thread,
      message: makeMessage({
        id: "tg-question-1",
        text: "Help me choose a priority",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));

    const linkedUserId = `telegram-question-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Question User",
      email: `${linkedUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "operator",
    });
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(eq(chatExternalPrincipals.externalId, externalUserId))
      .then((rows) => rows[0]);
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const identityToken = new URL(intent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!identityToken) throw new Error("Telegram identity token was absent");
    await service.confirmIdentityLink(identityToken, linkedUserId);

    async function publishQuestion(title: string) {
      const interaction = await issueThreadInteractionService(db).create(
        {
          id: conversation.issueId,
          companyId: fixture.companyId,
        },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          title,
          payload: {
            version: 1,
            title,
            questions: [
              {
                id: "priority",
                prompt: "Which priority should we use?",
                selectionMode: "single",
                required: true,
                allowOther: false,
                options: [
                  { id: "high", label: "High" },
                  { id: "normal", label: "Normal" },
                ],
              },
            ],
          },
        },
        { agentId: fixture.assignedAgentId },
      );
      await service.processPendingPublications();
      const publication = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.issueId, conversation.issueId),
          ),
        )
        .then((rows) =>
          rows.find(
            (row) =>
              row.payload.interactionId === interaction.id &&
              row.state === "published",
          ),
        );
      if (!publication?.providerMessageId)
        throw new Error("Telegram question publication was not delivered");
      const action = publication.payload.card?.actions?.find(
        (candidate) =>
          candidate.type === "callback" && candidate.label === "High",
      );
      if (!action || action.type !== "callback")
        throw new Error("Telegram callback action was not projected");
      const token = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, action.actionId),
          ),
        )
        .then((rows) => rows[0]);
      if (!token) throw new Error("Telegram action token was not persisted");
      return { interaction, publication, action, token };
    }

    const first = await publishQuestion("Choose the initial priority");
    const callbackData = telegramChatSdkCallbackData(first.action.actionId);
    expect(Buffer.byteLength(callbackData, "utf8")).toBe(39);
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
    expect(first.token).toMatchObject({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      conversationId: conversation.id,
      principalId: null,
      kind: "question_answer",
      providerActionId: first.action.actionId,
      status: "issued",
      payload: {
        version: 1,
        publicationId: first.publication.id,
        interactionId: first.interaction.id,
        questionId: "priority",
        optionId: "high",
        expiresAt: expect.any(String),
      },
    });

    const actionEvent = (input: {
      actionId: string;
      callbackData: string;
      messageId?: string;
    }) => ({
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        actionId: input.actionId,
        adapter: {} as never,
        messageId: input.messageId ?? first.publication.providerMessageId!,
        openModal: async () => undefined,
        raw: {
          id: `callback-${randomUUID()}`,
          data: input.callbackData,
          from: { id: Number(externalUserId), first_name: "Telegram User" },
        },
        thread: channel.thread,
        threadId: channel.thread.id,
        user: {
          userId: externalUserId,
          userName: "telegram-user",
          fullName: "Telegram User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        value: undefined,
      },
    });

    const forgedActionId = "pcq:AAAAAAAAAAAAAAAAAAAAAA";
    const forgedTelegramAction = actionEvent({
      actionId: forgedActionId,
      callbackData: telegramChatSdkCallbackData(forgedActionId),
    });
    await expect(
      callbacks.onAction(forgedTelegramAction),
    ).rejects.toMatchObject({
      status: 403,
      message: "This chat action is not a current Paperclip question",
    });
    await expect(
      callbacks.onAction(forgedTelegramAction),
    ).rejects.toMatchObject({
      status: 403,
      message: "This chat action is not a current Paperclip question",
    });
    const deniedTelegramActions = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "action"),
        ),
      );
    expect(deniedTelegramActions).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        principalId: principal.id,
        state: "filtered",
        attempts: 1,
        redactedError: "External action denied by Paperclip authorization",
        normalizedEvent: {
          providerEventId: expect.stringMatching(
            /^action-denied:[a-f0-9]{64}$/,
          ),
          kind: "action",
          authorization: { outcome: "denied" },
        },
      }),
    ]);
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      forgedActionId,
    );
    expect(JSON.stringify(deniedTelegramActions[0])).not.toContain(
      telegramChatSdkCallbackData(forgedActionId),
    );
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deniedTelegramActions[0]!.id,
          kind: "delivery",
          status: "filtered",
          summary: "action ignored",
          detail: "External action denied by Paperclip authorization",
          replayable: false,
        }),
      ]),
    );

    const oversizedCallbackData = "x".repeat(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES + 1,
    );
    expect(Buffer.byteLength(oversizedCallbackData, "utf8")).toBe(65);
    await expect(
      callbacks.onAction(
        actionEvent({
          actionId: first.action.actionId,
          callbackData: oversizedCallbackData,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    await db
      .update(chatActions)
      .set({ payload: { ...first.token.payload, optionId: "forged-option" } })
      .where(eq(chatActions.id, first.token.id));
    await expect(
      callbacks.onAction(
        actionEvent({
          actionId: first.action.actionId,
          callbackData,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .update(chatActions)
      .set({ payload: first.token.payload })
      .where(eq(chatActions.id, first.token.id));

    await callbacks.onAction(
      actionEvent({
        actionId: first.action.actionId,
        callbackData,
      }),
    );
    const [answered] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.interaction.id));
    expect(answered).toMatchObject({
      status: "answered",
      resolvedByUserId: linkedUserId,
      result: {
        version: 1,
        answers: [{ questionId: "priority", optionIds: ["high"] }],
      },
    });
    await expect(
      callbacks.onAction(
        actionEvent({
          actionId: first.action.actionId,
          callbackData,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(
            issueQuestionResponseDeliveries.interactionId,
            first.interaction.id,
          ),
        ),
    ).toHaveLength(1);

    const expired = await publishQuestion("Choose an expired priority");
    await db
      .update(chatActions)
      .set({
        payload: {
          ...expired.token.payload,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      })
      .where(eq(chatActions.id, expired.token.id));
    const expiredCallbackData = telegramChatSdkCallbackData(
      expired.action.actionId,
    );
    await expect(
      callbacks.onAction(
        actionEvent({
          actionId: expired.action.actionId,
          callbackData: expiredCallbackData,
          messageId: expired.publication.providerMessageId!,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const [expiredToken] = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, expired.token.id));
    expect(expiredToken).toMatchObject({
      status: "expired",
      result: { code: "question_action_token_expired" },
    });
    const [stillPending] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, expired.interaction.id));
    expect(stillPending.status).toBe("pending");
  });

  it("publishes complex question sets as non-executable Paperclip fallbacks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-COMPLEX-QUESTION",
      id: "slack:C-COMPLEX-QUESTION:4550.1",
      name: "complex-questions",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4550.1",
        text: "@maya ask for several inputs",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const interaction = await issueThreadInteractionService(db).create(
      { id: conversation.issueId, companyId: fixture.companyId },
      {
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: [
            {
              id: "regions",
              prompt: "Which regions?",
              selectionMode: "multi",
              required: true,
              allowOther: false,
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "EU" },
              ],
            },
            {
              id: "notes",
              prompt: "Any constraints?",
              selectionMode: "single",
              required: false,
              allowOther: true,
              options: [
                { id: "other", label: "Describe them", freeText: true },
              ],
            },
          ],
        },
      },
      { agentId: fixture.assignedAgentId },
    );
    const publications = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.issueId, conversation.issueId),
        ),
      );
    const publication = publications.find(
      (candidate) => candidate.payload.interactionId === interaction.id,
    );
    expect(publication).toBeDefined();
    if (!publication) throw new Error("Expected interaction publication");
    expect(publication.payload).toMatchObject({
      interactionId: interaction.id,
    });
    expect(
      publication.payload.card?.actions?.filter(
        (action) => action.type === "callback",
      ) ?? [],
    ).toEqual([]);
    expect(publication.payload.text).toContain(
      "Open the task in Paperclip to respond",
    );
    expect(callbacks.onModalSubmit).toBeTypeOf("function");
    expect(callbacks.onModalClose).toBeUndefined();
    expect(callbacks.onReaction).toBeTypeOf("function");
  });

  it("preserves the raw webhook request and returns the provider adapter response", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime)
      throw new Error("Expected configured fake provider runtime");
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-123",
    });

    const response = await request(webhookApp(service))
      .post(`/api/chat-webhooks/${endpoint.publicId}/slack`)
      .set("content-type", "application/json")
      .set("x-slack-signature", "v0=test-signature")
      .send(payload)
      .expect(202);

    expect(response.text).toBe("accepted");
    expect(response.headers["x-chat-test"]).toBe("accepted");
    expect(
      providerRuntime.webhookRequest?.headers.get("x-slack-signature"),
    ).toBe("v0=test-signature");
    await expect(providerRuntime.webhookRequest?.text()).resolves.toBe(payload);

    await request(webhookApp(service))
      .post(`/api/chat-webhooks/${endpoint.publicId}/irc`)
      .set("content-type", "application/json")
      .send("{}")
      .expect(400);
  });

  it("retires superseded credentials and clears endpoint-owned secrets on removal", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "slack",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "xoxb-first", signingSecret: "first-secret" },
      },
      "owner-user",
    );
    const [firstConnection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const firstIds = new Set(
      firstConnection.credentialSecretRefs.map((ref) => ref.secretId),
    );
    expect(firstIds.size).toBe(2);

    await service.configure(
      endpoint.id,
      {
        action: "reconnect",
        credentials: {
          botToken: "xoxb-second",
          signingSecret: "second-secret",
        },
      },
      "owner-user",
    );
    const [rotatedConnection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(rotatedConnection.credentialSecretRefs).toHaveLength(2);
    expect(
      rotatedConnection.credentialSecretRefs.every(
        (ref) => !firstIds.has(ref.secretId),
      ),
    ).toBe(true);
    const afterRotation = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, fixture.companyId));
    expect(afterRotation.map((secret) => secret.id).sort()).toEqual(
      rotatedConnection.credentialSecretRefs.map((ref) => ref.secretId).sort(),
    );

    await service.configure(endpoint.id, { action: "remove" }, "owner-user");
    const [removedConnection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(removedConnection.credentialSecretRefs).toEqual([]);
    expect(
      await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).toHaveLength(0);
  });

  it("marks provider setup as needing attention when Telegram webhook registration fails", async () => {
    const fixture = await seedCompany();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 42, username: "maya_e2e_bot", first_name: "Maya" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/setWebhook")) {
        return new Response(
          JSON.stringify({ ok: false, description: "webhook unavailable" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const { service, runtime } = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken: "telegram-test-token" },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Provider setup needs attention",
      lastError: "Telegram could not register the webhook: webhook unavailable",
    });
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toMatchObject({
      healthStatus: "degraded",
      healthMessage: "Provider setup failed",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
  });

  it("redacts Telegram bot tokens from provider setup errors and endpoint health", async () => {
    const fixture = await seedCompany();
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 43,
              username: "redaction_test_bot",
              first_name: "Redaction",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.endsWith("/getWebhookInfo"))
        throw new Error(`network failed for ${url}; token ${botToken}`);
      throw new Error(`Unexpected provider request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "telegram",
        assignedAgentId: fixture.assignedAgentId,
      },
      "owner-user",
    );

    let setupError: unknown;
    try {
      await service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { botToken },
        },
        "owner-user",
      );
    } catch (error) {
      setupError = error;
    }

    expect(setupError).toMatchObject({
      status: 422,
      details: { code: "chat_provider_setup_failed" },
    });
    const configured = await service.get(endpoint.id);
    const serializedFailure = JSON.stringify({ setupError, configured });
    expect(serializedFailure).not.toContain(botToken);
    expect(serializedFailure).not.toContain(encodeURIComponent(botToken));
    expect(configured).toMatchObject({
      status: "attention",
      healthMessage: "Provider setup needs attention",
      lastError:
        "network failed for https://api.telegram.org/bot***REDACTED***/getWebhookInfo; token ***REDACTED***",
    });
  });

  it("creates an explicit board comment and publication exactly once across retries", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-BOARD-SEND",
      id: "slack:C-BOARD-SEND:4400.1",
      name: "board-send",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4400.1",
        text: "@maya start a board-send task",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));

    const first = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Visible board update",
      "same-browser-request-1234",
      "owner-user",
    );
    const second = await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Visible board update",
      "same-browser-request-1234",
      "owner-user",
    );

    expect(second.id).toBe(first.id);
    const comments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.body, "Visible board update"),
        ),
      );
    const publications = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.idempotencyKey, first.idempotencyKey));
    expect(comments).toHaveLength(1);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      state: "published",
      commentId: comments[0].id,
    });
    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: channel.thread.id, text: "Visible board update" },
    ]);
  });

  it("publishes a serialized Telegram run response after the preceding run completes the conversation", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77119922",
      id: "telegram:77119922",
      isDM: true,
      name: "Telegram completion race",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77119922:1",
        text: "Start the setup conversation",
        userId: "77119922",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "77119922");
    await service.test(endpoint.id, "owner-user");

    for (const [id, text] of [
      ["77119922:2", "First queued question"],
      ["77119922:3", "Second queued question"],
    ] as const) {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({ id, text, userId: "77119922" }),
        trigger: "direct_message",
      });
    }

    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const inboundLinks = await db
      .select()
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.direction, "inbound"),
          inArray(chatMessageLinks.providerMessageId, [
            "77119922:2",
            "77119922:3",
          ]),
        ),
      );
    const firstWakeCommentId = inboundLinks.find(
      (link) => link.providerMessageId === "77119922:2",
    )?.commentId;
    const secondWakeCommentId = inboundLinks.find(
      (link) => link.providerMessageId === "77119922:3",
    )?.commentId;
    if (!firstWakeCommentId || !secondWakeCommentId) {
      throw new Error("Expected both inbound Telegram comments to be linked");
    }

    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const internalRecoveryRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: firstWakeCommentId,
          wakeCommentIds: [firstWakeCommentId],
        },
      },
      {
        id: secondRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "chat:telegram",
          wakeCommentId: secondWakeCommentId,
          wakeCommentIds: [secondWakeCommentId],
        },
      },
      {
        id: internalRecoveryRunId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: {
          issueId: conversation.issueId,
          source: "issue.comment",
          wakeReason: "finish_successful_run_handoff",
          wakeSource: "automation",
        },
      },
    ]);

    const firstResponse = await issueService(db).addComment(
      conversation.issueId,
      "First queued answer",
      { agentId: fixture.assignedAgentId, runId: firstRunId },
      { authorType: "agent" },
    );
    await service.processPendingPublications();
    const activeInternalComment = await issueService(db).addComment(
      conversation.issueId,
      "Active recovery note that must stay internal",
      {
        agentId: fixture.assignedAgentId,
        runId: internalRecoveryRunId,
      },
      { authorType: "agent" },
    );
    const internalAttachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: activeInternalComment.id,
      provider: "local_disk",
      objectKey: "issues/internal-recovery.txt",
      contentType: "text/plain",
      byteSize: 18,
      sha256: "a".repeat(64),
      originalFilename: "internal-recovery.txt",
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: internalRecoveryRunId,
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, conversation.issueId));
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, conversation.id));

    const secondResponse = await issueService(db).addComment(
      conversation.issueId,
      "Second queued answer",
      { agentId: fixture.assignedAgentId, runId: secondRunId },
      { authorType: "agent" },
    );
    const lateInternalComment = await issueService(db).addComment(
      conversation.issueId,
      "Later internal-only note",
      { agentId: fixture.assignedAgentId },
      { authorType: "agent" },
    );

    const responsePublications = await db
      .select()
      .from(chatPublications)
      .where(
        inArray(chatPublications.commentId, [
          firstResponse.id,
          secondResponse.id,
          activeInternalComment.id,
          lateInternalComment.id,
        ]),
      );
    expect(responsePublications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commentId: firstResponse.id,
          conversationId: conversation.id,
          state: "published",
        }),
        expect.objectContaining({
          commentId: secondResponse.id,
          conversationId: conversation.id,
          state: "pending",
        }),
      ]),
    );
    for (const internalCommentId of [
      activeInternalComment.id,
      lateInternalComment.id,
    ]) {
      expect(
        responsePublications.find(
          (publication) => publication.commentId === internalCommentId,
        ),
      ).toBeUndefined();
    }
    expect(
      await db
        .select()
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment:${internalAttachment.id}:${endpoint.id}`,
          ),
        ),
    ).toHaveLength(0);

    await service.processPendingPublications();
    expect(
      runtime.endpoints.get(endpoint.id)?.posts.map((post) => post.text),
    ).toEqual(["First queued answer", "Second queued answer"]);

    const chatAttachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      issueCommentId: secondResponse.id,
      provider: "local_disk",
      objectKey: "issues/chat-result.txt",
      contentType: "text/plain",
      byteSize: 11,
      sha256: "b".repeat(64),
      originalFilename: "chat-result.txt",
      createdByAgentId: fixture.assignedAgentId,
      createdByRunId: secondRunId,
    });
    await expect(
      db
        .select()
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `attachment:${chatAttachment.id}:${endpoint.id}`,
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        commentId: secondResponse.id,
        conversationId: conversation.id,
        state: "pending",
      }),
    ]);
  });

  it("holds ambiguous provider sends for an audited duplicate-risk resolution without reordering", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-UNKNOWN",
      id: "slack:C-UNKNOWN:4500.1",
      name: "unknown-delivery",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "4500.1",
        text: "@maya test an ambiguous response",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const firstComment = await issueService(db).addComment(
      conversation.issueId,
      "First safe response",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const secondComment = await issueService(db).addComment(
      conversation.issueId,
      "Second safe response",
      { userId: "owner-user" },
      { authorType: "user" },
    );
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected provider runtime");
    providerRuntime.postError = new Error("socket reset after write");

    await service.publishComment(endpoint.id, conversation.id, firstComment.id);
    const firstPublication = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.commentId, firstComment.id))
      .then((rows) => rows[0]);
    expect(firstPublication).toMatchObject({
      state: "delivery_unknown",
      attempts: 1,
      providerMessageId: null,
    });

    await service.publishComment(
      endpoint.id,
      conversation.id,
      secondComment.id,
    );
    const secondPublication = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.commentId, secondComment.id))
      .then((rows) => rows[0]);
    expect(secondPublication.state).toBe("pending");
    const activity = await service.listActivity(endpoint.id);
    expect(
      activity.find((item) => item.id === firstPublication.id),
    ).toMatchObject({
      kind: "publication",
      status: "delivery_unknown",
      replayable: false,
      resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
    });
    await expect(
      service.replayPublication(endpoint.id, firstPublication.id),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_publication_resolution_required" },
    });

    providerRuntime.postError = null;
    await service.resolvePublication(
      endpoint.id,
      firstPublication.id,
      "retry_anyway",
      "owner-user",
    );
    await service.processPendingPublications();
    const replayed = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.id, firstPublication.id))
      .then((rows) => rows[0]);
    const releasedSecond = await db
      .select()
      .from(chatPublications)
      .where(eq(chatPublications.id, secondPublication.id))
      .then((rows) => rows[0]);
    expect(replayed.state).toBe("published");
    expect(releasedSecond.state).toBe("published");
    expect(providerRuntime.posts.map((post) => post.text)).toEqual([
      "First safe response",
      "Second safe response",
    ]);
    const [resolutionActivity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, firstPublication.id));
    expect(resolutionActivity).toMatchObject({
      actorType: "user",
      actorId: "owner-user",
      action: "chat.publication_retry_anyway",
    });
  });

  it("wakes the bound task when an operator replays a failed delivery", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REPLAY",
      id: "slack:C-REPLAY:5000.1",
      name: "replay",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: makeMessage({
        id: "5000.1",
        text: "@maya retry this",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await db
      .update(chatDeliveries)
      .set({ state: "failed", redactedError: "temporary failure" })
      .where(eq(chatDeliveries.id, delivery.id));

    await service.replayDelivery(endpoint.id, delivery.id);

    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[1]?.[1]).toMatchObject({
      reason: "External chat message received",
      payload: {
        mutation: "chat_message_received",
        wakeCommentId: expect.any(String),
      },
    });
    const [replayed] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.id, delivery.id));
    expect(replayed).toMatchObject({
      state: "processed",
      attempts: 2,
      redactedError: null,
    });
  });

  it("turns a Slack slash command into a new native thread and one Paperclip task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMANDS",
      label: "commands",
      availability: "available",
      enabled: true,
    });
    const starterThreadId = "slack:C-COMMANDS:6000.1";
    const post = vi.fn(async () => ({
      id: "6000.1",
      threadId: starterThreadId,
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-6000",
      threadId: starterThreadId,
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMANDS",
          name: "commands",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command,
        text: "investigate the command path",
        triggerId: "trigger-6000",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-6000" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });

    expect(post).toHaveBeenCalledWith("Starting a task…");
    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({
      externalThreadId: starterThreadId,
      state: "active",
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId));
    expect(comments.map((comment) => comment.body)).toEqual([
      "investigate the command path",
    ]);
  });

  it("admits concurrent and retried Slack slash commands only once", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMAND-RETRY",
      label: "command-retry",
      availability: "available",
      enabled: true,
    });
    const starterThreadId = "slack:C-COMMAND-RETRY:6001.1";
    let releasePost!: (value: { id: string; threadId: string }) => void;
    const post = vi.fn(
      () =>
        new Promise<{ id: string; threadId: string }>((resolve) => {
          releasePost = resolve;
        }),
    );
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-6001",
      threadId: starterThreadId,
    }));
    const slashEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        channel: {
          id: "C-COMMAND-RETRY",
          name: "command-retry",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command,
        text: "investigate one retried command",
        triggerId: "trigger-6001",
        user: {
          userId: "U-COMMAND-RETRY",
          userName: "command-retry",
          fullName: "Command Retry User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-6001" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    };

    const first = callbacks.onSlashCommand(slashEvent);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const concurrentRetry = callbacks.onSlashCommand(slashEvent);
    releasePost({ id: "6001.1", threadId: starterThreadId });
    await Promise.all([first, concurrentRetry]);

    // A later provider retry resumes from the durable root binding. The
    // synthetic inbound ledger then proves that the task mutation already ran.
    await callbacks.onSlashCommand(slashEvent);

    expect(post).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({
        externalThreadId: starterThreadId,
        state: "active",
      }),
    ]);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId)),
    ).resolves.toEqual([{ body: "investigate one retried command" }]);
    const [action] = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.endpointId, endpoint.id));
    expect(action).toMatchObject({
      kind: "slash_task_start",
      status: "processed",
      result: {
        threadId: starterThreadId,
        providerMessageId: "6001.1",
      },
    });

    await db
      .update(chatActions)
      .set({
        status: "delivery_unknown",
        result: { code: "slash_task_delivery_unknown" },
      })
      .where(eq(chatActions.id, action!.id));
    expect(await service.listActivity(endpoint.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: action!.id,
          kind: "delivery",
          status: "delivery_unknown",
          summary: "Slack slash-command task start delivery unknown",
          detail: expect.stringContaining("will not replay it automatically"),
          replayable: false,
        }),
      ]),
    );
  });

  it("treats exact Slack status, new, and close text as DM task controls without issuing chat actions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredSlackEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    const dm = makeThread({
      channelId: "D-CONTROLS",
      id: "slack:D-CONTROLS:",
      isDM: true,
      name: "direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: "dm-control-root-1",
        text: "Start the first DM task",
        userId: "U-DM-CONTROLS",
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, "U-DM-CONTROLS");
    await service.test(endpoint.id, "owner-user");
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const post = vi.fn(async () => ({
      id: "unexpected-control-root",
      threadId: dm.thread.id,
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "unexpected-control-ephemeral",
      threadId: dm.thread.id,
    }));
    const slashChannel = {
      id: "slack:D-CONTROLS",
      name: "direct message",
      isDM: true,
      post,
      postEphemeral,
    } as never;
    const invokeControl = async (control: "status" | "new" | "close") => {
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: slashChannel,
          command,
          text: control,
          triggerId: `trigger-${control}-${randomUUID()}`,
          user: {
            userId: "U-DM-CONTROLS",
            userName: "dm-controller",
            fullName: "DM Controller",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text: control },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    };
    const issuesBeforeStatus = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    await invokeControl("status");
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(issuesBeforeStatus.length);
    expect(runtime.endpoints.get(endpoint.id)?.posts.at(-1)?.text).toMatch(
      /— todo$/,
    );

    await invokeControl("new");
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(issuesBeforeStatus.length);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: dm.thread,
      message: makeMessage({
        id: "dm-control-root-2",
        text: "Start the second DM task",
        userId: "U-DM-CONTROLS",
      }),
      trigger: "direct_message",
    });
    const issuesBeforeClose = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, fixture.companyId));
    expect(issuesBeforeClose).toHaveLength(issuesBeforeStatus.length + 1);
    await invokeControl("close");
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(issuesBeforeClose.length);
    expect(
      (await service.listConversations(endpoint.id)).map(
        (conversation) => conversation.state,
      ),
    ).toEqual(["completed", "completed"]);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.endpointId, endpoint.id)),
    ).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("returns ephemeral guidance for exact Slack controls in channels without creating tasks or actions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Slack slash command callback was not registered");
    }
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-CONTROL-GUIDANCE",
      label: "control-guidance",
      availability: "available",
      enabled: true,
    });
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    const post = vi.fn(async () => ({
      id: "unexpected-channel-control-post",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "channel-control-guidance",
      threadId: "slack:C-CONTROL-GUIDANCE:root",
    }));
    for (const control of ["status", "new", "close"] as const) {
      await callbacks.onSlashCommand({
        endpointId: endpoint.id,
        provider: "slack",
        event: {
          channel: {
            id: "slack:C-CONTROL-GUIDANCE",
            name: "control-guidance",
            isDM: false,
            post,
            postEphemeral,
          } as never,
          command,
          text: control,
          triggerId: `channel-control-${control}`,
          user: {
            userId: "U-CHANNEL-CONTROLLER",
            userName: "channel-controller",
            fullName: "Channel Controller",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { command, text: control },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    }
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(3);
    for (const call of postEphemeral.mock.calls) {
      expect(call[1]).toBe(
        "Use status, new, and close in a direct message with this agent. In a channel, open the Paperclip task from its Slack thread.",
      );
      expect(call[2]).toEqual({ fallbackToDM: false });
    }
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.endpointId, endpoint.id)),
    ).toHaveLength(0);
  });

  it("keeps Telegram start and unknown commands as terse guidance without creating work", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredTelegramEndpoint(fixture);
    if (!callbacks.onSlashCommand) {
      throw new Error("Telegram slash command callback was not registered");
    }
    const post = vi.fn(async () => ({
      id: `telegram-guidance-${randomUUID()}`,
      threadId: "telegram:77112233",
    }));
    const channel = {
      id: "77112233",
      name: "Telegram direct message",
      isDM: true,
      post,
    } as never;
    const invoke = async (command: string, text: string) => {
      await callbacks.onSlashCommand!({
        endpointId: endpoint.id,
        provider: "telegram",
        event: {
          channel,
          command,
          text,
          triggerId: `telegram-command-${randomUUID()}`,
          user: {
            userId: "77112233",
            userName: "telegram-user",
            fullName: "Telegram User",
            isBot: false,
            isMe: false,
            isSystem: false,
          },
          raw: { message: { text: `${command} ${text}`.trim() } },
          adapter: {} as never,
          openModal: async () => undefined,
        },
      });
    };
    await invoke("/start", "ignored payload");
    await invoke("/danger", "create an administrator action");

    expect(post).toHaveBeenNthCalledWith(
      1,
      "Send a message to start work with Maya. Use /status, /new, or /close to manage the active task in this chat.",
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "Available commands: /status, /new, and /close.",
    );
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.endpointId, endpoint.id)),
    ).toHaveLength(0);
  });

  it("keeps successive Telegram DM messages on one active Paperclip task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const dm = makeThread({
      channelId: "77112233",
      id: "telegram:77112233",
      isDM: true,
      name: "Telegram direct message",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77112233:11",
        text: "Start one DM task",
        userId: "77112233",
      }),
      trigger: "direct_message",
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    await qualifySetupRoundTrip(service, endpoint.id, "77112233");
    await service.test(endpoint.id, "owner-user");
    wakeup.mockClear();
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: "77112233:12",
        text: "Continue that same DM task",
        userId: "77112233",
      }),
      trigger: "direct_message",
    });

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toEqual([
      expect.objectContaining({ state: "active", sessionGeneration: 1 }),
    ]);
    expect(
      await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, conversations[0]!.issueId))
      ).map((comment) => comment.body),
    ).toEqual(
      expect.arrayContaining([
        "Start one DM task",
        "Continue that same DM task",
      ]),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unbound rich callbacks and unknown slash commands", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    expect(callbacks.onAction).toBeTypeOf("function");
    expect(callbacks.onModalSubmit).toBeTypeOf("function");
    expect(callbacks.onModalClose).toBeUndefined();
    expect(callbacks.onOptionsLoad).toBeUndefined();
    expect(callbacks.onReaction).toBeTypeOf("function");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: "C-COMMAND-DENY",
      label: "denied commands",
      availability: "available",
      enabled: true,
    });
    const post = vi.fn(async () => ({
      id: "unexpected-post",
      threadId: "slack:C-COMMAND-DENY:6100.1",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-deny",
      threadId: "slack:C-COMMAND-DENY:6100.1",
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "C-COMMAND-DENY",
          name: "denied commands",
          isDM: false,
          post,
          postEphemeral,
        } as never,
        command: "/anything-else",
        text: "should not start work",
        triggerId: "trigger-deny",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-deny" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.anything(),
      `This connection only accepts ${command}.`,
      { fallbackToDM: false },
    );
    expect(await service.listConversations(endpoint.id)).toEqual([]);
  });

  it("applies the direct-message toggle to Slack slash commands", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredSlackEndpoint(fixture);
    const command = endpoint.setup.command;
    if (!command) throw new Error("Slack endpoint did not expose its command");
    if (!callbacks.onSlashCommand)
      throw new Error("Slack slash command callback was not registered");
    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    const post = vi.fn(async () => ({
      id: "unexpected-dm-post",
      threadId: "slack:D-COMMANDS:6200.1",
    }));
    const postEphemeral = vi.fn(async () => ({
      id: "ephemeral-dm-deny",
      threadId: "slack:D-COMMANDS:6200.1",
    }));
    await callbacks.onSlashCommand({
      endpointId: endpoint.id,
      provider: "slack",
      event: {
        channel: {
          id: "D-COMMANDS",
          name: "direct message",
          isDM: true,
          post,
          postEphemeral,
        } as never,
        command,
        text: "should not start work",
        triggerId: "trigger-dm-deny",
        user: {
          userId: "U-COMMANDER",
          userName: "commander",
          fullName: "Command User",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        raw: { trigger_id: "trigger-dm-deny" },
        adapter: {} as never,
        openModal: async () => undefined,
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.anything(),
      "This channel or account is not allowed to start Paperclip work.",
      { fallbackToDM: false },
    );
  });

  it("records message edits and deletes durably and deduplicates lifecycle callbacks", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-LIFECYCLE",
      id: "slack:C-LIFECYCLE:7000.1",
      name: "lifecycle",
    });
    const original = makeMessage({
      id: "7000.1",
      text: "@maya original request",
      mentioned: true,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: original,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    if (!callbacks.onMessageUpdated || !callbacks.onMessageDeleted) {
      throw new Error("Slack lifecycle callbacks were not registered");
    }
    const edited = {
      ...makeMessage({ id: "7000.1", text: "@maya corrected request" }),
      metadata: {
        dateSent: new Date("2026-09-04T10:00:00.000Z"),
        edited: true,
        editedAt: new Date("2026-09-04T10:01:00.000Z"),
      },
    } as Message;
    const updateEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      thread: channel.thread,
      message: edited,
      previousMessage: original,
    };
    await callbacks.onMessageUpdated(updateEvent);
    await callbacks.onMessageUpdated(updateEvent);
    const deleteEvent = {
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        channelId: "C-LIFECYCLE",
        deletedAt: new Date("2026-09-04T10:02:00.000Z"),
        messageId: "7000.1",
        platform: "slack",
        raw: {},
        threadId: channel.thread.id,
      },
    };
    await callbacks.onMessageDeleted(deleteEvent);
    await callbacks.onMessageDeleted(deleteEvent);

    const deliveries = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(deliveries.map((delivery) => delivery.eventKind).sort()).toEqual([
      "mention",
      "message",
      "message_deleted",
      "message_updated",
    ]);
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId));
    expect(
      comments
        .filter(
          (comment) =>
            comment.body !== "Setup round trip complete" &&
            comment.body !== "Setup follow-up",
        )
        .map((comment) => comment.body)
        .sort(),
    ).toEqual(
      [
        "@maya original request",
        "An external message was edited:\n\n@maya corrected request",
        "An external message in this conversation was deleted.",
      ].sort(),
    );
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("acknowledges Telegram edits while verifying and when processing is suspended", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112234";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:51`,
        text: "Original setup request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });

    const sendEdit = (editDate: number, text: string) =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: editDate,
            edited_message: {
              message_id: 51,
              edit_date: editDate,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text,
            },
          }),
        }),
      );

    const transaction = vi.spyOn(db, "transaction");
    transaction.mockRejectedValueOnce(
      new Error("injected lifecycle transaction failure"),
    );
    await expect(
      sendEdit(1_788_620_100, "Edited during setup"),
    ).rejects.toThrow("injected lifecycle transaction failure");
    transaction.mockRestore();
    await expect(
      db
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        ),
    ).resolves.toEqual([]);

    await expect(
      sendEdit(1_788_620_100, "Edited during setup"),
    ).resolves.toMatchObject({ ok: true });
    expect(wakeup).toHaveBeenCalledTimes(1);

    for (const status of ["paused", "attention"] as const) {
      await db
        .update(chatEndpoints)
        .set({ status, updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
      await expect(
        sendEdit(
          status === "paused" ? 1_788_620_101 : 1_788_620_102,
          `Edited while ${status}`,
        ),
      ).resolves.toMatchObject({ ok: true });
    }

    const lifecycle = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle).toEqual([
      expect.objectContaining({
        providerEventId: `message_updated:telegram:${chatId}:${chatId}:51:1788620100`,
        state: "processed",
      }),
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("asks Telegram to retry an edit that races deferred original-message processing", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => Promise<void>> = [];
    const runtime = new FakeChatSdkRuntime();
    const { service, wakeup } = createService(
      runtime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-ordering-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram callbacks");
    const chatId = "77112235";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:61`,
        text: "Original deferred request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    const [originalDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    expect(originalDelivery).toMatchObject({ state: "received" });

    const sendEdit = () =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            update_id: 7_003,
            edited_message: {
              message_id: 61,
              edit_date: 1_788_620_200,
              chat: { id: Number(chatId), type: "private" },
              from: { id: Number(chatId), first_name: "Telegram User" },
              text: "Edit racing deferred processing",
            },
          }),
        }),
      );

    await expect(sendEdit()).rejects.toThrow(
      "Original chat message is still being durably processed",
    );
    await service.processPendingDeliveries(25, originalDelivery.id);
    await expect(sendEdit()).resolves.toMatchObject({ ok: true });

    const lifecycle = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(lifecycle).toEqual([
      expect.objectContaining({ state: "processed", attempts: 1 }),
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("records verified Telegram edited_message updates against the existing DM task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112233";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:41`,
        text: "Original Telegram request",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id, "owner-user");

    const editPayload = {
      update_id: 7001,
      edited_message: {
        message_id: 41,
        edit_date: 1_788_620_000,
        chat: { id: Number(chatId), type: "private" },
        from: { id: Number(chatId), first_name: "Telegram User" },
        text: "Corrected Telegram request",
      },
    };
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: {
        ...makeMessage({
          id: `${chatId}:41`,
          text: "Corrected Telegram request",
          userId: chatId,
        }),
        raw: editPayload.edited_message,
      } as Message,
      trigger: "direct_message",
    });
    const sendEdit = () =>
      service.handleWebhook(
        endpoint.publicId,
        "telegram",
        new Request("https://paperclip.example/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editPayload),
        }),
      );
    await Promise.all(Array.from({ length: 12 }, sendEdit));

    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId));
    expect(
      comments.filter((comment) =>
        comment.body.startsWith("An external message was edited:"),
      ),
    ).toEqual([
      expect.objectContaining({
        body: "An external message was edited:\n\nCorrected Telegram request",
      }),
    ]);
    const updateDeliveries = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.eventKind, "message_updated"),
        ),
      );
    expect(updateDeliveries).toEqual([
      expect.objectContaining({
        providerEventId: `message_updated:telegram:${chatId}:${chatId}:41:1788620000`,
        state: "processed",
      }),
    ]);
    const [originalDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `telegram:${chatId}:${chatId}:41`),
        ),
      );
    expect(originalDelivery.normalizedEvent.deduplication).toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("coalesces one Telegram run into one provider message", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112236";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:71`,
        text: "Produce one quiet Telegram response",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id, "owner-user");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    if (!conversation) throw new Error("Expected Telegram conversation");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.assignedAgentId,
      status: "running",
      contextSnapshot: await chatWakeContext({
        endpointId: endpoint.id,
        issueId: conversation.issueId,
        provider: "telegram",
        providerMessageId: `${chatId}:71`,
      }),
    });
    for (const progressState of ["queued", "working"] as const) {
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        conversationId: conversation.id,
        issueId: conversation.issueId,
        idempotencyKey: `run:${runId}:${progressState}:${endpoint.id}`,
        payload: {
          text:
            progressState === "queued" ? "Maya is queued." : "Maya is working…",
          progressState,
        },
        state: "pending",
      });
      await service.processPendingPublications();
    }
    await issueService(db).addComment(
      conversation.issueId,
      "Final Telegram result",
      { agentId: fixture.assignedAgentId, runId },
      { authorType: "agent" },
    );
    await service.processPendingPublications();

    const providerRuntime = runtime.endpoints.get(endpoint.id);
    expect(providerRuntime?.posts).toEqual([
      { threadId: dm.thread.id, text: "Maya is queued." },
    ]);
    expect(providerRuntime?.edits).toEqual([
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Maya is working…",
      },
      {
        threadId: dm.thread.id,
        messageId: "outbound-2",
        text: "Final Telegram result",
      },
    ]);
  });

  it("audits Telegram reactions idempotently without comments or runs", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture);
    const chatId = "77112237";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram direct message",
    });
    const original = makeMessage({
      id: `${chatId}:81`,
      text: "Observe Telegram reactions",
      userId: chatId,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: original,
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id, "owner-user");
    if (!callbacks.onReaction)
      throw new Error("Telegram reaction callback was not registered");
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const commentCount = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))
      .then((rows) => rows.length);
    const emoji = {
      name: "thumbs_up",
      toJSON: () => "👍",
      toString: () => "👍",
    };
    const reaction = (added: boolean, updateId: number) => ({
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { update_id: updateId },
        rawEmoji: "👍",
        thread: dm.thread,
        threadId: dm.thread.id,
        user: original.author,
      },
    });
    await callbacks.onReaction(reaction(true, 8_001));
    await callbacks.onReaction(reaction(true, 8_001));
    await callbacks.onReaction(reaction(false, 8_002));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(2);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_removed",
    ]);
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length),
    ).toBe(commentCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, fixture.companyId))
        .then((rows) => rows.length),
    ).toBe(runCount);
  });

  it("audits reactions on linked messages without treating them as task instructions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredSlackEndpoint(fixture);
    const channel = makeThread({
      channelId: "C-REACTIONS",
      id: "slack:C-REACTIONS:7100.1",
      name: "reactions",
    });
    const original = makeMessage({
      id: "7100.1",
      text: "@maya observe reactions",
      mentioned: true,
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      thread: channel.thread,
      message: original,
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");
    if (!callbacks.onReaction)
      throw new Error("Slack reaction callback was not registered");

    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    const commentCountBefore = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) => rows.length);
    const wakeupCountBefore = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbs_up",
      toJSON: () => ":thumbs_up:",
      toString: () => ":thumbs_up:",
    };
    const reaction = (added: boolean, eventTs: string) => ({
      endpointId: endpoint.id,
      provider: "slack" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { event_ts: eventTs },
        rawEmoji: "+1",
        thread: channel.thread,
        threadId: channel.thread.id,
        user: original.author,
      },
    });

    await callbacks.onReaction(reaction(true, "7101.1"));
    await callbacks.onReaction(reaction(true, "7101.1"));
    await callbacks.onReaction(reaction(false, "7102.1"));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(2);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_removed",
    ]);
    expect(reactions[0]?.normalizedEvent).toMatchObject({
      reaction: { emoji: "thumbs_up", rawEmoji: "+1" },
    });
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) => rows.length),
    ).toBe(commentCountBefore);
    expect(wakeup.mock.calls).toHaveLength(wakeupCountBefore);
    expect(
      (await service.listActivity(endpoint.id)).filter((item) =>
        item.summary.startsWith("reaction "),
      ),
    ).toHaveLength(2);
  });

  it("supplements Chat SDK with verified GitHub comment edit and delete lifecycle events", async () => {
    const fixture = await seedCompany();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const runtime = new FakeChatSdkRuntime();
    const { service, wakeup } = createService(runtime, (async (
      input: string | URL | Request,
    ) => {
      const url = String(input);
      if (url === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({
            id: 790,
            slug: "maya-paperclip-lifecycle",
            name: "Maya Paperclip",
            owner: { login: "paperclipai" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            events: [
              "github_app_authorization",
              "installation",
              "installation_repositories",
              "issue_comment",
              "pull_request_review_comment",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/app/installations?per_page=100") {
        return new Response(
          JSON.stringify([
            {
              id: 8642,
              account: { id: 1, login: "paperclipai" },
              suspended_at: null,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url === "https://api.github.com/app/installations/8642/access_tokens"
      ) {
        return new Response(JSON.stringify({ token: "installation-token" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        url ===
        "https://api.github.com/installation/repositories?per_page=100&page=1"
      ) {
        return new Response(JSON.stringify({ repositories: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.generateSetupSecret(endpoint.id, "owner-user");
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          appId: "123456",
          privateKey,
        },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected GitHub callbacks");
    const thread = makeThread({
      channelId: "paperclipai/chat-e2e",
      id: "github:paperclipai/chat-e2e:issue:42",
      name: "paperclipai/chat-e2e",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "77001",
        text: "@maya original GitHub request",
        mentioned: true,
      }),
      trigger: "mention",
    });
    for (const item of [
      {
        id: "github:paperclipai/chat-e2e:43",
        messageId: "77002",
      },
      {
        id: "github:paperclipai/chat-e2e:43:rc:88001",
        messageId: "88001",
      },
    ]) {
      const nativeThread = makeThread({
        channelId: "paperclipai/chat-e2e",
        id: item.id,
        name: "paperclipai/chat-e2e",
      });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: nativeThread.thread,
        message: makeMessage({
          id: item.messageId,
          text: "@maya original GitHub PR request",
          mentioned: true,
        }),
        trigger: "mention",
      });
    }
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id, "owner-user");

    const sendLifecycle = async (input: {
      action: "edited" | "deleted";
      event: "issue_comment" | "pull_request_review_comment";
      messageId: number;
      number: number;
      updatedAt: string;
      body?: string;
      inReplyToId?: number;
      issueIsPullRequest?: boolean;
    }) => {
      await service.handleWebhook(
        endpoint.publicId,
        "github",
        new Request(
          `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": input.event,
            },
            body: JSON.stringify({
              action: input.action,
              comment: {
                id: input.messageId,
                in_reply_to_id: input.inReplyToId,
                body: input.body ?? "@maya corrected GitHub request",
                updated_at: input.updatedAt,
              },
              issue: {
                number: input.number,
                pull_request: input.issueIsPullRequest ? {} : undefined,
              },
              pull_request: { number: input.number },
              repository: {
                name: "chat-e2e",
                owner: { login: "paperclipai" },
              },
            }),
          },
        ),
      );
    };

    for (const input of [
      {
        event: "issue_comment" as const,
        messageId: 77001,
        number: 42,
      },
      {
        event: "issue_comment" as const,
        issueIsPullRequest: true,
        messageId: 77002,
        number: 43,
      },
      {
        event: "pull_request_review_comment" as const,
        inReplyToId: 88001,
        messageId: 88001,
        number: 43,
      },
    ].entries()) {
      const [index, event] = input;
      await sendLifecycle({
        ...event,
        action: "edited",
        updatedAt: `2026-09-05T12:0${index}:00Z`,
      });
      await sendLifecycle({
        ...event,
        action: "deleted",
        updatedAt: `2026-09-05T12:1${index}:00Z`,
      });
    }
    const sameSecondEdit = {
      action: "edited" as const,
      body: "@maya corrected GitHub request again in the same second",
      event: "issue_comment" as const,
      messageId: 77001,
      number: 42,
      updatedAt: "2026-09-05T12:00:00Z",
    };
    await sendLifecycle(sameSecondEdit);
    await sendLifecycle(sameSecondEdit);
    await vi.waitFor(async () => {
      const lifecycle = await db
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id));
      expect(
        lifecycle.filter((row) =>
          ["message_updated", "message_deleted"].includes(row.eventKind),
        ),
      ).toHaveLength(7);
      expect(
        lifecycle.filter(
          (row) =>
            row.eventKind === "message_updated" &&
            row.providerEventId.includes(":77001:"),
        ),
      ).toHaveLength(2);
    });
    expect(wakeup).toHaveBeenCalledTimes(4);
    await service.shutdown();
  });
});
