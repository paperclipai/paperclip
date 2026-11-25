import { chatHistoryActionBlocks } from "../helpers/chat-history-proof.js";
import { notifyChatEndpointConfiguration } from "../../services/chat-channels/configuration-work-notifications.js";
import { conflict } from "../../errors.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import type { Db } from "@paperclipai/db";
import { registerChatActionWork } from "../../services/chat-action-work.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatSdkState, companySecrets, companies, companyMemberships, issueComments, issues, toolConnections } from "@paperclipai/db";
import type { InternalSetupState } from "../../services/chat-channels/runtime-types.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { logActivity } from "../../services/activity-log.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, makeThread, makeMessage, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";

describeEmbeddedPostgres("chat channels: github setup and access", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatActionsById, readChatPublicationsById, readToolConnectionsById, readIssuesByCompanyId, createService, retirePublicationFixture, qualifySetupRoundTrip, deliverMessage } = h;
  const { githubWebhookVerificationResponse, recordGitHubWebhookVerification, signedGitHubWebhookRequest, configuredGitHubEndpoint, attachFakeGitHubIssueCommentWebhook, githubPreIngressRecoveryFixture } = gh;

  describe("GitHub repository pagination and bulk access", () => {
    it("pages and searches 1000 repositories while toggle all changes unloaded rows atomically", async () => {
      const fixture = await seedCompany();
      const context = createService();
      const endpoint = await context.service.create(fixture.companyId,
        { provider: "github", assignedAgentId: fixture.assignedAgentId }, "owner-user");
      const foreign = await seedCompany();
      const other = await context.service.create(foreign.companyId,
        { provider: "github", assignedAgentId: foreign.assignedAgentId }, "owner-user");
      const all = await db.insert(chatEndpointResources).values(Array.from({ length: 1000 }, (_, index) => ({
        companyId: fixture.companyId, endpointId: endpoint.id, type: "repository",
        providerResourceId: `acme/repo-${index}`, label: `Acme/Repo-${String(index).padStart(4, "0")}`,
        enabled: true, availability: "available" as const,
      }))).returning();
      const [unavailable, channel, unrelated] = await db.insert(chatEndpointResources).values([
        { companyId: fixture.companyId, endpointId: endpoint.id, type: "repository", providerResourceId: "unavailable", label: "Unavailable", enabled: true, availability: "unavailable" },
        { companyId: fixture.companyId, endpointId: endpoint.id, type: "channel", providerResourceId: "channel", label: "Channel", enabled: true, availability: "available" },
        { companyId: foreign.companyId, endpointId: other.id, type: "repository", providerResourceId: "foreign", label: "Foreign", enabled: true, availability: "available" },
      ]).returning();
      const app = routesApp(db, fixture.companyId, context.service);
      const path = `/api/chat-endpoints/${endpoint.id}/github/repositories`;
      const first = await request(app).get(path).expect(200);
      expect(first.body).toMatchObject({ nextOffset: 20, totalCount: 1001, enabledCount: 1001, availableCount: 1000 });
      expect(first.body.items).toHaveLength(20);
      const second = await request(app).get(path).query({ offset: 20 }).expect(200);
      expect(second.body.items).toHaveLength(20);
      expect(second.body.items.some((row: { id: string }) => first.body.items.some((initial: { id: string }) => initial.id === row.id))).toBe(false);
      const search = await request(app).get(path).query({ search: "repo-0999" }).expect(200);
      expect(search.body.items.map((row: { label: string }) => row.label)).toEqual(["Acme/Repo-0999"]);
      expect(search.body.totalCount).toBe(1001);
      expect((await request(app).get(path).query({ search: "%" }).expect(200)).body.items).toEqual([]);
      await request(app).get(path).query({ limit: 1000 }).expect(400);
      await request(app).get(path).query({ offset: -1 }).expect(400);
      await request(app).put(`${path}/access`).send({ enabled: false, search: "repo-0999" }).expect(400);
      await request(app).put(`${path}/access`).send({ enabled: false }).expect(200);
      const afterOff = await context.service.listGitHubRepositories(endpoint.id, { limit: 20, offset: 0, search: "" });
      expect(afterOff.enabledCount).toBe(0);
      expect((await db.select().from(chatEndpointResources).where(inArray(chatEndpointResources.id, [channel.id, unrelated.id]))).every((row) => row.enabled)).toBe(true);
      const [last] = await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, all[999].id));
      expect(last.enabled).toBe(false);
      await request(app).put(`${path}/access`).send({ enabled: true }).expect(200);
      expect((await context.service.listGitHubRepositories(endpoint.id, { limit: 20, offset: 0, search: "" })).enabledCount).toBe(1000);
      expect((await db.select().from(chatEndpointResources).where(eq(chatEndpointResources.id, unavailable.id)))[0].enabled).toBe(false);
      const saved = await context.service.get(endpoint.id);
      expect(saved.setup.github?.repositorySelectionSaved).toBe(true);
      const audits = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.action, "chat_endpoint.resources_updated"))).orderBy(asc(activityLog.createdAt));
      expect(audits).toHaveLength(2);
      expect(audits.every((audit) => audit.actorId === "owner-user")).toBe(true);
      expect((audits[0].details!.changes as unknown[])).toHaveLength(1001);
      expect((audits[1].details!.changes as unknown[])).toHaveLength(1000);
      const crossCompany = routesApp(db, foreign.companyId, context.service);
      expect((await request(crossCompany).get(path)).status).toBeOneOf([403, 404]);
      expect((await request(crossCompany).put(`${path}/access`).send({ enabled: false })).status).toBeOneOf([403, 404]);
      expect(context.wakeup).not.toHaveBeenCalled();
      await context.service.shutdown();
    });
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
        .put(`/api/chat-endpoints/${endpoint.id}/github/repositories/access`)
        .send({ enabled: false }),
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
      request(memberApp)
        .post(
          `/api/chat-endpoints/${endpoint.id}/actions/${randomUUID()}/resolve`,
        )
        .send({ action: "cancel" }),
    ];
    for (const mutation of deniedMutations) {
      const response = await mutation.expect(403);
      expect(response.body.error).toContain(
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

  it("globally fences GitHub App identity across owner transfers without leaking another company", async () => {
    const firstCompany = await seedCompany();
    const secondCompany = await seedCompany();
    const appRegistrationId = 987654321;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let inventoryRequestCount = 0;
    let releaseInventory!: () => void;
    const bothInventoriesStarted = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const providerFetch = (owner: string, installationId: number) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://api.github.com/app") {
          return new Response(
            JSON.stringify({
              id: appRegistrationId,
              slug: "shared-paperclip-app",
              name: "Shared Paperclip App",
              owner: { login: owner },
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
          inventoryRequestCount += 1;
          if (inventoryRequestCount === 2) releaseInventory();
          await bothInventoriesStarted;
          return new Response(
            JSON.stringify([
              {
                id: installationId,
                account: { id: installationId, login: owner },
                permissions: {
                  issues: "write",
                  metadata: "read",
                  pull_requests: "write",
                },
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
          return new Response(JSON.stringify({ repositories: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected provider request: ${url}`);
      }) as typeof globalThis.fetch;
    const first = createService(
      new FakeChatSdkRuntime(),
      providerFetch("original-owner", 8101),
    );
    const second = createService(
      new FakeChatSdkRuntime(),
      providerFetch("transferred-owner", 8102),
    );
    const firstEndpoint = await first.service.create(
      firstCompany.companyId,
      {
        provider: "github",
        assignedAgentId: firstCompany.assignedAgentId,
      },
      "owner-user",
    );
    const secondEndpoint = await second.service.create(
      secondCompany.companyId,
      {
        provider: "github",
        assignedAgentId: secondCompany.assignedAgentId,
      },
      "owner-user",
    );
    for (const [service, endpoint] of [
      [first.service, firstEndpoint],
      [second.service, secondEndpoint],
    ] as const) {
      const { webhookSecret } = await service.generateSetupSecret(
        endpoint.id,
        "owner-user",
      );
      await recordGitHubWebhookVerification(
        service,
        endpoint.publicId,
        webhookSecret,
      );
    }
    const endpoints = [firstEndpoint, secondEndpoint] as const;
    const services = [first.service, second.service] as const;
    const outcomes = await Promise.allSettled(
      services.map((service, index) =>
        service.configure(
          endpoints[index]!.id,
          {
            action: "configure",
            credentials: { appId: "123456", privateKey },
          },
          "owner-user",
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejectedIndex = outcomes.findIndex(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    const conflict = (outcomes[rejectedIndex] as PromiseRejectedResult).reason;
    expect(conflict).toMatchObject({
      status: 409,
      details: {
        code: "chat_bot_identity_in_use",
      },
    });
    expect(conflict).not.toMatchObject({
      details: {
        endpointId: expect.any(String),
        assignedAgentId: expect.any(String),
      },
    });
    await expect(
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoints[rejectedIndex]!.connectionId))
        .then(
          (rows) => rows[0]?.refs.map((ref) => ref.configPath).sort() ?? [],
        ),
    ).resolves.toEqual(["credentials.webhookSecret"]);
    await first.service.shutdown();
    await second.service.shutdown();
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
    let appRegistrationId = 789;
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
              id: appRegistrationId,
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
                permissions: {
                  issues: "write",
                  metadata: "read",
                  pull_requests: "write",
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
      { scheduleDeferredWork: () => undefined },
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
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "configure",
          credentials: { appId, privateKey },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_webhook_not_verified" },
    });
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
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
      botExternalId: "789",
      botUsername: "maya-paperclip[bot]",
      setup: { step: "test", webhookVerifiedAt: expect.any(String) },
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
    const githubConfig = runtime.configurations.get(endpoint.id)?.providerConfig;
    expect(
      githubConfig?.provider ===
        "github" &&
        githubConfig.credentials
          .botUserId,
    ).toBeUndefined();
    appRegistrationId = 790;
    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { appId, privateKey },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });
    appRegistrationId = 789;
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
      readChatConversationsByEndpointId(endpoint.id),
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
      signedGitHubWebhookRequest({
        delivery: "github-repository-removed",
        event: "installation_repositories",
        payload: {
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
        },
        webhookSecret: generatedWebhookSecret,
      }),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
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
      signedGitHubWebhookRequest({
        delivery: "github-installation-suspended",
        event: "installation",
        payload: {
          action: "suspend",
          installation: { id: 2468 },
        },
        webhookSecret: generatedWebhookSecret,
      }),
    );
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
  });

  it("admits only an addressed raw GitHub comment as the first setup repository", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const [resource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: resource!.id, enabled: false },
    ]);
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    const currentEndpoint = await service.get(endpoint.id);
    if (!endpointRuntime || !currentEndpoint.botUsername)
      throw new Error("Expected configured GitHub runtime identity");
    attachFakeGitHubIssueCommentWebhook({
      botUsername: currentEndpoint.botUsername,
      callbacks,
      endpointId: endpoint.id,
      runtime: endpointRuntime,
    });
    const payload = (body: string, commentId: number, issueNumber: number) => ({
      action: "created",
      installation: { id: 2468 },
      repository: {
        id: 97531,
        full_name: "paperclipai/paperclip",
        name: "paperclip",
        owner: { id: 1357, login: "paperclipai" },
      },
      issue: { number: issueNumber },
      comment: {
        id: commentId,
        body,
        created_at: "2026-09-06T12:00:00Z",
        updated_at: "2026-09-06T12:00:00Z",
        user: { id: 42, login: "octocat" },
      },
      sender: { id: 42, login: "octocat" },
    });
    const unaddressedMarker = `private-unaddressed-${randomUUID()}`;
    const ignored = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-unaddressed-first-setup",
        event: "issue_comment",
        payload: payload(unaddressedMarker, 17001, 17),
        webhookSecret,
      }),
    );
    expect(ignored.status).toBe(200);
    expect(endpointRuntime.webhookRequest).toBeNull();
    await expect(
      db.execute(
        sql`select id from chat_actions where endpoint_id = ${endpoint.id} and payload::text like ${`%${unaddressedMarker}%`}`,
      ),
    ).resolves.toHaveLength(0);

    const botMention = currentEndpoint.botUsername.replace(/\[bot\]$/i, "");
    const accepted = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-addressed-first-setup",
        event: "issue_comment",
        payload: payload(`@${botMention} triage issue 18`, 18001, 18),
        webhookSecret,
      }),
    );
    expect(accepted.status).toBe(202);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        enabled: true,
      }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
  });

  it("retries transient GitHub endpoint lock contention before accepting a wake", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredGitHubEndpoint(fixture);
    const current = await service.get(endpoint.id);
    const { thread, subscribe } = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:903",
    });
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let transaction: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    subscribe.mockImplementationOnce(async () => {
      transaction = db.transaction(async (tx) => {
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("no key update");
        acquired();
        await held;
      });
      await locked;
      timer = setTimeout(release, 250);
      return undefined;
    });
    try {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread,
        trigger: "mention",
        message: makeMessage({
          id: "github-contended-admission",
          userId: "42",
          userName: "octocat",
          mentioned: true,
          text: `@${current.botUsername} review after concurrent ingress`,
        }),
      });
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await transaction;
    }
    expect(subscribe).toHaveBeenCalledTimes(1);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(
      deliveries.filter((delivery) => delivery.state === "processed"),
    ).toHaveLength(1);
    const wakes = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0].status).toBe("processed");
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
  });

  it("atomically admits only one first GitHub repository under concurrent root mentions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    const currentEndpoint = await service.get(endpoint.id);
    if (!endpointRuntime || !currentEndpoint.botUsername)
      throw new Error("Expected configured GitHub runtime identity");
    attachFakeGitHubIssueCommentWebhook({
      botUsername: currentEndpoint.botUsername,
      callbacks,
      endpointId: endpoint.id,
      runtime: endpointRuntime,
    });
    const [firstResource] = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: firstResource!.id, enabled: false },
    ]);
    await db.insert(chatEndpointResources).values({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      type: "repository",
      providerResourceId: "paperclipai/paperclip-second",
      label: "paperclipai/paperclip-second",
      availability: "available",
      enabled: false,
    });
    const roots = [
      {
        channelId: "paperclipai/paperclip",
        issueNumber: 901,
        messageId: 901001,
        repositoryId: 97531,
      },
      {
        channelId: "paperclipai/paperclip-second",
        issueNumber: 902,
        messageId: 902001,
        repositoryId: 97532,
      },
    ];

    await Promise.all(
      roots.map((root) => {
        const [owner, name] = root.channelId.split("/");
        return service.handleWebhook(
          endpoint.publicId,
          "github",
          signedGitHubWebhookRequest({
            delivery: `github-concurrent-root-${root.issueNumber}`,
            event: "issue_comment",
            payload: {
              action: "created",
              installation: { id: 2468 },
              repository: {
                id: root.repositoryId,
                full_name: root.channelId,
                name,
                owner: { id: 1357, login: owner },
              },
              issue: { number: root.issueNumber },
              comment: {
                id: root.messageId,
                body: `@${currentEndpoint.botUsername} investigate this race`,
                created_at: "2026-09-06T12:00:00Z",
                updated_at: "2026-09-06T12:00:00Z",
                user: { id: 42, login: "octocat" },
              },
              sender: { id: 42, login: "octocat" },
            },
            webhookSecret,
          }),
        );
      }),
    );

    const resources = await service.listResources(endpoint.id);
    expect(resources.filter((resource) => resource.enabled)).toHaveLength(1);
    const conversations = await db
      .select({ issueId: chatConversations.issueId })
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(conversations).toHaveLength(1);
    const [issue] = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, conversations[0]!.issueId));
    expect(issue?.title).toBe("investigate this race");
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
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );
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

  it("accepts a manually created GitHub App when /app lists only selectable webhook events", async () => {
    const fixture = await seedCompany();
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({
            id: 991124,
            slug: "maya-selectable-events",
            name: "Maya Selectable Events",
            owner: { login: "paperclipai" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            events: ["issue_comment", "pull_request_review_comment"],
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
              permissions: {
                issues: "write",
                metadata: "read",
                pull_requests: "write",
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
        return new Response(
          JSON.stringify({ token: "selectable-events-installation-token" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
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
    const { service } = createService(new FakeChatSdkRuntime(), providerFetch);
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

    await expect(
      service.configure(
        endpoint.id,
        { action: "configure", credentials: { appId: "991124", privateKey } },
        "owner-user",
      ),
    ).resolves.toMatchObject({
      status: "verifying",
      providerAccountId: "paperclipai",
      botExternalId: "991124",
      botUsername: "maya-selectable-events[bot]",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
      }),
    ]);
    await service.shutdown();
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
            contents: "write",
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
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

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
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );

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

  it("reveals a rotated GitHub secret despite a later completion-audit failure and makes retry a new rotation", async () => {
    const fixture = await seedCompany();
    let failedAuditAction: string | null = null;
    let failCredentialPersistence = false;
    const setupSecretActivityLogger: typeof logActivity = async (
      database,
      input,
      publications,
    ) => {
      if (failedAuditAction === input.action) {
        failedAuditAction = null;
        throw new Error("simulated setup-secret audit outage");
      }
      return logActivity(database, input, publications);
    };
    const setupSecretCredentialPersistBarrier = async () => {
      if (!failCredentialPersistence) return;
      failCredentialPersistence = false;
      throw new Error("simulated setup-secret credential persistence outage");
    };
    const {
      endpoint,
      runtime,
      service,
      webhookSecret: originalSecret,
    } = await configuredGitHubEndpoint(fixture, {
      setupSecretActivityLogger,
      setupSecretCredentialPersistBarrier,
    });

    failedAuditAction = "chat_endpoint.setup_secret_rotation_started";
    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toThrow("simulated setup-secret audit outage");
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 200,
    });

    const [refsBeforePersistenceFailure] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    failCredentialPersistence = true;
    await expect(
      service.generateSetupSecret(endpoint.id, "owner-user"),
    ).rejects.toThrow("simulated setup-secret credential persistence outage");
    const [refsAfterPersistenceFailure] = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(refsAfterPersistenceFailure!.refs).toEqual(
      refsBeforePersistenceFailure!.refs,
    );
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "Update the GitHub webhook secret, then reconnect this App",
      setup: { step: "provider_setup", webhookSecretConfigured: true },
    });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 200,
    });

    failedAuditAction = "chat_endpoint.setup_secret_generated";
    const first = await service.generateSetupSecret(endpoint.id, "owner-user");
    expect(first.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.webhookSecret).not.toBe(originalSecret);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        originalSecret,
      ),
    ).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      setup: {
        step: "provider_setup",
        webhookSecretConfigured: true,
      },
    });

    // A caller that lost the successful response may explicitly retry. That
    // retry is another serialized rotation: only the newly returned value is
    // valid, so the caller can converge without reusing hidden plaintext.
    const second = await service.generateSetupSecret(endpoint.id, "owner-user");
    expect(second.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        second.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 200 });

    const auditRows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    const started = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_rotation_started",
    );
    const completed = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_generated",
    );
    const failed = auditRows.filter(
      (row) => row.action === "chat_endpoint.setup_secret_rotation_failed",
    );
    expect(started).toHaveLength(4);
    expect(completed).toHaveLength(2);
    expect(failed).toHaveLength(1);
    const startedRotationIds = started.map((row) => row.details!.rotationId);
    const terminalRotationIds = new Set(
      [...completed, ...failed].map((row) => row.details!.rotationId),
    );
    expect(
      startedRotationIds.filter(
        (rotationId) => !terminalRotationIds.has(rotationId),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(first.webhookSecret);
    expect(JSON.stringify(auditRows)).not.toContain(second.webhookSecret);
  });

  it("replaces a pre-connect GitHub webhook secret without inventing a broken existing App", async () => {
    const fixture = await seedCompany();
    const { service } = createService();
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "github", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const first = await service.generateSetupSecret(endpoint.id, "owner-user");
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      first.webhookSecret,
    );

    const second = await service.generateSetupSecret(endpoint.id, "owner-user");

    expect(second.webhookSecret).not.toBe(first.webhookSecret);
    await expect(
      githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        first.webhookSecret,
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      providerAccountId: null,
      botExternalId: null,
      healthMessage: null,
      setup: {
        step: "provider_setup",
        webhookSecretConfigured: true,
        webhookVerifiedAt: null,
      },
    });
    const [connection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
        refs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toMatchObject({
      status: "draft",
      enabled: false,
      healthStatus: "unchecked",
      refs: [
        expect.objectContaining({
          configPath: "credentials.webhookSecret",
        }),
      ],
    });

    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      second.webhookSecret,
    );
    const setupActions = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    const generatedActions = setupActions.filter(
      (item) => item.action === "chat_endpoint.setup_secret_generated",
    );
    expect(generatedActions).toHaveLength(2);
    expect(generatedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            rotated: false,
            replacedPrevious: false,
          }),
        }),
        expect.objectContaining({
          details: expect.objectContaining({
            rotated: false,
            replacedPrevious: true,
          }),
        }),
      ]),
    );
    expect(
      setupActions.filter(
        (item) => item.action === "chat_endpoint.webhook_verified",
      ),
    ).toHaveLength(2);
  });

  it("preserves GitHub webhook verification through setup completion and reconnect", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service } =
      await configuredGitHubEndpoint(fixture);
    const setupThread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:811",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: setupThread.thread,
      message: makeMessage({
        id: "github-setup-root-811",
        text: "@maya-paperclip[bot] verify setup state",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);

    const [reply] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_publication")));
    await db.update(chatActions).set({ status: "processing" }).where(eq(chatActions.id, reply.id));
    await expect(service.test(endpoint.id)).rejects.toThrow("Wait for the Paperclip agent to reply");
    await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.id, reply.id));
    const activated = await service.test(endpoint.id);
    expect(activated).toMatchObject({
      status: "active",
      setup: {
        step: "complete",
        webhookVerifiedAt: expect.any(String),
      },
    });
    const verifiedAt = activated.setup.webhookVerifiedAt;

    const reconnected = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );
    expect(reconnected).toMatchObject({
      status: "verifying",
      setup: {
        step: "test",
        webhookVerifiedAt: verifiedAt,
      },
    });
    const [stored] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(stored!.setup).toMatchObject({
      step: "test",
      webhookVerifiedAt: verifiedAt,
      runtimeGeneration: expect.any(Number),
    });
  });

  it("repairs the same GitHub App webhook on reconnect without claiming a fresh signed ping or chat round trip", async () => {
    const fixture = await seedCompany();
    const { endpoint, service, webhookSecret, webhookSyncRequests } =
      await configuredGitHubEndpoint(fixture);
    const before = await service.get(endpoint.id);
    expect(webhookSyncRequests).toHaveLength(0);
    const [storedBefore] = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    const refsBefore = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const repaired = await service.configure(
      endpoint.id,
      { action: "reconnect" },
      "owner-user",
    );
    expect(webhookSyncRequests).toEqual([
      {
        url: before.setup.webhookUrl,
        content_type: "json",
        insecure_ssl: "0",
        secret: webhookSecret,
      },
    ]);
    expect(repaired).toMatchObject({
      id: endpoint.id,
      assignedAgentId: fixture.assignedAgentId,
      botExternalId: before.botExternalId,
      status: "verifying",
      setup: {
        step: "test",
        webhookVerifiedAt: before.setup.webhookVerifiedAt,
      },
    });
    const [storedRepair] = await db
      .select({
        lastEventAt: chatEndpoints.lastEventAt,
        setup: chatEndpoints.setup,
      })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id));
    expect(storedRepair?.lastEventAt).toBeNull();
    expect(storedRepair?.setup?.testStartedAt).not.toBe(
      storedBefore?.setup?.testStartedAt,
    );
    expect((storedRepair?.setup as InternalSetupState | undefined)?.runtimeGeneration).toBe(
      Number((storedBefore?.setup as InternalSetupState | undefined)?.runtimeGeneration) + 1,
    );
    await expect(service.test(endpoint.id)).rejects.toMatchObject({
      details: { code: "chat_test_message_missing" },
    });
    expect(
      await db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).toEqual(refsBefore);
    const audits = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    expect(audits).toContainEqual({
      action: "chat_endpoint.webhook_sync_started",
      details: { endpointId: endpoint.id, provider: "github" },
    });
    expect(audits).toContainEqual({
      action: "chat_endpoint.webhook_synced",
      details: { endpointId: endpoint.id, provider: "github" },
    });
    expect(JSON.stringify({ repaired, audits })).not.toContain(webhookSecret);
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    expect(webhookSyncRequests).toHaveLength(2);
    expect(webhookSyncRequests[1]).toEqual(webhookSyncRequests[0]);
  });

  it.each(["http", "mismatch"])(
    "leaves GitHub reconnect unqualified after a %s webhook repair failure",
    async (failure) => {
      const fixture = await seedCompany();
      const {
        endpoint,
        service,
        runtime,
        webhookSecret,
        setWebhookSyncResponse,
      } = await configuredGitHubEndpoint(fixture);
      setWebhookSyncResponse(async () => {
        if (failure === "transport")
          throw new Error(`private provider echo ${webhookSecret}`);
        if (failure === "http")
          return new Response(webhookSecret, { status: 403 });
        if (failure === "oversized") return new Response(" ".repeat(32_769));
        if (failure === "malformed") return new Response(webhookSecret);
        return new Response(
          JSON.stringify({
            url: `https://bad.example/${webhookSecret}`,
            content_type: "json",
            insecure_ssl: "0",
          }),
        );
      });
      await expect(
        service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
      ).rejects.toMatchObject({
        details: { code: "chat_provider_setup_failed" },
      });
      expect(runtime.endpoints.has(endpoint.id)).toBe(false);
      const failed = await service.get(endpoint.id);
      expect(failed).toMatchObject({ status: "attention" });
      const audits = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.entityId, endpoint.connectionId));
      expect(audits.map((row) => row.action)).toContain(
        "chat_endpoint.webhook_sync_started",
      );
      expect(audits.map((row) => row.action)).not.toContain(
        "chat_endpoint.webhook_synced",
      );
      expect(audits.map((row) => row.action)).not.toContain(
        "chat_endpoint.reconnected",
      );
      expect(JSON.stringify({ failed, audits })).not.toContain(webhookSecret);
      await expect(service.test(endpoint.id)).rejects.toMatchObject({
        details: { code: "chat_endpoint_not_testing" },
      });
    },
  );

  it("does not complete GitHub webhook repair or overwrite a new credential lease owner after remote success", async () => {
    const fixture = await seedCompany();
    const {
      endpoint,
      service,
      runtime,
      setWebhookSyncResponse,
      webhookSyncRequests,
    } = await configuredGitHubEndpoint(fixture);
    setWebhookSyncResponse(async () => {
      await db
        .update(chatEndpointLeases)
        .set({ token: randomUUID() })
        .where(
          and(
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, "credentials"),
          ),
        );
      await db
        .update(chatEndpoints)
        .set({ status: "attention", healthMessage: "Winning lease state" })
        .where(eq(chatEndpoints.id, endpoint.id));
      const config = webhookSyncRequests.at(-1)!;
      return new Response(
        JSON.stringify({
          url: config.url,
          content_type: "json",
          insecure_ssl: "0",
        }),
      );
    });
    await expect(
      service.configure(endpoint.id, { action: "reconnect" }, "owner-user"),
    ).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage: "Winning lease state",
    });
    const audits = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, endpoint.connectionId));
    expect(audits.map((row) => row.action)).not.toContain(
      "chat_endpoint.webhook_synced",
    );
    expect(audits.map((row) => row.action)).not.toContain(
      "chat_endpoint.reconnected",
    );
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

    let currentWebhookSecret: string | null = null;
    for (const candidate of rotatedSecrets) {
      const response = await githubWebhookVerificationResponse(
        service,
        endpoint.publicId,
        candidate,
      );
      if (response.status === 200) currentWebhookSecret = candidate;
    }
    expect(currentWebhookSecret).not.toBeNull();
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
    expect(providerConfig.credentials.webhookSecret).toBe(currentWebhookSecret);
  });

  it("serializes a GitHub secret rotation racing reconnect and preserves the rotated secret", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture);
    const app = routesApp(db, fixture.companyId, service);

    const [rotation, reconnect] = await Promise.all([
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup-secret`)
        .send({})
        .expect(201),
      request(app)
        .post(`/api/chat-endpoints/${endpoint.id}/setup`)
        .send({ action: "reconnect" }),
    ]);
    expect([200, 409]).toContain(reconnect.status);
    const rotatedSecret = rotation.body.webhookSecret as string;
    expect(rotatedSecret).toMatch(/^[a-f0-9]{64}$/);

    // The final state depends on which request acquired the lease first. A
    // final reconnect must consume the complete, most recent credential set
    // in either ordering.
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      rotatedSecret,
    );
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

  it("does not create SDK eyes reactions for accepted GitHub requests", async () => {
    const fixture = await seedCompany();
    let reactionTransportCalls = 0;
    const { callbacks, endpoint, runtime } = await configuredGitHubEndpoint(fixture, {
      receiptReactionTransportBarrier: async () => { reactionTransportCalls += 1; },
    });
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:909",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks, endpointId: endpoint.id, provider: "github", thread: thread.thread,
      message: makeMessage({ id: "90901", text: "@maya acknowledge this", mentioned: true }),
      trigger: "mention",
    });
    expect(reactionTransportCalls).toBe(0);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    expect(await db.select().from(chatActions).where(and(
      eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "receipt_reaction"),
    ))).toEqual([]);
  });

  it("filters a durably admitted GitHub callback when rotation and reconnect supersede its runtime before deferred processing", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { callbacks, endpoint, runtime, service } =
      await configuredGitHubEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    const obsoleteRuntime = runtime.endpoints.get(endpoint.id);
    if (!obsoleteRuntime) throw new Error("Expected initial GitHub runtime");
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:910",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "91001",
        text: "@maya this old callback must not cross the reconnect fence",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(deferred).toHaveLength(1);
    const obsoleteDeliveryDrain = deferred[0];
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery.normalizedEvent).toMatchObject({
      runtimeContext: {
        credentialFingerprint: expect.any(String),
        generation: expect.any(Number),
      },
    });

    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );
    await service.configure(endpoint.id, { action: "reconnect" }, "owner-user");
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, delivery.id));

    await service.processPendingDeliveries(25, delivery.id);

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          error: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([
      {
        state: "filtered",
        error: "Connection activation changed before admission",
      },
    ]);
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(obsoleteRuntime.reactions).toEqual([]);
    expect(runtime.endpoints.get(endpoint.id)?.reactions).toEqual([]);
    // The original delivery drain is still queued. Durable ping admission also
    // schedules a worker, even though the scoped setup helper has already
    // processed that exact receipt; neither callback is executed in this race.
    expect(deferred).toHaveLength(2);
    expect(deferred[0]).toBe(obsoleteDeliveryDrain);
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

    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    expect(conversations).toHaveLength(3);
    expect(new Set(conversations.map((row) => row.issueId)).size).toBe(3);
    expect(conversations.map((row) => row.externalThreadId).sort()).toEqual(
      cases.map((item) => item.id).sort(),
    );
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
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

  it("uses GitHub numeric user ids for linked authority and rechecks membership on every follow-up", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredGitHubEndpoint(fixture);
    await service.update(
      endpoint.id,
      { allowUnlinkedPeople: false },
      "owner-user",
    );
    const githubUserId = "18446744073709551";
    const thread = makeThread({
      channelId: "paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:59",
      name: "paperclipai/paperclip",
    });
    const send = (
      id: string,
      text: string,
      trigger: "mention" | "subscribed_message",
    ) =>
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "github",
        thread: thread.thread,
        message: makeMessage({
          id,
          text,
          mentioned: trigger === "mention",
          userId: githubUserId,
          userName: "octocat-renamable",
        }),
        trigger,
      });

    await send("59001", "@maya attempt before identity linking", "mention");
    await send("59001", "@maya attempt before identity linking", "mention");
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    const [principal] = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "github"),
          eq(chatExternalPrincipals.externalId, githubUserId),
        ),
      );
    expect(principal).toMatchObject({ externalId: githubUserId });
    const [filtered] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(filtered).toMatchObject({
      state: "filtered",
      redactedError: "External identity must be linked to a Paperclip account",
      normalizedEvent: { deduplication: { duplicateCount: 1 } },
    });

    const linkedUserId = `github-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "GitHub Linked User",
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
    const intent = await service.createLinkIntent(
      endpoint.id,
      principal!.id,
      1_800,
    );
    const token = new URL(intent.confirmationUrl).searchParams.get("token");
    if (!token)
      throw new Error("GitHub identity-link confirmation token was absent");
    await service.confirmIdentityLink(token, linkedUserId);

    await send("59002", "@maya authorized GitHub task", "mention");
    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toBeDefined();
    await expect(
      db
        .select({
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
        })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual([
      {
        authorUserId: linkedUserId,
        body: "@maya authorized GitHub task",
      },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(1);

    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(companyMemberships.companyId, fixture.companyId),
          eq(companyMemberships.principalId, linkedUserId),
        ),
      );
    await send(
      "59003",
      "This follow-up must be rejected now",
      "subscribed_message",
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual([{ body: "@maya authorized GitHub task" }]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const suspendedDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.providerEventId, `${thread.thread.id}:59003`),
        ),
      )
      .then((rows) => rows[0]);
    expect(suspendedDelivery).toMatchObject({
      state: "filtered",
      redactedError: "Linked Paperclip account is not currently permitted",
    });
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

    const durable = await readChatDeliveriesByEndpointId(endpoint.id);
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

    // The production reorder window is 750 ms; allow the subsequent database
    // drain to finish on loaded CI instead of sharing the default one-second budget.
    deferred.shift()?.();
    await vi.waitFor(async () => {
      const rows = await readChatConversationsByEndpointId(endpoint.id);
      expect(rows).toHaveLength(1);
    }, { timeout: 10_000 });
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
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
      expect(wakeup).toHaveBeenCalledTimes(2);
    }, { timeout: 10_000 });
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
    const [replyDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date() })
      .where(eq(chatDeliveries.id, replyDelivery!.id));

    await service.processPendingDeliveries(25, replyDelivery!.id);

    await expect(
      readChatDeliveriesById(replyDelivery!.id),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "retry",
        attempts: 1,
        redactedError: "Waiting briefly for an earlier root mention",
      }),
    ]);
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
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

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
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

  it("filters a standalone unaddressed GitHub comment after bounded orphan retention", async () => {
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
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    for (let expectedAttempt = 1; expectedAttempt <= 13; expectedAttempt += 1) {
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date() })
        .where(eq(chatDeliveries.id, delivery!.id));
      await service.processPendingDeliveries(25, delivery!.id);
      const current = await readChatDeliveriesById(delivery!.id)
        .then((rows) => rows[0]);
      expect(current).toMatchObject({
        state: expectedAttempt <= 12 ? "retry" : "filtered",
        attempts: expectedAttempt,
      });
    }
    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await service.shutdown();
  });

  it("revokes a deleted canonical GitHub installation and recovers the same endpoint after reinstall", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, runtime, service, webhookSecret } = context;
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
    await service.test(endpoint.id);
    const recovery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    onTestFinished(() => recovery.stop());
    await service.registerGitHubWebhookRecoveryWork(recovery, () => true).ready;
    await expect.poll(() => (recovery.nextWakeAt() ?? 0) - Date.now(), { timeout: 5000 }).toBeGreaterThan(30_000);
    await expect.poll(() => idleWorkSnapshot().active).toBe(0);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const credentialRefsBeforeDeletion = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId))
      .then((rows) => rows[0]!.refs);

    context.setInstallationAvailable(false);
    const deleted = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-deleted",
        event: "installation",
        payload: {
          action: "deleted",
          installation: { id: 2468 },
        },
        webhookSecret,
      }),
    );
    expect(deleted.status).toBe(202);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "revoked",
      healthMessage: "GitHub App installation was removed",
    });
    await expect.poll(() => recovery.nextWakeAt(), { timeout: 5000 }).toBeNull();
    await expect(
      db
        .select({
          status: toolConnections.status,
          enabled: toolConnections.enabled,
          healthStatus: toolConnections.healthStatus,
          refs: toolConnections.credentialSecretRefs,
        })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId)),
    ).resolves.toEqual([
      {
        status: "disabled",
        enabled: false,
        healthStatus: "failed",
        refs: credentialRefsBeforeDeletion,
      },
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation!.id, state: "unavailable" }),
    ]);
    await expect(
      db
        .select({ state: chatDeliveries.state })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              "lifecycle:github-installation-deleted",
            ),
          ),
        ),
    ).resolves.toEqual([{ state: "processed" }]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);

    context.setInstallationId(8642);
    context.setInstallationAvailable(true);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-recreated",
        event: "installation",
        payload: {
          action: "created",
          installation: { id: 8642 },
        },
        webhookSecret,
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
      readChatPublicationsById(publication!.id),
    ).resolves.toEqual([expect.objectContaining({ state: "published" })]);
  });

  it("fails closed when GitHub App permissions drift before installation recovery", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, runtime, service, webhookSecret } = context;
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:62",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "62001",
        text: "@maya establish the permission drift thread",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-installation-suspended-before-drift",
        event: "installation",
        payload: {
          action: "suspend",
          installation: { id: 2468 },
        },
        webhookSecret,
      }),
    );
    context.setAppAccess({
      permissions: {
        issues: "read",
        metadata: "read",
        pull_requests: "write",
      },
    });

    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-installation-unsuspended-with-drift",
          event: "installation",
          payload: {
            action: "unsuspend",
            installation: { id: 2468 },
          },
          webhookSecret,
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions: ["issues"],
      },
    });

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "GitHub App credentials, permissions, events, or identity need attention",
      lastError: expect.stringContaining("issues"),
    });
    const [connection] = await db
      .select({
        status: toolConnections.status,
        enabled: toolConnections.enabled,
        healthStatus: toolConnections.healthStatus,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connection).toEqual({
      status: "disabled",
      enabled: false,
      healthStatus: "degraded",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ availability: "unavailable", enabled: true }),
    ]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({ id: conversation!.id, state: "unavailable" }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const lifecycleDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            "lifecycle:github-installation-unsuspended-with-drift",
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(lifecycleDelivery).toMatchObject({
      state: "retry",
      redactedError: expect.stringContaining("issues"),
    });
  });

  it("fails closed when the GitHub installation has not approved the App permissions", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, service, webhookSecret } = context;
    const thread = makeThread({
      channelId: "github:paperclipai/paperclip",
      id: "github:paperclipai/paperclip:issue:63",
      name: "paperclipai/paperclip",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: thread.thread,
      message: makeMessage({
        id: "63001",
        text: "@maya establish the installation permission thread",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id);
    await service.test(endpoint.id);

    context.setInstallationAccess({
      issues: "read",
      metadata: "read",
      pull_requests: "write",
    });
    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-installation-permission-approval-pending",
          event: "installation",
          payload: {
            action: "new_permissions_accepted",
            installation: { id: 2468 },
          },
          webhookSecret,
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "chat_provider_inventory_failed" },
    });

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "GitHub App credentials, permissions, events, or identity need attention",
      lastError: expect.stringContaining(
        "active installation has not granted the required access for: issues",
      ),
    });
    const lifecycleDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            "lifecycle:github-installation-permission-approval-pending",
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(lifecycleDelivery).toMatchObject({
      state: "retry",
      redactedError: expect.stringContaining("issues"),
    });
  });

  it("reconciles concurrent opposite GitHub lifecycle callbacks from canonical App state", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { endpoint, runtime, service, webhookSecret } = context;
    const repository = {
      id: 97531,
      full_name: "paperclipai/paperclip",
      html_url: "https://github.com/paperclipai/paperclip",
      owner: { id: 1357, login: "paperclipai" },
      private: false,
    };
    const send = (delivery: string, event: string, payload: unknown) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery,
          event,
          payload,
          webhookSecret,
        }),
      );

    context.setRepositories([]);
    await send(
      "github-repositories-canonical-empty",
      "installation_repositories",
      {
        action: "removed",
        repositories_added: [],
        repositories_removed: [repository],
      },
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "removed",
        enabled: true,
      }),
    ]);

    context.setRepositories([repository]);
    await Promise.all([
      send("github-installation-late-suspend", "installation", {
        action: "suspend",
        installation: { id: 2468 },
      }),
      send("github-installation-current-unsuspend", "installation", {
        action: "unsuspend",
        installation: { id: 2468 },
      }),
      send("github-repositories-late-remove", "installation_repositories", {
        action: "removed",
        repositories_added: [],
        repositories_removed: [repository],
      }),
      send("github-repositories-current-add", "installation_repositories", {
        action: "added",
        repositories_added: [repository],
        repositories_removed: [],
      }),
    ]);

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      healthMessage: "Waiting for a test conversation",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
        enabled: true,
      }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);
  });

  it("does not let GitHub lifecycle recovery undo a webhook-secret rotation", async () => {
    const fixture = await seedCompany();
    const {
      endpoint,
      runtime,
      service,
      webhookSecret: oldWebhookSecret,
    } = await configuredGitHubEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub runtime");
    let releaseWebhook!: () => void;
    let markWebhookEntered!: () => void;
    const webhookEntered = new Promise<void>((resolve) => {
      markWebhookEntered = resolve;
    });
    const webhookRelease = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    providerRuntime.webhookHook = async () => {
      markWebhookEntered();
      await webhookRelease;
    };
    const body = JSON.stringify({
      action: "unsuspend",
      installation: { id: 2468 },
    });
    const signature = createHmac("sha256", oldWebhookSecret)
      .update(body)
      .digest("hex");

    const staleCallback = service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "github-available-during-secret-rotation",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body,
      }),
    );
    await webhookEntered;
    await service.generateSetupSecret(endpoint.id, "owner-user");
    releaseWebhook();
    await expect(staleCallback).resolves.toMatchObject({ status: 202 });

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      setup: { step: "provider_setup", webhookVerifiedAt: null },
    });
    const [connection] = await readToolConnectionsById(endpoint.connectionId);
    expect(connection).toMatchObject({
      status: "disabled",
      enabled: false,
      healthStatus: "degraded",
    });
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const [delivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            "lifecycle:github-available-during-secret-rotation",
          ),
        ),
      );
    expect(delivery).toMatchObject({
      state: "filtered",
      redactedError:
        "Provider lifecycle callback belonged to a superseded runtime",
    });
  });

  it("does not let an obsolete GitHub webhook secret reopen a repository during rotation", async () => {
    const fixture = await seedCompany();
    let blockWebhookAuthentication = false;
    let blockCredentialPersistence = false;
    let markWebhookReady!: () => void;
    let releaseWebhook!: () => void;
    let markRotationReady!: () => void;
    let releaseRotation!: () => void;
    const webhookReady = new Promise<void>((resolve) => {
      markWebhookReady = resolve;
    });
    const webhookRelease = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    const rotationReady = new Promise<void>((resolve) => {
      markRotationReady = resolve;
    });
    const rotationRelease = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const {
      endpoint,
      service,
      webhookSecret: oldWebhookSecret,
    } = await configuredGitHubEndpoint(fixture, {
      githubWebhookAuthenticationBarrier: async () => {
        if (!blockWebhookAuthentication) return;
        markWebhookReady();
        await webhookRelease;
      },
      setupSecretCredentialPersistBarrier: async () => {
        if (!blockCredentialPersistence) return;
        markRotationReady();
        await rotationRelease;
      },
    });

    blockWebhookAuthentication = true;
    const staleCallback = service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-during-secret-rotation",
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 86420,
            full_name: "paperclipai/stale-secret-repository",
            html_url: "https://github.com/paperclipai/stale-secret-repository",
            owner: { id: 1357, login: "paperclipai" },
            private: false,
          },
          issue: { number: 7 },
          comment: { id: 7001, body: "obsolete credential callback" },
          sender: { id: 42, login: "octocat" },
        },
        webhookSecret: oldWebhookSecret,
      }),
    );
    await webhookReady;

    blockCredentialPersistence = true;
    const rotation = service.generateSetupSecret(endpoint.id, "owner-user");
    await rotationReady;
    releaseWebhook();
    releaseRotation();

    await rotation;
    // The callback authenticated before rotation won the mutation lease, but
    // its repository was never enabled. It may be rejected as obsolete or
    // acknowledged as out of scope; either way it must not mutate inventory.
    await expect(staleCallback).resolves.toMatchObject({ status: 200 });
    await expect(service.listResources(endpoint.id)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: "paperclipai/stale-secret-repository",
        }),
      ]),
    );
  });

  it("acknowledges GitHub lifecycle callbacks without changing a paused endpoint", async () => {
    const fixture = await seedCompany();
    const { endpoint, service } = await configuredGitHubEndpoint(fixture);
    const current = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...current.setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    await service.configure(endpoint.id, { action: "pause" }, "owner-user");
    const before = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .then((rows) => rows.length);

    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request("https://paperclip.example/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": "github-available-while-paused",
        },
        body: JSON.stringify({
          action: "unsuspend",
          installation: { id: 2468 },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "paused",
    });
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id))
        .then((rows) => rows.length),
    ).resolves.toBe(before);
  });

  it("reconciles a foreign GitHub installation lifecycle event against canonical App inventory", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub runtime");
    providerRuntime.webhookRequest = null;
    const payload = JSON.stringify({
      action: "deleted",
      installation: { id: 9999 },
    });
    const signature = createHmac("sha256", webhookSecret)
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

    expect(response.status).toBe(202);
    expect(providerRuntime.webhookRequest).not.toBeNull();
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      setup: { step: "complete" },
    });
    await expect(
      readChatDeliveriesByEndpointId(endpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        providerEventId: "lifecycle:foreign-installation-deleted",
        state: "processed",
      }),
    ]);
  });

  it("quarantines an active GitHub endpoint when its dedicated App drifts to multiple installations", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { endpoint, runtime, service, webhookSecret } = context;
    const setup = await db
      .select({ setup: chatEndpoints.setup })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpoint.id))
      .then((rows) => rows[0]!.setup);
    await db
      .update(chatEndpoints)
      .set({ status: "active", setup: { ...setup, step: "complete" } })
      .where(eq(chatEndpoints.id, endpoint.id));
    context.setAdditionalInstallationIds([9999]);

    await expect(
      service.handleWebhook(
        endpoint.publicId,
        "github",
        signedGitHubWebhookRequest({
          delivery: "github-second-installation-created",
          event: "installation",
          payload: {
            action: "created",
            installation: { id: 9999 },
          },
          webhookSecret,
        }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "chat_provider_inventory_failed" },
    });

    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "attention",
      healthMessage:
        "GitHub App credentials, permissions, events, or identity need attention",
      lastError: expect.stringContaining("exactly one active installation"),
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "unavailable",
      }),
    ]);
    expect(runtime.endpoints.has(endpoint.id)).toBe(false);
    const [failedLifecycle] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            "lifecycle:github-second-installation-created",
          ),
        ),
      );
    expect(failedLifecycle).toMatchObject({
      state: "retry",
      redactedError: expect.stringContaining("exactly one active installation"),
    });

    context.setAdditionalInstallationIds([]);
    const recovered = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-second-installation-removed",
        event: "installation",
        payload: {
          action: "deleted",
          installation: { id: 9999 },
        },
        webhookSecret,
      }),
    );
    expect(recovered.status).toBe(202);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
      healthMessage: "Connected",
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: "paperclipai/paperclip",
        availability: "available",
      }),
    ]);
  });

  it("accepts only signed GitHub setup pings before App credentials exist", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(runtime);
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya GitHub setup ping",
      },
      "owner-user",
    );
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
    const setupPing = (signatureHeader?: string) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        new Request("https://paperclip.example/github", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            ...(signatureHeader
              ? { "x-hub-signature-256": signatureHeader }
              : {}),
          },
          body,
        }),
      );

    await expect(setupPing()).resolves.toMatchObject({ status: 401 });
    await expect(setupPing("sha256=invalid")).resolves.toMatchObject({
      status: 401,
    });
    const accepted = await setupPing(`sha256=${signature}`);
    expect(accepted.status).toBe(200);
    await expect(accepted.text()).resolves.toBe("pong");
    expect(runtime.configurations.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      healthMessage: "GitHub webhook verified",
      setup: {
        webhookSecretConfigured: true,
        webhookVerifiedAt: expect.any(String),
      },
    });
  });

  it("ignores a signed GitHub installation before App credentials exist", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(runtime);
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "github",
        assignedAgentId: fixture.assignedAgentId,
        name: "Maya GitHub pre-key installation",
      },
      "owner-user",
    );
    const { webhookSecret } = await service.generateSetupSecret(
      endpoint.id,
      "owner-user",
    );
    await recordGitHubWebhookVerification(
      service,
      endpoint.publicId,
      webhookSecret,
    );
    const endpointBeforeInstallation = await service.get(endpoint.id);
    const webhookVerifiedAt =
      endpointBeforeInstallation.setup?.webhookVerifiedAt;
    expect(webhookVerifiedAt).toEqual(expect.any(String));
    const [connectionBeforeInstallation] = await db
      .select({
        enabled: toolConnections.enabled,
        refs: toolConnections.credentialSecretRefs,
        status: toolConnections.status,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    const deliveryId = `github-pre-key-installation-${randomUUID()}`;

    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: deliveryId,
        event: "installation",
        payload: {
          action: "created",
          installation: {
            id: 987_654_321,
            account: { id: 1, login: "paperclip-e2e", type: "User" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            suspended_at: null,
          },
        },
        webhookSecret,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ignored");
    expect(runtime.configurations.has(endpoint.id)).toBe(false);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "draft",
      providerAccountId: null,
      botExternalId: null,
      healthMessage: "GitHub webhook verified",
      setup: {
        step: "provider_setup",
        webhookSecretConfigured: true,
        webhookVerifiedAt,
      },
    });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([]);
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "github_webhook_ingress"),
            eq(
              chatActions.providerActionId,
              `github_webhook_ingress:${deliveryId}`,
            ),
          ),
        ),
    ).resolves.toEqual([]);
    const [connectionAfterInstallation] = await db
      .select({
        enabled: toolConnections.enabled,
        refs: toolConnections.credentialSecretRefs,
        status: toolConnections.status,
      })
      .from(toolConnections)
      .where(eq(toolConnections.id, endpoint.connectionId));
    expect(connectionAfterInstallation).toEqual(connectionBeforeInstallation);
    expect(connectionAfterInstallation).toMatchObject({
      enabled: false,
      refs: [
        expect.objectContaining({
          configPath: "credentials.webhookSecret",
        }),
      ],
      status: "draft",
    });
  });
});
