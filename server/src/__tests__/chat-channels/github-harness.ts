// Shared GitHub endpoint, webhook, and pre-ingress fixture helpers.
import { githubChatManagementService } from "../../services/chat-github-management.js";
import { syncGitHubBotTools } from "../../services/chat-github-tools.js";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, it, vi } from "vitest";
import { chatActions, chatDeliveries, chatEndpoints, chatSdkState, issues } from "@paperclipai/db";
import { type ChatChannelServiceOptions, type ChatChannelService } from "../../services/chat-channels.js";
import type { CreateChatSdkEndpointRuntimeOptions } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { type TestDb, FakeEndpointRuntime, FakeChatSdkRuntime, makeThread, makeMessage } from "./providers.js";
import type { ChatChannelHarness } from "./harness.js";

export function createGitHubHarness(h: ChatChannelHarness) {
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatEndpointsById, createService, deliverMessage } = h;

  function githubWebhookVerificationResponse(
    service: ChatChannelService,
    publicId: string,
    webhookSecret: string,
    providerDeliveryId = `github-setup-ping-${randomUUID()}`,
  ) {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
    return service.handleWebhook(
      publicId,
      "github",
      new Request(
        `https://paperclip.example/api/chat-webhooks/${publicId}/github`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": providerDeliveryId,
            "x-github-event": "ping",
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body,
        },
      ),
    );
  }

  async function recordGitHubWebhookVerification(
    service: ChatChannelService,
    publicId: string,
    webhookSecret: string,
  ) {
    const providerDeliveryId = `github-setup-ping-${randomUUID()}`;
    const response = await githubWebhookVerificationResponse(
      service,
      publicId,
      webhookSecret,
      providerDeliveryId,
    );
    expect([200, 202]).toContain(response.status);
    const action = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatActions.endpointId))
      .where(
        and(
          eq(chatEndpoints.publicId, publicId),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${providerDeliveryId}`,
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (action) {
      await service.processPendingGitHubWebhookIngress(1, action.id);
    }
    await vi.waitFor(async () => {
      const setup = await db
        .select({ setup: chatEndpoints.setup })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.publicId, publicId))
        .then((rows) => rows[0]?.setup);
      expect(setup).toMatchObject({ webhookVerifiedAt: expect.any(String) });
    });
  }

  function signedGitHubWebhookRequest(input: {
    delivery: string;
    event: string;
    payload: unknown;
    webhookSecret: string;
    url?: string;
  }) {
    const body = JSON.stringify(input.payload);
    const signature = createHmac("sha256", input.webhookSecret)
      .update(body)
      .digest("hex");
    return new Request(input.url ?? "https://paperclip.example/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": input.event,
        "x-github-delivery": input.delivery,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
  }

  async function configuredGitHubEndpoint(
    fixture: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<
      Pick<
        ChatChannelServiceOptions,
        | "deferWebhookProcessing"
        | "githubWebhookAuthenticationBarrier"
        | "githubWebhookReplayBarrier"
        | "githubWebhookResponseBudgetMs"
        | "publicBaseUrl"
        | "webhookPublicBaseUrl"
        | "scheduleDeferredWork"
        | "setupSecretActivityLogger"
        | "setupSecretCredentialPersistBarrier"
        | "receiptReactionTransportBarrier"
        | "storage"
      >
    > & { wakeup?: ChatChannelServiceOptions["heartbeat"]["wakeup"] } = {},
    useVerifiedAppId = false,
    registerWithManifest = false,
    connectExistingApp = false,
    interruptAppVault = false,
  ) {
    let setupComplete = false;
    const deferredSchedule = overrides.scheduleDeferredWork;
    let installationId = 2468;
    let additionalInstallationIds: number[] = [];
    let installationAvailable = true;
    let repositories = [
      {
        id: 97531,
        full_name: "paperclipai/paperclip",
        html_url: "https://github.com/paperclipai/paperclip",
        owner: { id: 1357, login: "paperclipai" },
        private: false,
      },
    ];
    let appPermissions: Record<string, string> = {
      contents: "read",
      checks: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    };
    let installationPermissions: Record<string, string> = {
      contents: "read",
      checks: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    };
    let appEvents = [
      "pull_request",
      "github_app_authorization",
      "installation",
      "installation_repositories",
      "issue_comment",
      "pull_request_review_comment",
    ];
    const webhookSyncRequests: Array<Record<string, unknown>> = [];
    let webhookSyncResponse: (() => Promise<Response>) | null = null;
    let supplementalProviderFetch:
      | ((
          input: string | URL | Request,
          init?: RequestInit,
        ) => Promise<Response | undefined>)
      | null = null;
    const appRegistrationId = Number.parseInt(
      fixture.companyId.replaceAll("-", "").slice(0, 8),
      16,
    );
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const responseComments = new Map<number, { id: number; body: string; html_url: string; user: { login: string }; thread: string }>();
    const responseWrites: Array<{ method: string; id: number; body: string }> = [];
    let nextResponseId = 800000;
    const providerFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const supplemental = await supplementalProviderFetch?.(input, init);
      if (supplemental) return supplemental;
      const list = /\/repos\/paperclipai\/paperclip\/(issues|pulls)\/([1-9][0-9]*)\/comments(?:\?.*)?$/.exec(url);
      const reply = /\/repos\/paperclipai\/paperclip\/pulls\/([1-9][0-9]*)\/comments\/[1-9][0-9]*\/replies$/.exec(url);
      const item = /\/repos\/paperclipai\/paperclip\/(issues|pulls)\/comments\/([1-9][0-9]*)$/.exec(url);
      if (item) {
        const comment = responseComments.get(Number(item[2]));
        if (!comment) return Response.json({ message: "Not Found" }, { status: 404 });
        if (init?.method === "PATCH") {
          comment.body = JSON.parse(String(init.body)).body;
          responseWrites.push({ method: "PATCH", id: comment.id, body: comment.body });
        }
        return Response.json(comment);
      }
      if ((list || reply) && init?.method === "POST") {
        const id = ++nextResponseId;
        const thread = list ? `${list[1]}:${list[2]}` : `pulls:${reply![1]}`;
        const body = JSON.parse(String(init.body)).body;
        const comment = { id, body, thread, html_url: `https://github.com/paperclipai/paperclip/issues/${list?.[2] ?? reply![1]}#issuecomment-${id}`,
          user: { login: `maya-${fixture.companyId.slice(0, 8)}[bot]` } };
        responseComments.set(id, comment);
        responseWrites.push({ method: "POST", id, body });
        return Response.json(comment, { status: 201 });
      }
      if (list && (!init?.method || init.method === "GET")) return Response.json([...responseComments.values()].filter(row => row.thread === `${list[1]}:${list[2]}`));
      if (url === "https://api.github.com/app/hook/config") {
        expect(init?.method).toBe("PATCH");
        const config = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        webhookSyncRequests.push(config);
        if (webhookSyncResponse) return webhookSyncResponse();
        return new Response(
          JSON.stringify({
            url: config.url,
            content_type: config.content_type,
            insecure_ssl: config.insecure_ssl,
          }),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({
            id: appRegistrationId,
            slug: `maya-${fixture.companyId.slice(0, 8)}`,
            name: "Maya Paperclip",
            owner: { login: "paperclipai" },
            permissions: appPermissions,
            events: appEvents,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `https://api.github.com/app/installations/${installationId}`)
        return Response.json({ permissions: installationPermissions, suspended_at: null });
      if (url === "https://api.github.com/app/installations?per_page=100") {
        return new Response(
          JSON.stringify(
            installationAvailable
              ? [
                  {
                    id: installationId,
                    account: {
                      id: 1357,
                      login: "paperclipai",
                      type: "Organization",
                    },
                    permissions: installationPermissions,
                    suspended_at: null,
                  },
                  ...additionalInstallationIds.map((id) => ({
                    id,
                    account: {
                      id: id + 10_000,
                      login: `additional-${id}`,
                      type: "Organization",
                    },
                    permissions: installationPermissions,
                    suspended_at: null,
                  })),
                ]
              : [],
          ),
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
        return new Response(JSON.stringify({ repositories }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const context = createService(
      new FakeChatSdkRuntime(),
      providerFetch,
      deferredSchedule
        ? {
            ...overrides,
            scheduleDeferredWork: (task) => {
              if (setupComplete) deferredSchedule(task);
              else setImmediate(task);
            },
          }
        : overrides,
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
    const { webhookSecret } = await context.service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      context.service,
      endpoint.publicId,
      webhookSecret,
    );
    if (registerWithManifest)
      await context.service.startGitHubRegistration(endpoint.id, "owner-user", "Maya");
    if (connectExistingApp) {
      const credentials = { appId: String(appRegistrationId), privateKey, webhookSecret };
      if (interruptAppVault) {
        // Fail the real vault write after App identity has been durably claimed.
        await db.execute(sql.raw("CREATE FUNCTION github_wizard_fail_vault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated App vault failure'; END $$"));
        await db.execute(sql.raw("CREATE TRIGGER github_wizard_fail_vault BEFORE INSERT ON company_secrets FOR EACH ROW WHEN (lower(NEW.key) LIKE '%privatekey%') EXECUTE FUNCTION github_wizard_fail_vault()"));
        try {
          await expect(context.service.storeGitHubApp(endpoint.id, "owner-user", credentials)).rejects.toThrow();
          expect(await context.service.githubWizard.advance(endpoint.id, "owner-user")).toMatchObject({ state: "recovery" });
          expect((await context.service.get(endpoint.id)).setup.github).toMatchObject({ initialSetupPending: true, initialRepositoryImportPending: true });
          expect((await context.service.get(endpoint.id)).setup.github?.initialRepositoriesImported).not.toBe(true);
          expect(await context.service.listResources(endpoint.id)).toHaveLength(0);
          expect((await githubChatManagementService(db, providerFetch).configuration(endpoint.id, "owner-user")).revision).toBe(0);
        } finally {
          await db.execute(sql.raw("DROP TRIGGER github_wizard_fail_vault ON company_secrets"));
          await db.execute(sql.raw("DROP FUNCTION github_wizard_fail_vault()"));
        }
      }
      await context.service.storeGitHubApp(endpoint.id, "owner-user", credentials);
    }
    await context.service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          appId: useVerifiedAppId ? String(appRegistrationId) : "123456",
          privateKey,
        },
      },
      "owner-user",
    );
    if (!useVerifiedAppId) {
      const [configured] = await readChatEndpointsById(endpoint.id);
      // Legacy transport fixtures already have explicit tool authority. Do not
      // save a review configuration: that would switch their admission model.
      await db.transaction((tx) => syncGitHubBotTools(tx, configured!, "owner-user", true));
    }
    const resources = await context.service.listResources(endpoint.id);
    if (!registerWithManifest && !connectExistingApp)
      await context.service.replaceResources(endpoint.id, [
        { id: resources[0]!.id, enabled: true },
      ]);
    setupComplete = true;
    const callbacks = context.runtime.configurations.get(
      endpoint.id,
    )?.callbacks;
    if (!callbacks)
      throw new Error("Fake runtime did not receive GitHub callbacks");
    return {
      ...context,
      endpoint,
      callbacks,
      webhookSecret,
      providerFetch,
      responseComments,
      responseWrites,
      webhookSyncRequests,
      privateKey,
      setSupplementalProviderFetch(value: typeof supplementalProviderFetch) {
        supplementalProviderFetch = value;
      },
      setWebhookSyncResponse(value: (() => Promise<Response>) | null) {
        webhookSyncResponse = value;
      },
      setInstallationId(value: number) {
        installationId = value;
      },
      setAdditionalInstallationIds(value: number[]) {
        additionalInstallationIds = value;
      },
      setInstallationAvailable(value: boolean) {
        installationAvailable = value;
      },
      setRepositories(
        value: Array<{
          id: number;
          full_name: string;
          html_url: string;
          owner: { id: number; login: string };
          private: boolean;
        }>,
      ) {
        repositories = value;
      },
      setAppAccess(input: {
        permissions?: Record<string, string>;
        events?: string[];
      }) {
        if (input.permissions) appPermissions = input.permissions;
        if (input.events) appEvents = input.events;
      },
      setInstallationAccess(permissions: Record<string, string>) {
        installationPermissions = permissions;
      },
    };
  }

  async function deliverLegacyGitHubReceipt(
    input: Parameters<typeof deliverMessage>[0], service: ChatChannelService,
  ) {
    await deliverMessage(input);
    const [delivery] = await db.select().from(chatDeliveries).where(and(
      eq(chatDeliveries.endpointId, input.endpointId),
      eq(chatDeliveries.providerEventId, `${input.thread.id}:${input.message.id}`),
    ));
    if (!delivery) throw new Error("Expected admitted legacy GitHub delivery");
    const fence = delivery.normalizedEvent.runtimeContext as { generation: number; credentialFingerprint: string };
    const [action] = await db.insert(chatActions).values({ companyId: delivery.companyId,
      endpointId: input.endpointId, deliveryId: delivery.id, kind: "receipt_reaction",
      providerActionId: `receipt_reaction:${delivery.id}`, status: "received",
      payload: { version: 1, operation: "add", threadId: input.thread.id, messageId: input.message.id,
        reaction: "eyes", runtimeGeneration: fence.generation, credentialFingerprint: fence.credentialFingerprint },
    }).returning();
    await service.processPendingReceiptReactions(1, action.id);
  }

  function attachFakeGitHubIssueCommentWebhook(input: {
    botUsername: string;
    callbacks: CreateChatSdkEndpointRuntimeOptions["callbacks"];
    endpointId: string;
    runtime: FakeEndpointRuntime;
  }) {
    input.runtime.webhookHook = async (request) => {
      const payload = (await request.clone().json()) as {
        action?: unknown;
        comment?: {
          body?: unknown;
          created_at?: unknown;
          id?: unknown;
          updated_at?: unknown;
          user?: { id?: unknown; login?: unknown };
        };
        issue?: { number?: unknown; pull_request?: unknown };
        repository?: {
          full_name?: unknown;
          name?: unknown;
          owner?: { login?: unknown };
        };
        sender?: { id?: unknown; login?: unknown };
      };
      if (payload.action !== "created") return;
      const fullName =
        typeof payload.repository?.full_name === "string"
          ? payload.repository.full_name
          : typeof payload.repository?.owner?.login === "string" &&
              typeof payload.repository.name === "string"
            ? `${payload.repository.owner.login}/${payload.repository.name}`
            : null;
      const issueNumber = payload.issue?.number;
      const messageId = payload.comment?.id;
      const text = payload.comment?.body;
      if (
        !fullName ||
        typeof issueNumber !== "number" ||
        (typeof messageId !== "number" && typeof messageId !== "string") ||
        typeof text !== "string"
      ) {
        return;
      }
      const mentionNames = new Set([
        input.botUsername,
        input.botUsername.replace(/\[bot\]$/i, ""),
      ]);
      const mentioned = [...mentionNames].some((identity) =>
        new RegExp(
          `(?<!\\w)@${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
          "i",
        ).test(text),
      );
      const thread = makeThread({
        channelId: fullName,
        id: payload.issue?.pull_request
          ? `github:${fullName}:${issueNumber}`
          : `github:${fullName}:issue:${issueNumber}`,
        name: fullName,
      }).thread;
      const message = makeMessage({
        id: String(messageId),
        raw: payload,
        text,
        mentioned,
        userId: String(payload.sender?.id ?? payload.comment?.user?.id ?? "42"),
        userName: String(
          payload.sender?.login ?? payload.comment?.user?.login ?? "octocat",
        ),
      });
      const createdAt = payload.comment?.created_at;
      if (typeof createdAt === "string")
        message.metadata.dateSent = new Date(createdAt);
      await deliverMessage({
        callbacks: input.callbacks,
        endpointId: input.endpointId,
        message,
        provider: "github",
        thread,
        trigger: mentioned ? "mention" : "unaddressed_message",
      });
    };
  }

  async function githubPreIngressRecoveryFixture(
    event: "issue_comment" | "pull_request_review_comment" = "issue_comment",
    replayBarrier?: ChatChannelServiceOptions["githubWebhookReplayBarrier"],
  ) {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const configured = await configuredGitHubEndpoint(
      fixture,
      {
        deferWebhookProcessing: true,
        githubWebhookReplayBarrier: replayBarrier,
        scheduleDeferredWork: (task) => deferred.push(task),
      },
      true,
    );
    const { service, endpoint, runtime, callbacks } = configured;
    // Setup admission is covered separately. Recovery is intentionally only
    // eligible for an active endpoint with an explicitly enabled repository.
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const current = await service.get(endpoint.id);
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    attachFakeGitHubIssueCommentWebhook({
      botUsername: current.botUsername!,
      callbacks,
      endpointId: endpoint.id,
      runtime: providerRuntime,
    });
    const guid = randomUUID();
    const deliveryId = "9007199254740993";
    const webhookUrl = `https://paperclip.example/api/chat-webhooks/${endpoint.publicId}/github`;
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const body = `@${current.botUsername} recover the original request ${randomUUID()}`;
    const comment = {
      id: 9191,
      body,
      created_at: createdAt,
      updated_at: createdAt,
      user: { id: 42, login: "octocat", type: "User" },
      ...(event === "issue_comment"
        ? {
            issue_url:
              "https://api.github.com/repos/paperclipai/paperclip/issues/91",
          }
        : {
            pull_request_url:
              "https://api.github.com/repos/paperclipai/paperclip/pulls/91",
          }),
    };
    const payload = {
      action: "created",
      installation: { id: 2468 },
      repository: {
        id: 97531,
        full_name: "paperclipai/paperclip",
        name: "paperclip",
        owner: { id: 1357, login: "paperclipai" },
      },
      ...(event === "issue_comment"
        ? { issue: { id: 9190, number: 91 } }
        : { pull_request: { id: 9190, number: 91 } }),
      comment,
      sender: { id: 42, login: "octocat", type: "User" },
    };
    const original = {
      id: deliveryId,
      guid,
      delivered_at: createdAt,
      redelivery: false,
      status_code: 502 as number | null,
      event,
      action: "created",
      installation_id: 2468,
      repository_id: 97531,
      throttled_at: null as string | null,
    };
    let deliveries = [original];
    const extraDetails = new Map<
      string,
      { summary: typeof original; payload: unknown }
    >();
    let historyHasMore = false;
    let historyPage = 0;
    let canonicalComment = { ...comment };
    let beforeList: (() => Promise<void>) | undefined;
    let beforePost: (() => Promise<void>) | undefined;
    const requests: Array<{ method: string; pathname: string }> = [];
    const posts: string[] = [];
    const commentPath = `/repos/paperclipai/paperclip/${event === "issue_comment" ? "issues" : "pulls"}/comments/9191`;
    // Emit the actual unsafe JSON numeric literal, not a string-only mock.
    const json = (value: unknown) =>
      new Response(
        JSON.stringify(value).replaceAll(`"${deliveryId}"`, deliveryId),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    configured.setSupplementalProviderFetch(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const isRecovery =
        url.pathname.startsWith("/app/hook/") ||
        url.pathname === commentPath ||
        url.pathname === "/installation/token";
      if (!isRecovery) return undefined;
      requests.push({ method, pathname: url.pathname });
      if (url.pathname === "/app/hook/config" && method === "GET") {
        return json({
          url: webhookUrl,
          content_type: "json",
          insecure_ssl: "0",
        });
      }
      if (url.pathname === "/app/hook/deliveries") {
        await beforeList?.();
        const response = json(deliveries);
        if (historyHasMore)
          response.headers.set(
            "link",
            `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=page${++historyPage}>; rel="next"`,
          );
        return response;
      }
      if (url.pathname === `/app/hook/deliveries/${deliveryId}`) {
        return json({
          ...original,
          url: webhookUrl,
          request: {
            headers: { authorization: "private-provider-header-canary" },
            payload,
          },
          response: { payload: "private-proxy-body-canary" },
        });
      }
      const extra = extraDetails.get(
        url.pathname.replace(/^\/app\/hook\/deliveries\//, ""),
      );
      if (extra)
        return json({
          ...extra.summary,
          url: webhookUrl,
          request: { payload: extra.payload },
        });
      if (
        url.pathname === `/app/hook/deliveries/${deliveryId}/attempts` &&
        method === "POST"
      ) {
        posts.push(url.pathname);
        await beforePost?.();
        return new Response(null, { status: 202 });
      }
      if (url.pathname === commentPath) return json(canonicalComment);
      if (url.pathname === "/installation/token" && method === "DELETE")
        return new Response(null, { status: 204 });
      return undefined;
    });
    const checkpoint = () =>
      db
        .select()
        .from(chatSdkState)
        .where(
          and(
            eq(chatSdkState.endpointId, endpoint.id),
            eq(chatSdkState.stateKey, "paperclip:github-webhook-recovery:v1"),
          ),
        )
        .then((rows) => rows[0]!);
    const makeScanDue = async (includeOriginal = true) => {
      const state = await checkpoint();
      await db
        .update(chatSdkState)
        .set({
          value: {
            ...(state.value as Record<string, unknown>),
            ...(includeOriginal
              ? { floor: new Date(Date.now() - 120_000).toISOString() }
              : {}),
            nextScanAt: new Date(Date.now() - 1_000).toISOString(),
          },
        })
        .where(eq(chatSdkState.id, state.id));
    };
    const ingress = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, `github_webhook_ingress:${guid}`),
          ),
        )
        .then((rows) => rows[0]);
    const receipt = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, `github_webhook_recovery:${guid}`),
          ),
        )
        .then((rows) => rows[0]);
    const callback = (
      webhookSecret = configured.webhookSecret,
      incomingPayload: unknown = payload,
    ) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: guid,
          event,
          payload: incomingPayload,
          webhookSecret,
          url: webhookUrl,
        }),
      );
    const initializedAt = Date.now();
    await service.processFailedGitHubWebhookDeliveries(5, endpoint.id);
    expect(requests).toEqual([]);
    const initial = (await checkpoint()).value as Record<string, unknown>;
    expect(initial).toMatchObject({
      appId: current.botExternalId,
      webhookUrl,
      generation: expect.any(Number),
    });
    expect(Date.parse(String(initial.floor))).toBeGreaterThanOrEqual(
      initializedAt,
    );
    expect(Date.parse(String(initial.nextScanAt))).toBeGreaterThanOrEqual(
      initializedAt + 60_000,
    );
    return {
      ...configured,
      fixture,
      body,
      guid,
      deliveryId,
      original,
      payload,
      providerRuntime,
      requests,
      posts,
      checkpoint,
      makeScanDue,
      ingress,
      receipt,
      callback,
      deferred,
      setDeliveries(value: typeof deliveries) {
        deliveries = value;
      },
      setDetail(summary: typeof original, incomingPayload: unknown) {
        extraDetails.set(summary.id, { summary, payload: incomingPayload });
      },
      setHistoryHasMore(value: boolean) {
        historyHasMore = value;
      },
      setCanonicalComment(value: Partial<typeof comment>) {
        canonicalComment = { ...canonicalComment, ...value };
      },
      setBeforeList(value: typeof beforeList) {
        beforeList = value;
      },
      setBeforePost(value: typeof beforePost) {
        beforePost = value;
      },
    };
  }

  return { githubWebhookVerificationResponse, recordGitHubWebhookVerification, signedGitHubWebhookRequest, configuredGitHubEndpoint, deliverLegacyGitHubReceipt, attachFakeGitHubIssueCommentWebhook, githubPreIngressRecoveryFixture };
}

export type GitHubHarness = ReturnType<typeof createGitHubHarness>;
