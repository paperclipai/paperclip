import { conflict } from "../../errors.js";
import { incomingWakeWorkQuery } from "../../services/idle-incoming-wake.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import sharp from "sharp";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks, chatPublications, chatTeamsFileTransfers, companySecrets, companyMemberships, heartbeatRuns, issueComments, issueAttachments, issueQuestionResponseDeliveries, issueThreadInteractions, issues, projects, toolConnections } from "@paperclipai/db";
import type { Attachment, Thread } from "chat";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import * as chatQuestionForms from "../../services/chat-question-forms.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeSlackFetch, makeThread, makeMessage, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";

describeEmbeddedPostgres("chat channels: teams ingress and media", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, readIssuesById, readChatPublicationsById, readToolConnectionsById, readIssueCommentsByCompanyId, createService, createStorageService, retirePublicationFixture, chatWakeContext, addSelectedChatFinal, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTeamsEndpoint, deliverMessage } = h;
  const { configuredGitHubEndpoint } = gh;

  it.each([
    {
      provider: "slack" as const,
      claimedIdentity: {
        providerAccountId: "T-PAPERCLIP",
        botExternalId: "U-CLAIMED-BOT",
        botUsername: "maya-claimed",
      },
      providerFetch: fakeSlackFetch(
        "U-DIFFERENT-BOT",
      ) as typeof globalThis.fetch,
      credentials: {
        botToken: "xoxb-different-bot",
        signingSecret: "different-signing-secret",
      } as Record<string, string>,
    },
    {
      provider: "microsoft-teams" as const,
      claimedIdentity: {
        providerAccountId: "00000000-0000-4000-8000-000000000191",
        botExternalId: "00000000-0000-4000-8000-000000000192",
        botUsername: null,
      },
      providerFetch: (async () =>
        new Response(JSON.stringify({ access_token: "teams-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      credentials: {
        clientId: "00000000-0000-4000-8000-000000000193",
        tenantId: "00000000-0000-4000-8000-000000000191",
        clientSecret: "different-teams-secret",
      } as Record<string, string>,
    },
  ])(
    "keeps a claimed $provider identity immutable when first setup resumes from attention",
    async ({ provider, claimedIdentity, providerFetch, credentials }) => {
      const fixture = await seedCompany();
      const { service } = createService(
        new FakeChatSdkRuntime(),
        providerFetch,
      );
      const endpoint = await service.create(
        fixture.companyId,
        { provider, assignedAgentId: fixture.assignedAgentId },
        "owner-user",
      );

      // Model a process interruption after the provider identity claim and
      // before credential refs were committed. Retrying the original
      // `configure` request must not be able to replace that identity.
      await db
        .update(chatEndpoints)
        .set({
          status: "attention",
          ...claimedIdentity,
          healthMessage: "Provider setup must be completed",
        })
        .where(eq(chatEndpoints.id, endpoint.id));

      await expect(
        service.configure(
          endpoint.id,
          { action: "configure", credentials },
          "owner-user",
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: "chat_bot_identity_changed" },
      });
      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: "attention",
        providerAccountId: claimedIdentity.providerAccountId,
        botExternalId: claimedIdentity.botExternalId,
      });
      await expect(
        db
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId))
          .then((rows) => rows[0]?.refs ?? []),
      ).resolves.toEqual([]);
      await service.shutdown();
    },
  );

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
      allowGroupChats: false,
      capabilities: {
        nativeStreaming: false,
        messageEdits: true,
        messageDeletes: true,
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

  it("globally fences one Microsoft Bot application across tenants", async () => {
    const firstCompany = await seedCompany();
    const secondCompany = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000091";
    const providerFetch = (async () =>
      new Response(JSON.stringify({ access_token: "teams-access" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    let claimCount = 0;
    let releaseClaims!: () => void;
    const bothClaimsReady = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    const claimBarrier = async () => {
      claimCount += 1;
      if (claimCount === 2) releaseClaims();
      await bothClaimsReady;
    };
    const first = createService(new FakeChatSdkRuntime(), providerFetch, {
      nativeBotIdentityClaimBarrier: claimBarrier,
    });
    const second = createService(new FakeChatSdkRuntime(), providerFetch, {
      nativeBotIdentityClaimBarrier: claimBarrier,
    });
    const firstEndpoint = await first.service.create(
      firstCompany.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: firstCompany.assignedAgentId,
      },
      "owner-user",
    );
    const secondEndpoint = await second.service.create(
      secondCompany.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: secondCompany.assignedAgentId,
      },
      "owner-user",
    );
    const endpoints = [firstEndpoint, secondEndpoint] as const;
    const services = [first.service, second.service] as const;
    const tenantIds = [
      "00000000-0000-4000-8000-000000000092",
      "00000000-0000-4000-8000-000000000093",
    ] as const;
    const outcomes = await Promise.allSettled(
      services.map((service, index) =>
        service.configure(
          endpoints[index]!.id,
          {
            action: "configure",
            credentials: {
              clientId,
              tenantId: tenantIds[index]!,
              clientSecret: `teams-secret-${index}`,
            },
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
      details: { code: "chat_bot_identity_in_use" },
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
        .then((rows) => rows[0]?.refs ?? []),
    ).resolves.toEqual([]);
    await first.service.shutdown();
    await second.service.shutdown();
  });

  it("rotates Microsoft Teams secrets without changing bot identity and preserves the last good credentials on rejection", async () => {
    const fixture = await seedCompany();
    const clientId = "00000000-0000-4000-8000-000000000011";
    const tenantId = "00000000-0000-4000-8000-000000000012";
    const providerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("client_secret") === "revoked-secret") {
          return new Response(
            JSON.stringify({
              error_description: "client secret is invalid or expired",
            }),
            {
              status: 401,
              headers: { "content-type": "application/json" },
            },
          );
        }
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
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { clientId, tenantId, clientSecret: "first-secret" },
      },
      "owner-user",
    );
    const refs = () =>
      db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(eq(toolConnections.id, endpoint.connectionId))
        .then((rows) => rows[0]!.refs);
    const firstRefs = await refs();
    expect(firstRefs).toHaveLength(3);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { clientId, tenantId, clientSecret: "revoked-secret" },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await refs()).toEqual(firstRefs);
    expect(runtime.endpoints.has(endpoint.id)).toBe(true);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: { clientId, tenantId, clientSecret: "rotated-secret" },
        },
        "owner-user",
      ),
    ).resolves.toMatchObject({
      providerAccountId: tenantId,
      botExternalId: clientId,
      status: "verifying",
    });
    const rotatedRefs = await refs();
    expect(rotatedRefs).toHaveLength(3);
    expect(
      rotatedRefs.every((ref) =>
        firstRefs.every((firstRef) => firstRef.secretId !== ref.secretId),
      ),
    ).toBe(true);
    await expect(
      db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId)),
    ).resolves.toHaveLength(3);

    await expect(
      service.configure(
        endpoint.id,
        {
          action: "reconnect",
          credentials: {
            clientId,
            tenantId: "00000000-0000-4000-8000-000000000099",
            clientSecret: "other-tenant-secret",
          },
        },
        "owner-user",
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "chat_bot_identity_changed" },
    });
    expect(await refs()).toEqual(rotatedRefs);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      providerAccountId: tenantId,
      botExternalId: clientId,
    });
  });

  it("coalesces one Microsoft Teams run into one provider reply", async () => {
    const fixture = await seedCompany();
    const clientId = randomUUID();
    const tenantId = randomUUID();
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
          clientId,
          tenantId,
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
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
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
    await addSelectedChatFinal({
      agentId: fixture.assignedAgentId,
      body: "Final Teams result",
      companyId: fixture.companyId,
      issueId: conversation.issueId,
      runId,
    });
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
    await context.service.shutdown();
  });

  it("keeps Teams group chat closed by default without consuming first-channel setup enablement", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "verifying",
      allowGroupChats: false,
    });

    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const groupConversationId = "19:teams-setup-group@unq.gbl.spaces";
    const groupThread = makeThread({
      channelId: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(groupConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Setup group",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: groupThread.thread,
      message: makeMessage({
        id: "teams-setup-group-disabled",
        text: "@maya this group is still closed",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(wakeup).not.toHaveBeenCalled();
    const [filteredGroupDelivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(filteredGroupDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: "teams-setup-group-disabled" },
      },
    });
    expect(
      JSON.stringify(filteredGroupDelivery?.normalizedEvent),
    ).not.toContain("this group is still closed");
    expect(
      JSON.stringify(filteredGroupDelivery?.normalizedEvent),
    ).not.toContain("U-EXTERNAL");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
          ),
        ),
    ).resolves.toHaveLength(0);

    const channelConversationId = "19:teams-first-channel@thread.tacv2";
    const rootMessageId = "1740000000091";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "First setup channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: rootMessageId,
        text: "@maya start the channel setup task",
        mentioned: true,
      }),
      trigger: "mention",
    });

    await expect(service.listConversations(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        externalThreadId: channelThread.thread.id,
        isDirectMessage: false,
      }),
    ]);
    await expect(service.listResources(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerResourceId: groupConversationId,
          type: "group_chat",
          enabled: false,
        }),
        expect.objectContaining({
          providerResourceId: channelConversationId,
          type: "channel",
          enabled: true,
        }),
      ]),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("continues a legacy Teams binding across a regional route change without forking its task", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    // The inverted question mark contributes a `/` in standard base64, which
    // becomes `_` in base64url. Keep this fixture explicit so the canonical
    // decoder is exercised on an actual URL-safe alphabet difference.
    const conversationId = "19:stable-route-¿@thread.tacv2";
    const rootMessageId = "1740000000199";
    const rootedConversationId = `${conversationId};messageid=${rootMessageId}`;
    expect(Buffer.from(rootedConversationId).toString("base64url")).toContain(
      "_",
    );
    const amerServiceUrl = "https://smba.trafficmanager.net/amer/";
    const emeaServiceUrl = "https://smba.trafficmanager.net/emea/";
    const legacyThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}:${Buffer.from(amerServiceUrl).toString("base64url")}`;
    const canonicalThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}`;
    const legacyEmeaThreadId = `teams:${Buffer.from(rootedConversationId).toString("base64url")}:${Buffer.from(emeaServiceUrl).toString("base64url")}`;
    const legacyChannelId = `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(amerServiceUrl).toString("base64url")}`;
    const canonicalChannelId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
    const legacyThread = makeThread({
      channelId: legacyChannelId,
      id: legacyThreadId,
      name: "Stable Teams channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyThread.thread,
      message: makeMessage({
        id: rootMessageId,
        mentioned: true,
        raw: {
          serviceUrl: amerServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "@maya preserve this task across route changes",
      }),
      trigger: "mention",
    });

    const canonicalThread = makeThread({
      channelId: canonicalChannelId,
      id: canonicalThreadId,
      name: "Stable Teams channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: canonicalThread.thread,
      message: makeMessage({
        id: "1740000000200",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue after Microsoft moved the reply route",
      }),
      trigger: "subscribed_message",
    });

    const legacyEmeaThread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(emeaServiceUrl).toString("base64url")}`,
      id: legacyEmeaThreadId,
      name: "Stable Teams channel",
    });
    // A redelivery that straddles an adapter rollout changes only the thread
    // serialization. Its canonical delivery identity must still deduplicate.
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyEmeaThread.thread,
      message: makeMessage({
        id: "1740000000200",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue after Microsoft moved the reply route",
      }),
      trigger: "subscribed_message",
    });

    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      externalThreadId: legacyThreadId,
      sessionGeneration: 1,
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya preserve this task across route changes" },
      { body: "continue after Microsoft moved the reply route" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(
      runtime.endpoints.get(endpoint.id)?.recordedMicrosoftTeamsRoutes,
    ).toEqual([
      { threadId: legacyThreadId, serviceUrl: amerServiceUrl },
      { threadId: canonicalThreadId, serviceUrl: emeaServiceUrl },
      { threadId: legacyEmeaThreadId, serviceUrl: emeaServiceUrl },
    ]);

    // Also cover the reverse rolling-upgrade direction: a canonical row must
    // accept a legacy callback without creating another task.
    await db
      .update(chatConversations)
      .set({ externalThreadId: canonicalThreadId, updatedAt: new Date() })
      .where(eq(chatConversations.id, conversations[0]!.id));
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: legacyEmeaThread.thread,
      message: makeMessage({
        id: "1740000000201",
        raw: {
          serviceUrl: emeaServiceUrl,
          from: { aadObjectId: "stable-teams-user" },
        },
        text: "continue from a rolling legacy process",
      }),
      trigger: "subscribed_message",
    });
    const afterReverseRollout = await service.listConversations(endpoint.id);
    expect(afterReverseRollout).toHaveLength(1);
    expect(afterReverseRollout[0]).toMatchObject({
      externalThreadId: canonicalThreadId,
      issueId: conversations[0]!.issueId,
    });
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversations[0]!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya preserve this task across route changes" },
      { body: "continue after Microsoft moved the reply route" },
      { body: "continue from a rolling legacy process" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  it("presents a fresh Teams personal generation after close and a regional route change", async () => {
    const fixture = await seedCompany();
    const f = await configuredTeamsEndpoint(fixture);
    try {
      const channel = "a:post-close-regional-personal";
      const rootMessageId = "1740000000299";
      const rooted = channel;
      const channelBase = `teams:${Buffer.from(channel).toString("base64url")}`;
      const threadBase = `teams:${Buffer.from(rooted).toString("base64url")}`;
      const oldRoute = Buffer.from(
        "https://smba.trafficmanager.net/amer/",
      ).toString("base64url");
      const oldThread = makeThread({
        id: `${threadBase}:${oldRoute}`,
        channelId: `${channelBase}:${oldRoute}`,
        isDM: true,
        name: "Regional post-close proof",
      }).thread;
      const currentThread = makeThread({
        id: threadBase,
        channelId: channelBase,
        isDM: true,
        name: "Regional post-close proof",
      }).thread;
      const controlTime = new Date(Date.now() - 10_000);
      const receive = async (
        thread: Thread,
        id: string,
        time: Date,
        text: string,
      ) => {
        await deliverMessage({
          callbacks: f.callbacks,
          endpointId: f.endpoint.id,
          provider: "microsoft-teams",
          thread,
          trigger: "direct_message",
          message: makeMessage({
            id,
            text,
            mentioned: true,
            userId: "teams-regional-author",
            raw: {
              timestamp: time.toISOString(),
              serviceUrl:
                thread.id === oldThread.id
                  ? "https://smba.trafficmanager.net/amer/"
                  : "https://smba.trafficmanager.net/emea/",
              from: { aadObjectId: "teams-regional-author" },
            },
          }),
        });
        return db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, f.endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${id}`,
            ),
          )
          .then((rows) => rows[0]!);
      };
      await receive(
        oldThread,
        rootMessageId,
        new Date(controlTime.getTime() - 1_000),
        "@maya begin the stable channel task",
      );
      await qualifySetupRoundTrip(
        f.service,
        f.endpoint.id,
        "teams-regional-author",
      );
      await f.service.test(f.endpoint.id);
      const [original] = await f.service.listConversations(f.endpoint.id);
      await receive(oldThread, "teams-regional-close", controlTime, "/close");
      await f.service.processPendingPublications();
      expect((await f.service.listConversations(f.endpoint.id))[0]?.state).toBe(
        "completed",
      );
      const delivery = await receive(
        currentThread,
        "teams-regional-fresh",
        new Date(),
        "@maya answer this fresh request on the current route",
      );
      expect(delivery.state).toBe("processed");
      expect(delivery.conversationId).not.toBe(original.id);
      const current = (await f.service.listConversations(f.endpoint.id)).find(
        (row) => row.id === delivery.conversationId,
      )!;
      expect(current).toMatchObject({
        state: "active",
        externalThreadId: currentThread.id,
        sessionGeneration: original.sessionGeneration + 1,
      });
      expect(current.issueId).not.toBe(original.issueId);
      const context = await chatWakeContext({
        endpointId: f.endpoint.id,
        issueId: current.issueId,
        provider: "microsoft-teams",
        providerMessageId: "teams-regional-fresh",
      });
      const [action] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.deliveryId, delivery.id),
            eq(chatActions.kind, "inbound_wakeup"),
          ),
        );
      expect(action?.status).toBe("processed");
      const runId = randomUUID();
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId: fixture.companyId,
          agentId: fixture.assignedAgentId,
          nativeIssueId: current.issueId,
          runtimeMode: "native",
          status: "running",
          startedAt: new Date(),
          wakeupRequestId: action!.id,
          contextSnapshot: {
            ...context,
            endpointId: f.endpoint.id,
            paperclipHarnessCheckedOut: true,
          },
        });
      await db
        .update(agentWakeupRequests)
        .set({ runId, status: "claimed" })
        .where(eq(agentWakeupRequests.id, action!.id));
      await expect(
        resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: current.issueId,
          runId,
        }),
      ).resolves.toBe("allow_chat_run_presentation");
    } finally {
      await retirePublicationFixture(f.service, f.endpoint.id);
    }
  });

  it("applies the Teams direct-message reach toggle and starts a new generation after task completion", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    const directThread = makeThread({
      channelId: "teams-personal-reach",
      id: "teams:personal-reach",
      isDM: true,
      name: "Teams personal reach",
    });
    const providerTimestamp = "2026-09-05T18:15:00.000Z";
    const send = (id: string, text: string) =>
      deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: directThread.thread,
        message: makeMessage({
          id,
          raw: {
            from: { aadObjectId: "6c4dd0ef-f027-4b75-93d9-04d97424220e" },
            timestamp: providerTimestamp,
          },
          text,
          userId: "29:teams-direct-reach",
        }),
        trigger: "direct_message",
      });

    await service.update(
      endpoint.id,
      { allowDirectMessages: false },
      "owner-user",
    );
    await send("teams-direct-disabled", "This must remain outside Paperclip");
    expect(await service.listConversations(endpoint.id)).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
    await expect(
      db
        .select({
          state: chatDeliveries.state,
          redactedError: chatDeliveries.redactedError,
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id)),
    ).resolves.toEqual([
      {
        state: "filtered",
        redactedError: "Destination is not enabled in Paperclip",
        normalizedEvent: expect.objectContaining({
          providerEventId: `${directThread.thread.id}:teams-direct-disabled`,
          kind: "direct_message",
          trigger: "direct_message",
          resource: {
            type: "direct_message",
            providerResourceId: "teams-personal-reach",
          },
          conversation: { externalThreadId: directThread.thread.id },
          message: {
            providerMessageId: "teams-direct-disabled",
            providerSentAt: providerTimestamp,
          },
          filtering: { contentRetained: false },
        }),
        principalId: null,
      },
    ]);
    const disabledDelivery = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(eq(chatDeliveries.endpointId, endpoint.id))
      .then((rows) => rows[0]);
    expect(JSON.stringify(disabledDelivery)).not.toContain(
      "This must remain outside Paperclip",
    );
    expect(JSON.stringify(disabledDelivery)).not.toContain(
      "6c4dd0ef-f027-4b75-93d9-04d97424220e",
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);

    await service.update(
      endpoint.id,
      { allowDirectMessages: true },
      "owner-user",
    );
    await send("teams-direct-first", "Start the first direct-message task");
    const [firstConversation] = await service.listConversations(endpoint.id);
    expect(firstConversation).toMatchObject({
      isDirectMessage: true,
      sessionGeneration: 1,
      state: "active",
    });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, firstConversation!.issueId));

    await send("teams-direct-second", "Start a fresh task after completion");
    const conversations = await service.listConversations(endpoint.id);
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find(
        (conversation) => conversation.id === firstConversation!.id,
      ),
    ).toMatchObject({
      issueId: firstConversation!.issueId,
      sessionGeneration: 1,
      state: "completed",
    });
    const nextConversation = conversations.find(
      (conversation) => conversation.id !== firstConversation!.id,
    );
    expect(nextConversation).toMatchObject({
      sessionGeneration: 2,
      state: "active",
    });
    expect(nextConversation!.issueId).not.toBe(firstConversation!.issueId);
    expect(
      new Set(conversations.map((conversation) => conversation.issueId)).size,
    ).toBe(2);
    expect(wakeup).toHaveBeenCalledTimes(2);
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
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      1,
    );
    const disabledChannelDelivery = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${channelRootId}`,
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(disabledChannelDelivery).toMatchObject({
      state: "filtered",
      attempts: 0,
      principalId: null,
      normalizedEvent: {
        filtering: { contentRetained: false },
        message: { providerMessageId: channelRootId },
      },
    });
    expect(
      JSON.stringify(disabledChannelDelivery?.normalizedEvent),
    ).not.toContain("channel still requires enablement");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
            eq(chatExternalPrincipals.externalId, "U-TEAMS-DISABLED-CHANNEL"),
          ),
        ),
    ).resolves.toHaveLength(0);

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
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "mention",
    });
    await expect(service.listConversations(endpoint.id)).resolves.toHaveLength(
      2,
    );
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: `${channelRootId}-reply`,
        text: "continue the now-authorized Teams task",
        userId: "U-TEAMS-DISABLED-CHANNEL",
        userName: "disabled-channel-user",
      }),
      trigger: "subscribed_message",
    });
    const channelConversation = (
      await service.listConversations(endpoint.id)
    ).find(
      (conversation) =>
        conversation.externalThreadId === channelThread.thread.id,
    );
    if (!channelConversation)
      throw new Error("Expected enabled Teams channel conversation");
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, channelConversation.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya channel is enabled now" },
      { body: "continue the now-authorized Teams task" },
    ]);
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, fixture.companyId),
            eq(chatExternalPrincipals.provider, "microsoft-teams"),
            eq(chatExternalPrincipals.externalId, "U-TEAMS-DISABLED-CHANNEL"),
          ),
        ),
    ).resolves.toHaveLength(1);
  });

  it("atomically rejects Teams messages when DM, group, or channel reach is revoked at the task-mutation boundary", async () => {
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const scenarios = [
      { kind: "direct_message" as const, label: "direct" },
      { kind: "group_chat" as const, label: "group" },
      { kind: "channel" as const, label: "channel" },
    ];

    for (const scenario of scenarios) {
      const fixture = await seedCompany();
      let releaseReachCheck!: () => void;
      let signalReachCheck!: () => void;
      const reachCheckEntered = new Promise<void>((resolve) => {
        signalReachCheck = resolve;
      });
      const reachCheckReleased = new Promise<void>((resolve) => {
        releaseReachCheck = resolve;
      });
      const { callbacks, endpoint, service, wakeup } =
        await configuredTeamsEndpoint(fixture, {
          reachAuthorizationBarrier: async () => {
            signalReachCheck();
            await reachCheckReleased;
          },
        });

      const conversationId =
        scenario.kind === "group_chat"
          ? `19:teams-revoke-${scenario.label}@unq.gbl.spaces`
          : scenario.kind === "channel"
            ? `19:teams-revoke-${scenario.label}@thread.tacv2`
            : `teams-revoke-${scenario.label}`;
      const rootMessageId = `teams-revoke-${scenario.label}-message`;
      const encodedConversationId =
        Buffer.from(conversationId).toString("base64url");
      const encodedServiceUrl = Buffer.from(serviceUrl).toString("base64url");
      const thread = makeThread({
        channelId:
          scenario.kind === "direct_message"
            ? conversationId
            : `teams:${encodedConversationId}:${encodedServiceUrl}`,
        id:
          scenario.kind === "channel"
            ? `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${encodedServiceUrl}`
            : scenario.kind === "group_chat"
              ? `teams:${encodedConversationId}:${encodedServiceUrl}`
              : `teams:${conversationId}`,
        isDM: scenario.kind === "direct_message",
        name: `Revoked ${scenario.label}`,
      });
      const durableThreadId =
        scenario.kind === "channel"
          ? `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}`
          : scenario.kind === "group_chat"
            ? `teams:${encodedConversationId}`
            : thread.thread.id;
      let resourceId: string | null = null;
      if (scenario.kind !== "direct_message") {
        const [resource] = await db
          .insert(chatEndpointResources)
          .values({
            companyId: fixture.companyId,
            endpointId: endpoint.id,
            type: scenario.kind,
            providerResourceId: conversationId,
            label: `Revoked ${scenario.label}`,
            availability: "available",
            enabled: true,
          })
          .returning({ id: chatEndpointResources.id });
        resourceId = resource!.id;
      }
      if (scenario.kind === "group_chat") {
        await service.update(
          endpoint.id,
          { allowGroupChats: true },
          "owner-user",
        );
      }

      const externalPrincipalId = randomUUID();
      const secretText = `must-not-persist-${scenario.label}`;
      const send = deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: thread.thread,
        message: makeMessage({
          id: rootMessageId,
          raw: { from: { aadObjectId: externalPrincipalId } },
          text: `@maya ${secretText}`,
          mentioned: scenario.kind !== "direct_message",
          userId: `29:teams-revoke-${scenario.label}`,
        }),
        trigger:
          scenario.kind === "direct_message" ? "direct_message" : "mention",
      });

      await reachCheckEntered;
      if (scenario.kind === "direct_message") {
        await service.update(
          endpoint.id,
          { allowDirectMessages: false },
          "owner-user",
        );
      } else if (scenario.kind === "group_chat") {
        await service.update(
          endpoint.id,
          { allowGroupChats: false },
          "owner-user",
        );
      } else {
        await service.replaceResources(endpoint.id, [
          { id: resourceId!, enabled: false },
        ]);
      }
      releaseReachCheck();
      await send;

      await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, fixture.companyId)),
      ).resolves.toEqual([]);
      const [delivery] = await db
        .select({
          state: chatDeliveries.state,
          normalizedEvent: chatDeliveries.normalizedEvent,
          principalId: chatDeliveries.principalId,
          redactedError: chatDeliveries.redactedError,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(
              chatDeliveries.providerEventId,
              `${durableThreadId}:${rootMessageId}`,
            ),
          ),
        );
      expect(delivery).toMatchObject({
        state: "filtered",
        principalId: null,
        redactedError: "Destination is not enabled in Paperclip",
        normalizedEvent: {
          filtering: { contentRetained: false },
          message: { providerMessageId: rootMessageId },
        },
      });
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        secretText,
      );
      expect(JSON.stringify(delivery?.normalizedEvent)).not.toContain(
        externalPrincipalId,
      );
      await expect(
        db
          .select({ id: chatExternalPrincipals.id })
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, fixture.companyId),
              eq(chatExternalPrincipals.provider, "microsoft-teams"),
              eq(chatExternalPrincipals.externalId, externalPrincipalId),
            ),
          ),
      ).resolves.toEqual([]);
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("audits Microsoft Teams reactions idempotently without treating them as task instructions", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, runtime, service, wakeup } =
      await configuredTeamsEndpoint(fixture);
    const aadObjectId = "860def28-0dab-44ae-b8cf-30e168181a15";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const thread = makeThread({
      channelId: "teams-personal-reactions",
      id: "teams:personal-reactions:root-1",
      isDM: true,
      name: "Teams personal reactions",
    });
    const original = makeMessage({
      id: "teams-reaction-root",
      raw: { from: { aadObjectId } },
      text: "Observe Teams reactions",
      userId: "29:teams-reaction-session",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: original,
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, original.author.userId);
    await service.test(endpoint.id);
    if (!callbacks.onReaction)
      throw new Error("Teams reaction callback was not registered");
    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Teams endpoint runtime");
    const initialRouteCount =
      endpointRuntime.recordedMicrosoftTeamsRoutes.length;
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const commentCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation!.issueId))
      .then((rows) => rows.length);
    const wakeupCount = wakeup.mock.calls.length;
    const emoji = {
      name: "thumbs_up",
      toJSON: () => "like",
      toString: () => "like",
    };
    const reaction = (
      added: boolean,
      activityId: string,
      reactionThread = thread.thread,
    ) => ({
      endpointId: endpoint.id,
      provider: "microsoft-teams" as const,
      event: {
        adapter: {} as never,
        added,
        emoji,
        message: original,
        messageId: original.id,
        raw: { id: activityId, serviceUrl, from: { aadObjectId } },
        rawEmoji: "like",
        thread: reactionThread,
        threadId: reactionThread.id,
        user: original.author,
      },
    });

    const unknownThread = makeThread({
      channelId: "teams-personal-reactions-unknown",
      id: "teams:personal-reactions:unknown-root",
      isDM: true,
      name: "Unknown Teams personal reactions",
    });
    await callbacks.onReaction(
      reaction(true, "teams-reaction-denied", unknownThread.thread),
    );
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes).toHaveLength(
      initialRouteCount,
    );

    await callbacks.onReaction(reaction(true, "teams-reaction-1"));
    await callbacks.onReaction(reaction(true, "teams-reaction-1"));
    await callbacks.onReaction(reaction(false, "teams-reaction-2"));

    const reactions = await db
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.conversationId, conversation!.id))
      .then((rows) =>
        rows.filter((row) => row.eventKind.startsWith("reaction_")),
      );
    expect(reactions).toHaveLength(2);
    expect(reactions.map((row) => row.eventKind).sort()).toEqual([
      "reaction_added",
      "reaction_removed",
    ]);
    expect(reactions.every((row) => row.principalId !== null)).toBe(true);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .then((rows) => rows.length),
    ).toBe(commentCount);
    expect(wakeup).toHaveBeenCalledTimes(wakeupCount);
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes.length).toBeGreaterThan(
      initialRouteCount,
    );
    expect(
      (await service.listActivity(endpoint.id)).filter((item) =>
        item.summary.startsWith("reaction "),
      ),
    ).toHaveLength(2);
  });

  it("keeps case-variant Teams Entra object ids on one external principal", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint } = await configuredTeamsEndpoint(fixture);
    const aadObjectId = "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4";
    const thread = makeThread({
      channelId: "teams-personal-identity",
      id: "teams:personal-identity:root-1",
      isDM: true,
      name: "Alex External",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-identity-root",
        raw: { from: { aadObjectId: aadObjectId.toUpperCase() } },
        text: "Start a Teams identity task",
        userId: "29:adapter-session-one",
      }),
      trigger: "direct_message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: makeMessage({
        id: "teams-identity-follow-up",
        raw: { from: { aadObjectId } },
        text: "Continue from another adapter session",
        userId: "29:adapter-session-two",
      }),
      trigger: "direct_message",
    });

    const principals = await db
      .select({ externalId: chatExternalPrincipals.externalId })
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, fixture.companyId),
          eq(chatExternalPrincipals.provider, "microsoft-teams"),
        ),
      );
    expect(principals).toEqual([{ externalId: aadObjectId }]);
    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { body: "Start a Teams identity task" },
        { body: "Continue from another adapter session" },
      ]),
    );
  });

  describe("Teams inline picture publication", () => {
    it.each([
      { surface: "channel", outcome: "native" },
      { surface: "group", outcome: "native" },
      { surface: "channel", outcome: "native_http" },
      { surface: "group", outcome: "native_http" },
      { surface: "channel", outcome: "long_native_http" },
      { surface: "channel", outcome: "malformed" },
      { surface: "channel", outcome: "too_large" },
      { surface: "channel", outcome: "dimensions" },
      { surface: "channel", outcome: "source_deleted" },
      { surface: "group", outcome: "reach_revoked" },
      { surface: "channel", outcome: "lost_receipt" },
      { surface: "channel", outcome: "empty_receipt" },
    ] as const)(
      "keeps $surface picture delivery truthful for $outcome",
      async ({ surface, outcome }) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { callbacks, endpoint, runtime, service } =
          await configuredTeamsEndpoint(fixture, { storage: storage.storage });
        let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
        try {
          if (surface === "group") {
            await service.update(
              endpoint.id,
              { allowGroupChats: true },
              "owner-user",
            );
          }
          const serviceUrl = "https://smba.trafficmanager.net/amer/";
          const conversationId = `19:inline-picture-${surface}-${randomUUID()}@thread.${surface === "channel" ? "tacv2" : "v2"}`;
          const rootId = "1740000000491";
          const providerThread = makeThread({
            channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
            id: `teams:${Buffer.from(surface === "channel" ? `${conversationId};messageid=${rootId}` : conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
            name: "Teams picture qualification",
          });
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "microsoft-teams",
            thread: providerThread.thread,
            message: makeMessage({
              id: rootId,
              text: "@Maya inspect pictures here",
              mentioned: true,
            }),
            trigger: "mention",
          });
          const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
          expect(conversation).toBeDefined();
          const body =
            outcome === "malformed"
              ? Buffer.from("not a PNG")
              : outcome === "too_large"
                ? Buffer.alloc(1_000_001)
                : await sharp({
                    create: {
                      width: outcome === "dimensions" ? 1025 : 2,
                      height: 2,
                      channels: 4,
                      background: { r: 50, g: 100, b: 150, alpha: 1 },
                    },
                  })
                    .png()
                    .toBuffer();
          const stored = await storage.storage.putFile({
            companyId: fixture.companyId,
            namespace: `issues/${conversation!.issueId}`,
            originalFilename: "teams-picture.png",
            contentType: "image/png",
            body,
          });
          const attachment = await issueService(db).createAttachment({
            issueId: conversation!.issueId,
            ...stored,
            createdByUserId: "owner-user",
          });
          await service.processPendingPublications();
          const providerRuntime = runtime.endpoints.get(endpoint.id)!;
          const httpBodies: Array<{ url: string; body: unknown }> = [];
          const boardText =
            outcome === "long_native_http"
              ? "x".repeat(99_996) + "TAIL"
              : "Share this picture.";
          if (outcome === "native_http" || outcome === "long_native_http") {
            pinned = createChatSdkEndpointRuntime({
              ...runtime.configurations.get(endpoint.id)!,
              logger: "silent",
              callbacks: { onMessage() {} },
            });
            await pinned.initialize();
            const app = (
              pinned.getProviderAdapter() as unknown as {
                app: {
                  activitySender: {
                    client: {
                      post(
                        url: string,
                        body: unknown,
                      ): Promise<{ data: unknown }>;
                    };
                  };
                };
              }
            ).app;
            vi.spyOn(app.activitySender.client, "post").mockImplementation(
              async (url, body) => {
                httpBodies.push({ url, body });
                return {
                  data: { id: `teams-http-receipt-${httpBodies.length}` },
                };
              },
            );
          }
          const originalThread = providerRuntime.thread.bind(providerRuntime);
          let pictureAttempts = 0;
          let textSent = false;
          vi.spyOn(providerRuntime, "thread").mockImplementation((id) => {
            const target = originalThread(id);
            return {
              ...target,
              post: async (message: unknown) => {
                const sent = await target.post(message);
                const hasFiles = Boolean(
                  message && typeof message === "object" && "files" in message,
                );
                if (hasFiles) {
                  pictureAttempts++;
                  if (outcome === "lost_receipt")
                    throw new Error(
                      "Simulated picture response lost after acceptance",
                    );
                  if (outcome === "empty_receipt") return { ...sent, id: "" };
                } else if (!textSent) {
                  textSent = true;
                  // Mutate after the Board text's provider effect, before the
                  // separately ordered picture row claims its own authority.
                  if (outcome === "source_deleted") {
                    await db
                      .delete(issueAttachments)
                      .where(eq(issueAttachments.id, attachment.id));
                  }
                  if (outcome === "reach_revoked") {
                    await db
                      .update(chatEndpointResources)
                      .set({ availability: "unavailable" })
                      .where(
                        eq(chatEndpointResources.id, conversation!.resourceId!),
                      );
                  }
                }
                return pinned
                  ? await pinned
                      .thread(id)
                      .post(
                        message as Parameters<
                          ReturnType<typeof pinned.thread>["post"]
                        >[0],
                      )
                  : sent;
              },
            };
          });
          const result = await service.publishBoardMessage(
            endpoint.id,
            conversation!.id,
            boardText,
            `teams-inline-picture-${surface}`,
            "owner-user",
            [attachment.id],
          );
          const denied = ["source_deleted", "reach_revoked"].includes(outcome);
          const ambiguous = ["lost_receipt", "empty_receipt"].includes(outcome);
          const fallback = ["malformed", "too_large", "dimensions"].includes(
            outcome,
          );
          if (denied) expect(["failed", "cancelled"]).toContain(result.state);
          else
            expect(result.state).toBe(
              ambiguous ? "delivery_unknown" : "published",
            );
          const imagePosts = (
            runtime.endpoints.get(endpoint.id)?.posts ?? []
          ).filter((post) => post.files?.length);
          expect(imagePosts).toHaveLength(denied || fallback ? 0 : 1);
          if (!denied && !fallback) {
            expect(imagePosts[0]!.threadId).toBe(
              conversation!.externalThreadId,
            );
            expect(imagePosts[0]!.files).toEqual([
              {
                data: body,
                filename: "teams-picture.png",
                mimeType: "image/png",
              },
            ]);
            expect(imagePosts[0]!.text).not.toContain("isn't available");
          }
          if (fallback) {
            expect(
              providerRuntime.posts.some((post) =>
                post.text.includes("Direct file delivery isn't available"),
              ),
            ).toBe(true);
            if (outcome === "too_large")
              expect(storage.storage.getObject).not.toHaveBeenCalled();
          }
          const [publication] = await readChatPublicationsById(result.id);
          if (!denied)
            expect(publication).toMatchObject({
              state: ambiguous ? "delivery_unknown" : "published",
              attempts: 1,
            });
          if (!denied && !ambiguous)
            expect(publication!.providerMessageId).toBeTruthy();
          if (outcome === "native_http" || outcome === "long_native_http") {
            if (outcome === "native_http") expect(httpBodies).toHaveLength(2);
            else {
              expect(httpBodies.length).toBeGreaterThan(2);
              expect(
                providerRuntime.posts
                  .slice(0, -1)
                  .map((post) => post.text)
                  .join(""),
              ).toBe(boardText);
              expect(providerRuntime.posts.at(-1)!.files).toHaveLength(1);
            }
            const pictureRequest = httpBodies.at(-1)!;
            expect(pictureRequest.url).toBe(
              `https://smba.trafficmanager.net/amer/v3/conversations/${surface === "channel" ? `${conversationId};messageid=${rootId}` : conversationId}/activities`,
            );
            expect(pictureRequest.body).toMatchObject({
              type: "message",
              attachments: [
                {
                  name: "teams-picture.png",
                  contentType: "image/png",
                  contentUrl: `data:image/png;base64,${body.toString("base64")}`,
                },
              ],
            });
            expect(JSON.stringify(pictureRequest.body)).not.toMatch(
              /file\.consent|teams-test-secret/,
            );
            expect(publication!.providerMessageId).toBe(
              `teams-http-receipt-${httpBodies.length}`,
            );
          }
          if (ambiguous) expect(publication!.providerMessageId).toBeNull();
          await expect(
            db
              .select()
              .from(chatTeamsFileTransfers)
              .where(eq(chatTeamsFileTransfers.endpointId, endpoint.id)),
          ).resolves.toEqual([]);
          const sentCount = runtime.endpoints.get(endpoint.id)!.posts.length;
          await service.publishBoardMessage(
            endpoint.id,
            conversation!.id,
            boardText,
            `teams-inline-picture-${surface}`,
            "owner-user",
            [attachment.id],
          );
          expect(runtime.endpoints.get(endpoint.id)!.posts).toHaveLength(
            sentCount,
          );
          await service.processPendingPublications();
          expect(providerRuntime.posts).toHaveLength(sentCount);
          expect(pictureAttempts).toBe(denied || fallback ? 0 : 1);
        } finally {
          await service.configure(
            endpoint.id,
            { action: "remove" },
            "owner-user",
          );
          await service.shutdown();
          await pinned?.shutdown();
        }
      },
    );
  });

  it("links outbound Teams files instead of attempting an unsupported native upload", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
      });
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const channelConversationId = "19:teams-outbound-files@thread.tacv2";
    const channelMessageId = "1740000000291";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Outbound files channel",
    });
    const personalMessageId = "teams-outbound-personal-root";
    const personalThread = makeThread({
      channelId: "teams-personal-outbound-files",
      id: "teams:personal-outbound-files:root-1",
      isDM: true,
      name: "Alex External",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        id: channelMessageId,
        text: "@Maya create a channel report",
        mentioned: true,
      }),
      trigger: "mention",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: personalThread.thread,
      message: makeMessage({
        id: personalMessageId,
        text: "Create a personal report",
      }),
      trigger: "direct_message",
    });
    const conversations = await readChatConversationsByEndpointId(endpoint.id);
    const channelConversation = conversations.find(
      (conversation) => !conversation.isDirectMessage,
    );
    const personalConversation = conversations.find(
      (conversation) => conversation.isDirectMessage,
    );
    if (!channelConversation || !personalConversation)
      throw new Error("Expected Teams channel and personal tasks");

    for (const item of [
      {
        conversation: channelConversation,
        filename: "channel-report.txt",
        providerMessageId: channelMessageId,
        text: "Channel report ready.",
      },
      {
        conversation: personalConversation,
        filename: "personal-report.txt",
        providerMessageId: personalMessageId,
        text: "Personal report ready.",
      },
    ]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        status: "succeeded",
        contextSnapshot: await chatWakeContext({
          endpointId: endpoint.id,
          issueId: item.conversation.issueId,
          provider: "microsoft-teams",
          providerMessageId: item.providerMessageId,
        }),
      });
      const comment = await addSelectedChatFinal({
        agentId: fixture.assignedAgentId,
        body: item.text,
        companyId: fixture.companyId,
        issueId: item.conversation.issueId,
        runId,
      });
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${item.conversation.issueId}`,
        originalFilename: item.filename,
        contentType: "text/plain",
        body: Buffer.from(`${item.filename} contents`, "utf8"),
      });
      await issueService(db).createAttachment({
        issueId: item.conversation.issueId,
        issueCommentId: comment.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: fixture.assignedAgentId,
        createdByRunId: runId,
      });
    }
    await service.processPendingPublications();

    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    const channelAttachmentPost = posts.find((post) =>
      post.text.includes(
        "File saved on the Paperclip task: channel-report.txt.",
      ),
    );
    expect(channelAttachmentPost?.text).toContain(
      "Direct file delivery isn't available for this Teams conversation.",
    );
    expect(channelAttachmentPost?.text).toContain(
      `/issues/${channelConversation.issueId}`,
    );
    expect(channelAttachmentPost?.files).toBeUndefined();
    const personalAttachmentPost = posts.find((post) =>
      post.text.includes(
        "File saved on the Paperclip task: personal-report.txt.",
      ),
    );
    expect(personalAttachmentPost?.text).toContain(
      "Direct file delivery isn't available for this Teams conversation.",
    );
    expect(personalAttachmentPost?.text).toContain(
      `/issues/${personalConversation.issueId}`,
    );
    expect(personalAttachmentPost?.files).toBeUndefined();
    expect(storage.storage.getObject).not.toHaveBeenCalled();
  });

  describe("Teams authenticated inline-picture intake", () => {
    it.each([
      ["channel", "current"],
      ["groupChat", "current"],
      ["channel", "restart"],
      ["groupChat", "restart"],
      ["channel", "revoked_after_receipt"],
      ["groupChat", "revoked_after_receipt"],
      ["groupChat", "revoked_during_download"],
      ["groupChat", "source_updated_during_download"],
      ["groupChat", "source_deleted_during_download"],
      ["groupChat", "batch_deadline"],
    ] as const)(
      "ingests an actual pinned-parser %s picture into its exact admitted turn (%s)",
      async (conversationType, mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { callbacks, endpoint, runtime, service, wakeup } =
          await configuredTeamsEndpoint(fixture, {
            storage: storage.storage,
            deferWebhookProcessing:
              mode === "restart" || mode === "revoked_after_receipt",
            scheduleDeferredWork: () => undefined,
          });
        const configuration = runtime.configurations.get(endpoint.id)!;
        if (configuration.providerConfig.provider !== "microsoft-teams")
          throw new Error("Expected Teams configuration");
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const image = await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#224466" },
        })
          .png()
          .toBuffer();
        const url =
          "https://smba.trafficmanager.net/amer/v3/attachments/inline-fixture/views/original";
        const http = (
          pinned.getProviderAdapter() as unknown as {
            app: {
              api: { http: { get: (...args: unknown[]) => Promise<unknown> } };
            };
          }
        ).app.api.http;
        const get = vi.spyOn(http, "get").mockResolvedValue({ data: image });
        let restarted: ReturnType<typeof createService> | undefined;
        let recoveredParser:
          ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
        let recoveredGet: ReturnType<typeof vi.spyOn> | undefined;
        let lifecycleCompletion: Promise<unknown> | undefined;
        let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
          if (conversationType === "groupChat")
            await service.update(
              endpoint.id,
              { allowGroupChats: true },
              "owner-user",
            );
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
            fetchTeamsInlineImage: pinned.fetchTeamsInlineImage.bind(pinned),
          });
          const message = pinned.parseMicrosoftTeamsMessage({
            type: "message",
            channelId: "msteams",
            id: "1740000000771",
            timestamp: new Date().toISOString(),
            text: "Inspect this exact picture",
            serviceUrl: "https://smba.trafficmanager.net/amer/",
            from: {
              id: "29:inline-picture-user",
              aadObjectId: randomUUID(),
              name: "Picture User",
            },
            recipient: {
              id: `28:${configuration.providerConfig.credentials.appId}`,
            },
            conversation: {
              id: `19:inline-picture-${conversationType}@thread.tacv2${conversationType === "channel" ? ";messageid=1740000000771" : ""}`,
              conversationType,
              tenantId: configuration.providerConfig.credentials.appTenantId,
            },
            attachments: [
              { contentType: "image/png", contentUrl: url, name: "inline.png" },
            ],
          })!;
          expect(message.attachments[0]).toMatchObject({
            type: "image",
            mimeType: "image/png",
            fetchMetadata: { auth: "bot" },
          });
          const thread = makeThread({
            id: message.threadId,
            channelId: message.threadId,
            isDM: false,
          });
          if (mode === "batch_deadline") {
            const raw = message.raw as {
              attachments: Array<Record<string, unknown>>;
            };
            raw.attachments.push({
              contentType: "image/png",
              contentUrl: url.replace("inline-fixture", "inline-second"),
              name: "second.png",
            });
            const second =
              pinned.parseMicrosoftTeamsMessage(raw)!.attachments[1]!;
            message.attachments.push(second);
            const budget = new AbortController();
            const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
            timeoutSpy = vi
              .spyOn(AbortSignal, "timeout")
              .mockImplementation((ms) =>
                ms === 10_000 ? budget.signal : originalTimeout(ms),
              );
            get.mockImplementation(async () => {
              budget.abort();
              throw new Error("Synthetic exhausted image batch budget");
            });
          }
          if (mode === "revoked_during_download") {
            get.mockImplementation(async () => {
              await db
                .update(chatEndpoints)
                .set({ allowGroupChats: false })
                .where(eq(chatEndpoints.id, endpoint.id));
              return { data: image };
            });
          }
          if (mode.startsWith("source_")) {
            get.mockImplementation(async () => {
              const updated = pinned.parseMicrosoftTeamsMessage({
                ...(message.raw as object),
                text: "Corrected source without that image",
                attachments: [],
              })!;
              lifecycleCompletion = Promise.resolve(
                mode === "source_updated_during_download"
                  ? callbacks.onMessageUpdated!({
                      endpointId: endpoint.id,
                      provider: "microsoft-teams",
                      thread: thread.thread,
                      message: updated,
                    })
                  : callbacks.onMessageDeleted!({
                      endpointId: endpoint.id,
                      provider: "microsoft-teams",
                      event: {
                        adapter: thread.thread.adapter,
                        channelId: thread.thread.channelId,
                        platform: "teams",
                        messageId: message.id,
                        threadId: thread.thread.id,
                        raw: message.raw,
                        deletedAt: new Date(),
                      },
                    }),
              ).catch((error: unknown) => error);
              // The authenticated service callback records before waiting for
              // this turn's drain. Observe that durable pending source event.
              await vi.waitFor(async () => {
                const rows = await db
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(
                    and(
                      eq(chatDeliveries.endpointId, endpoint.id),
                      eq(
                        chatDeliveries.eventKind,
                        mode === "source_updated_during_download"
                          ? "message_updated"
                          : "message_deleted",
                      ),
                    ),
                  );
                expect(rows).toEqual([{ state: "received" }]);
              });
              return { data: image };
            });
          }
          // Actual parser + durable service. Provider HTTP, outer authenticated
          // callback delivery, and native scheduler are explicitly simulated.
          const deliver = () =>
            deliverMessage({
              callbacks,
              endpointId: endpoint.id,
              provider: "microsoft-teams",
              thread: thread.thread,
              message,
              trigger: "mention",
            });
          if (mode === "revoked_during_download")
            await expect(deliver()).rejects.toThrow(
              "no longer authorized to start work",
            );
          else if (mode.startsWith("source_"))
            await expect(deliver()).rejects.toThrow("admitted source changed");
          else await deliver();
          await lifecycleCompletion;
          if (mode === "restart" || mode === "revoked_after_receipt") {
            const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
            expect(received).toMatchObject({ state: "received", attempts: 0 });
            expect(get).not.toHaveBeenCalled();
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(
              JSON.stringify(received.normalizedEvent.message),
            ).not.toContain("https://");
            expect(received.normalizedEvent).toMatchObject({
              message: {
                attachments: [
                  {
                    recovery: {
                      locator: {
                        kind: "teams_inline_image",
                        messageId: message.id,
                      },
                    },
                  },
                ],
              },
            });
            await service.shutdown();
            recoveredParser = createChatSdkEndpointRuntime({
              ...configuration,
              logger: "silent",
            });
            const nextHttp = (
              recoveredParser.getProviderAdapter() as unknown as {
                app: {
                  api: { http: { get(...args: unknown[]): Promise<unknown> } };
                };
              }
            ).app.api.http;
            recoveredGet = vi
              .spyOn(nextHttp, "get")
              .mockResolvedValue({ data: image });
            const nextRuntime = new FakeChatSdkRuntime();
            const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
            vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
              async (options) => {
                const next = await replace(options);
                Object.assign(next, {
                  attachmentRecoveryDescriptor:
                    recoveredParser!.attachmentRecoveryDescriptor.bind(
                      recoveredParser,
                    ),
                  rehydrateAttachment:
                    recoveredParser!.rehydrateAttachment.bind(recoveredParser),
                  fetchTeamsInlineImage:
                    recoveredParser!.fetchTeamsInlineImage.bind(
                      recoveredParser,
                    ),
                });
                const originalThread = next.thread.bind(next);
                vi.spyOn(next, "thread").mockImplementation((id) => ({
                  ...originalThread(id),
                  isDM: false,
                }));
                return next;
              },
            );
            if (mode === "revoked_after_receipt") {
              if (conversationType === "groupChat")
                await db
                  .update(chatEndpoints)
                  .set({ allowGroupChats: false })
                  .where(eq(chatEndpoints.id, endpoint.id));
              else
                await db
                  .update(chatEndpointResources)
                  .set({ enabled: false })
                  .where(eq(chatEndpointResources.endpointId, endpoint.id));
              // Leave verifying mode so restart cannot legitimately activate a
              // first setup channel after this explicit operator revocation.
              await db
                .update(chatEndpoints)
                .set({ status: "active" })
                .where(eq(chatEndpoints.id, endpoint.id));
            }
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, received.id));
            restarted = createService(nextRuntime, undefined, {
              storage: storage.storage,
              scheduleDeferredWork: () => undefined,
            });
            await restarted.service.processPendingDeliveries(25, received.id);
            expect(get).not.toHaveBeenCalled();
          }
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.eventKind, "mention"),
              ),
            );
          if (mode === "batch_deadline") {
            expect(delivery.state).toBe("processed");
            expect(delivery.redactedError).toContain(
              "2 external attachments were omitted",
            );
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(get).toHaveBeenCalledOnce();
            expect(wakeup).toHaveBeenCalledOnce();
            await expect(
              db
                .select({ id: issueAttachments.id })
                .from(issueAttachments)
                .where(eq(issueAttachments.companyId, fixture.companyId)),
            ).resolves.toHaveLength(0);
            return;
          }
          if (mode.startsWith("revoked_") || mode.startsWith("source_")) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(restarted?.wakeup ?? wakeup).not.toHaveBeenCalled();
            expect(delivery.state).toBe(
              mode === "revoked_after_receipt" ? "filtered" : "failed",
            );
            if (mode === "revoked_after_receipt")
              expect(recoveredGet).not.toHaveBeenCalled();
            else expect(get).toHaveBeenCalledOnce();
            await expect(
              db
                .select({ id: issueAttachments.id })
                .from(issueAttachments)
                .where(eq(issueAttachments.companyId, fixture.companyId)),
            ).resolves.toHaveLength(0);
            return;
          }
          expect({
            state: delivery.state,
            error: delivery.redactedError,
          }).toEqual({ state: "processed", error: null });
          expect(storage.putFile).toHaveBeenCalledOnce();
          expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
            body: image,
            contentType: "image/png",
          });
          const download = recoveredGet ?? get;
          expect(download).toHaveBeenCalledOnce();
          expect(download.mock.calls[0]![0]).toBe(url);
          expect(restarted?.wakeup ?? wakeup).toHaveBeenCalledOnce();
          expect(delivery).toMatchObject({
            state: "processed",
            redactedError: null,
          });
          expect(
            JSON.stringify(delivery.normalizedEvent.message),
          ).not.toContain("https://");
          await expect(
            db
              .select({ id: issueAttachments.id })
              .from(issueAttachments)
              .where(eq(issueAttachments.companyId, fixture.companyId)),
          ).resolves.toHaveLength(1);
          await (restarted?.service ?? service).processPendingDeliveries(
            25,
            delivery.id,
          );
          expect(download).toHaveBeenCalledOnce();
          expect(restarted?.wakeup ?? wakeup).toHaveBeenCalledOnce();
        } finally {
          await lifecycleCompletion;
          timeoutSpy?.mockRestore();
          get.mockRestore();
          recoveredGet?.mockRestore();
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recoveredParser?.shutdown();
            } finally {
              try {
                await restarted?.service.shutdown();
              } finally {
                await retirePublicationFixture(service, endpoint.id);
              }
            }
          }
        }
      },
    );
  });

  it("ingests Teams files only from personal chats and keeps non-DM references link-only", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service } = await configuredTeamsEndpoint(
      fixture,
      { storage: storage.storage },
    );
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const fileBody = Buffer.from("teams personal file", "utf8");
    const channelFetch = vi.fn(async () => fileBody);
    const personalFetch = vi.fn(async () => fileBody);

    const channelConversationId = "19:teams-file-channel@thread.tacv2";
    const channelRootId = "1740000000191";
    const channelThread = makeThread({
      channelId: `teams:${Buffer.from(channelConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "Files channel",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channelThread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "channel-plan.txt",
            mimeType: "text/plain",
            size: fileBody.length,
            fetchData: channelFetch,
            fetchMetadata: { testRecoveryKey: "teams-channel-file" },
          } as Attachment,
        ],
        id: channelRootId,
        text: "",
        mentioned: true,
      }),
      trigger: "mention",
    });
    expect(channelFetch).not.toHaveBeenCalled();
    expect(storage.putFile).not.toHaveBeenCalled();

    const personalConversationId = "a:teams-file-personal";
    const personalThread = makeThread({
      channelId: `teams:${Buffer.from(personalConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:personal`,
      id: `teams:${Buffer.from(personalConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}:personal`,
      isDM: true,
      name: "Personal files",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: personalThread.thread,
      message: makeMessage({
        attachments: [
          {
            type: "file",
            name: "personal-plan.txt",
            mimeType: "text/plain",
            size: fileBody.length,
            fetchData: personalFetch,
            fetchMetadata: { testRecoveryKey: "teams-personal-file" },
          } as Attachment,
        ],
        id: "teams-personal-file-message",
        text: "",
      }),
      trigger: "direct_message",
    });

    expect(personalFetch).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
    const channelDelivery = deliveries.find(
      (delivery) =>
        delivery.providerEventId ===
        `teams:${Buffer.from(`${channelConversationId};messageid=${channelRootId}`).toString("base64url")}:${channelRootId}`,
    );
    const personalDelivery = deliveries.find((delivery) =>
      delivery.providerEventId.endsWith(":teams-personal-file-message"),
    );
    expect(channelDelivery?.normalizedEvent).toMatchObject({
      message: {
        attachments: [
          expect.objectContaining({
            name: "channel-plan.txt",
            recovery: null,
          }),
        ],
      },
    });
    expect(personalDelivery?.normalizedEvent).toMatchObject({
      message: {
        attachments: [
          expect.objectContaining({
            name: "personal-plan.txt",
            recovery: expect.objectContaining({
              provider: "microsoft-teams",
            }),
          }),
        ],
      },
    });
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .innerJoin(
        chatConversations,
        eq(chatConversations.issueId, issueComments.issueId),
      )
      .where(eq(chatConversations.endpointId, endpoint.id));
    expect(comments).toEqual(
      expect.arrayContaining([
        {
          body: "Shared 1 Microsoft Teams file reference.",
        },
        { body: "Shared 1 file." },
      ]),
    );
    await expect(
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(eq(issueAttachments.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);
  });

  it.each(["captioned", "file_only"] as const)(
    "preserves a Teams personal %s attachment omission after losing its live download closure",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const first = await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
      const { endpoint } = first;
      const configuration = first.runtime.configurations.get(endpoint.id)!;
      const pinned = createChatSdkEndpointRuntime({
        ...configuration,
        callbacks: { onMessage() {} },
        logger: "silent",
      });
      const sourceUrl =
        "https://contoso.sharepoint.com/download?signature=never-persist-this";
      const caption =
        mode === "captioned" ? "Inspect only this exact new file" : "";
      const parsed = pinned.parseMicrosoftTeamsMessage({
        id: `teams-personal-unavailable-${mode}`,
        type: "message",
        text: caption,
        timestamp: new Date().toISOString(),
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        from: { id: "29:personal-file-user", name: "Personal File User" },
        conversation: {
          id: `a:personal-unavailable-${mode}`,
          conversationType: "personal",
          tenantId:
            configuration.providerConfig.provider === "microsoft-teams"
              ? configuration.providerConfig.credentials.appTenantId
              : undefined,
        },
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            contentUrl:
              "https://contoso.sharepoint.com/Documents/current-plan.txt",
            name: "current-plan.txt",
            content: {
              downloadUrl: sourceUrl,
              fileType: "txt",
              uniqueId: "current-file",
            },
          },
        ],
      });
      expect(parsed?.attachments).toHaveLength(1);
      expect(parsed!.attachments[0]!.mimeType).toBe("text/plain");
      expect(
        pinned.attachmentRecoveryDescriptor(parsed!.attachments[0]!),
      ).toBeNull();
      const fetchData = vi.fn(async () => {
        throw new Error("Live closure must not survive restart");
      });
      parsed!.attachments[0]!.fetchData = fetchData;
      const descriptor = vi
        .spyOn(
          first.runtime.endpoints.get(endpoint.id)!,
          "attachmentRecoveryDescriptor",
        )
        .mockImplementation((attachment) => {
          expect(pinned.attachmentRecoveryDescriptor(attachment)).toBeNull();
          return null;
        });
      const sourceThread = makeThread({
        id: parsed!.threadId,
        channelId: parsed!.threadId,
        isDM: true,
        name: "Personal attachment recovery",
      });
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        await deliverMessage({
          callbacks: first.callbacks,
          endpointId: endpoint.id,
          provider: "microsoft-teams",
          thread: sourceThread.thread,
          message: parsed!,
          trigger: "direct_message",
        });
        const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
        expect(received).toMatchObject({ state: "received", attempts: 0 });
        expect(received!.normalizedEvent).toMatchObject({
          message: {
            attachments: [
              {
                name: "current-plan.txt",
                mimeType: "text/plain",
                recovery: null,
              },
            ],
          },
        });
        expect(JSON.stringify(received!.normalizedEvent)).not.toMatch(
          /signature|never-persist-this|downloadUrl|sharepoint/,
        );
        expect(first.wakeup).not.toHaveBeenCalled();
        await first.service.shutdown();
        // The fixture restarts after the provider reorder window, without
        // changing the receipt, source metadata, or recovery descriptor.
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, received!.id));
        const nextRuntime = new FakeChatSdkRuntime();
        const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
        vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
          async (options) => {
            const runtime = await replace(options);
            const thread = runtime.thread.bind(runtime);
            vi.spyOn(runtime, "thread").mockImplementation((threadId) => ({
              ...thread(threadId),
              // Use the real adapter's personal/channel classification after restart.
              isDM: pinned.getProviderAdapter().isDM!(threadId),
            }));
            return runtime;
          },
        );
        restarted = createService(nextRuntime, undefined, {
          storage: storage.storage,
          scheduleDeferredWork: () => undefined,
        });
        await restarted.service.processPendingDeliveries();
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({
          state: "processed",
          redactedError:
            "1 external attachment was omitted (download unavailable: 1)",
        });
        const [link] = await db
          .select()
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.deliveryId, received!.id),
              eq(chatMessageLinks.direction, "inbound"),
            ),
          );
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, link!.commentId!));
        expect(comment!.body).toBe(caption || "Shared 1 file.");
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(
          restarted.wakeup.mock.calls[0]![1].contextSnapshot,
        ).toMatchObject({
          wakeCommentId: comment!.id,
          externalAttachmentOmissions: [
            { commentId: comment!.id, reasons: { download_unavailable: 1 } },
          ],
        });
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.deliveryId, received!.id),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          );
        expect(intent!.payload).toMatchObject({
          attachmentOmissionReasons: { download_unavailable: 1 },
        });
        await restarted.service.processPendingDeliveries();
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(fetchData).not.toHaveBeenCalled();
        expect(storage.putFile).not.toHaveBeenCalled();
        expect(
          await db
            .select({ id: issueAttachments.id })
            .from(issueAttachments)
            .where(eq(issueAttachments.companyId, fixture.companyId)),
        ).toEqual([]);
      } finally {
        descriptor.mockRestore();
        await first.service.shutdown();
        await pinned.shutdown();
        await retirePublicationFixture(
          restarted?.service ?? first.service,
          endpoint.id,
        );
      }
    },
  );

  it.each([
    { surface: "channel", mode: "immediate" },
    { surface: "channel", mode: "deferred" },
    { surface: "channel", mode: "restart" },
    { surface: "channel", mode: "retry_restart" },
    { surface: "group", mode: "immediate" },
    { surface: "group", mode: "deferred" },
    { surface: "group", mode: "restart" },
    { surface: "group", mode: "retry_restart" },
  ] as const)(
    "preserves unavailable Teams $surface file references through $mode admission",
    async ({ surface, mode }) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const context = await configuredTeamsEndpoint(fixture, {
        storage: storage.storage,
        deferWebhookProcessing:
          mode !== "immediate" && mode !== "retry_restart",
        scheduleDeferredWork: () => undefined,
      });
      const { callbacks, endpoint, service } = context;
      const serviceUrl = "https://smba.trafficmanager.net/amer/";
      const conversationId = `19:teams-unavailable-${surface}-${mode}@thread.${surface === "channel" ? "tacv2" : "v2"}`;
      const rootId = "1740000000391";
      const thread = makeThread({
        channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
        id: `teams:${Buffer.from(`${conversationId}${surface === "channel" ? `;messageid=${rootId}` : ""}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
        name: "Unavailable current files",
      });
      const fetchData = vi.fn(async () => Buffer.from("must not download"));
      const providerUrl =
        "https://private.example/file?signature=do-not-persist";
      const attachments = [
        {
          type: "image",
          name: "../current-photo.png",
          mimeType: "image/png",
          size: 128,
          url: providerUrl,
          fetchData,
          fetchMetadata: { authorization: "do-not-persist" },
        },
        {
          type: "file",
          name: "current-plan.txt",
          mimeType: "text/plain; charset=utf-8",
          size: 32,
          url: providerUrl,
          fetchData,
        },
      ] as Attachment[];
      let active = context;
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        if (surface === "group") {
          await service.update(
            endpoint.id,
            { allowGroupChats: true },
            "owner-user",
          );
        }
        await db.insert(chatEndpointResources).values({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          type: surface === "channel" ? "channel" : "group_chat",
          providerResourceId: conversationId,
          label: "Unavailable current files",
          availability: "available",
          enabled: true,
        });
        for (const [index, text] of [
          "Inspect this current image and file",
          "",
        ].entries()) {
          if (mode === "retry_restart" && index === 0) {
            thread.subscribe.mockRejectedValueOnce(
              new Error("subscription unavailable"),
            );
          }
          const deliveryAttempt = deliverMessage({
            callbacks:
              index === 0
                ? callbacks
                : active.runtime.configurations.get(endpoint.id)!.callbacks,
            endpointId: endpoint.id,
            provider: "microsoft-teams",
            thread: thread.thread,
            message: makeMessage({
              id: String(Number(rootId) + index),
              text,
              mentioned: true,
              attachments,
            }),
            trigger: "mention",
          });
          if (mode === "retry_restart" && index === 0) {
            await expect(deliveryAttempt).rejects.toThrow(
              "subscription unavailable",
            );
          } else {
            await deliveryAttempt;
          }
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                like(
                  chatDeliveries.providerEventId,
                  `%:${Number(rootId) + index}`,
                ),
              ),
            );
          expect(delivery).toBeDefined();
          expect(delivery!.normalizedEvent).toMatchObject({
            message: {
              attachments: [
                {
                  name: "current-photo.png",
                  mimeType: "image/png",
                  size: 128,
                  recovery: null,
                },
                {
                  name: "current-plan.txt",
                  mimeType: "text/plain",
                  size: 32,
                  recovery: null,
                },
              ],
            },
          });
          expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
            "do-not-persist",
          );
          if (mode !== "immediate") {
            expect(delivery!.state).toBe(
              mode === "retry_restart" && index === 0 ? "retry" : "received",
            );
            if (
              (mode === "restart" || mode === "retry_restart") &&
              index === 0
            ) {
              await service.shutdown();
              restarted = createService(new FakeChatSdkRuntime(), undefined, {
                storage: storage.storage,
                deferWebhookProcessing: true,
                scheduleDeferredWork: () => undefined,
              });
              active = { ...context, ...restarted };
            }
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, delivery!.id));
            await active.service.processPendingDeliveries();
          }
          const [processed] = await readChatDeliveriesById(delivery!.id);
          expect(processed).toMatchObject({
            state: "processed",
            redactedError:
              "2 external attachments were omitted (download unavailable: 2)",
          });
          const [link] = await db
            .select()
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.deliveryId, delivery!.id),
                eq(chatMessageLinks.direction, "inbound"),
              ),
            );
          const [comment] = await db
            .select()
            .from(issueComments)
            .where(eq(issueComments.id, link!.commentId!));
          expect(comment!.body).toBe(
            text || "Shared 2 Microsoft Teams file references.",
          );
          const requests = [
            ...context.wakeup.mock.calls,
            ...(restarted?.wakeup.mock.calls ?? []),
          ]
            .map(([, request]) => request)
            .filter(
              (request) =>
                request.contextSnapshot?.wakeCommentId === comment!.id,
            );
          expect(requests).toHaveLength(1);
          expect(requests[0]!.contextSnapshot).toMatchObject({
            externalAttachmentOmissions: [
              {
                commentId: comment!.id,
                reasons: { download_unavailable: 2 },
              },
            ],
          });
          const [intent] = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.deliveryId, delivery!.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            );
          expect(intent!.payload).toMatchObject({
            commentId: comment!.id,
            attachmentOmissionReasons: { download_unavailable: 2 },
          });
        }
        await active.service.processPendingDeliveries();
        expect(
          context.wakeup.mock.calls.length +
            (restarted?.wakeup.mock.calls.length ?? 0),
        ).toBe(2);
        expect(fetchData).not.toHaveBeenCalled();
        expect(storage.putFile).not.toHaveBeenCalled();
        expect(
          active.runtime.endpoints.get(endpoint.id)!
            .rehydratedAttachmentDescriptors,
        ).toEqual([]);
        await expect(
          db
            .select({ id: issueAttachments.id })
            .from(issueAttachments)
            .where(eq(issueAttachments.companyId, fixture.companyId)),
        ).resolves.toEqual([]);
        await expect(
          db
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(eq(issueComments.companyId, fixture.companyId)),
        ).resolves.toHaveLength(2);
      } finally {
        await service.shutdown();
        await restarted?.service.shutdown();
      }
    },
  );

  it("holds a delayed first Teams setup reply until its older root mention enables the channel", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-delayed-root@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const rootMessageId = "1740000000001";
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "delayed-root",
    });
    const laterReply = makeMessage({
      id: "1740000000002",
      raw: { timestamp: "2026-09-05T18:20:02.000Z" },
      text: "Teams follow-up whose callback arrived first",
      userId: "U-TEAMS-PROVISIONAL-PRIVATE",
      userName: "provisional-private-user",
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
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();

    const [deferredReply] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(deferredReply).toMatchObject({
      state: "retry",
      attempts: 1,
      principalId: null,
      redactedError: "Waiting briefly for an earlier root mention",
      normalizedEvent: {
        providerEventId: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${laterReply.id}`,
        kind: "message",
        trigger: "subscribed_message",
        resource: {
          type: "channel",
          providerResourceId: conversationId,
        },
        conversation: { externalThreadId: thread.thread.id },
        message: {
          providerMessageId: laterReply.id,
          providerSentAt: "2026-09-05T18:20:02.000Z",
        },
        filtering: { contentRetained: false },
      },
    });
    const serializedDeferredReply = JSON.stringify(deferredReply);
    expect(serializedDeferredReply).not.toContain(laterReply.text);
    expect(serializedDeferredReply).not.toContain("Alex External");
    expect(serializedDeferredReply).not.toContain("provisional-private-user");
    expect(serializedDeferredReply).not.toContain(
      "U-TEAMS-PROVISIONAL-PRIVATE",
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(deferredReply.nextAttemptAt).not.toBeNull();
    expect(await service.listConversations(endpoint.id)).toHaveLength(0);
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: conversationId,
        type: "channel",
        enabled: false,
      }),
    ]);

    const earlierRoot = makeMessage({
      id: rootMessageId,
      raw: { timestamp: "2026-09-05T18:20:01.000Z" },
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
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "received"),
        ),
      );
    await service.processPendingDeliveries();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, deferredReply.id));
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    expect(conversation).toMatchObject({ externalThreadId: thread.thread.id });
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        providerResourceId: conversationId,
        type: "channel",
        enabled: true,
      }),
    ]);
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
    const [hydratedReply] = await readChatDeliveriesById(deferredReply.id);
    expect(hydratedReply).toMatchObject({
      state: "processed",
      principalId: expect.any(String),
      normalizedEvent: {
        principal: {
          externalId: "U-TEAMS-PROVISIONAL-PRIVATE",
          displayName: "Alex External",
          handle: "provisional-private-user",
        },
        message: {
          providerMessageId: laterReply.id,
          providerSentAt: "2026-09-05T18:20:02.000Z",
          providerSentAtSource: "teams_activity_timestamp",
          text: laterReply.text,
        },
      },
    });
    expect(
      (hydratedReply.normalizedEvent as { filtering?: unknown }).filtering,
    ).toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("orders rapid Teams follow-ups by provider time when callbacks arrive reversed", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-follow-up-order@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const rootMessageId = "1740000000020";
    await db.insert(chatEndpointResources).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      type: "channel",
      providerResourceId: conversationId,
      label: "follow-up-order",
      availability: "available",
      enabled: true,
    });
    const thread = makeThread({
      channelId: `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      id: `teams:${Buffer.from(`${conversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
      name: "follow-up-order",
    });
    const root = makeMessage({
      id: rootMessageId,
      raw: { timestamp: "2026-09-05T18:30:00.000Z" },
      text: "@maya start an ordered Teams task",
      mentioned: true,
    });
    root.metadata.dateSent = new Date("2026-09-05T18:30:00.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: root,
      trigger: "mention",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();
    wakeup.mockClear();

    const later = makeMessage({
      id: "1740000000022",
      raw: { timestamp: "2026-09-05T18:30:02.000Z" },
      text: "Teams follow-up two",
    });
    later.metadata.dateSent = new Date("2026-09-05T18:30:02.000Z");
    const earlier = makeMessage({
      id: "1740000000021",
      raw: { timestamp: "2026-09-05T18:30:01.000Z" },
      text: "Teams follow-up one",
    });
    earlier.metadata.dateSent = new Date("2026-09-05T18:30:01.000Z");
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: later,
      trigger: "subscribed_message",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: thread.thread,
      message: earlier,
      trigger: "subscribed_message",
    });

    // Keep this ordering assertion independent of database/CI wall-clock speed.
    // The next drain below explicitly makes both deliveries due.
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(and(eq(chatDeliveries.endpointId, endpoint.id), inArray(chatDeliveries.state, ["received", "retry"])));
    await service.processPendingDeliveries();
    expect(wakeup).not.toHaveBeenCalled();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          inArray(chatDeliveries.state, ["received", "retry"]),
        ),
      );
    await service.processPendingDeliveries();

    const [conversation] = await service.listConversations(endpoint.id);
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation!.issueId))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id)),
    ).resolves.toEqual([
      { body: "@maya start an ordered Teams task" },
      { body: "Teams follow-up one" },
      { body: "Teams follow-up two" },
    ]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("keeps a first-channel Teams orphan payload-free during grace and filters it without a live retry", async () => {
    const fixture = await seedCompany();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
    const conversationId = "19:teams-orphan-only@thread.tacv2";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
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
        text: "private orphan content not for the Teams bot",
        userId: "U-TEAMS-ORPHAN-PRIVATE",
        userName: "orphan-private-user",
      }),
      trigger: "unaddressed_message",
    });
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.endpointId, endpoint.id));
    await service.processPendingDeliveries();
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "retry",
      attempts: 1,
      principalId: null,
      normalizedEvent: {
        filtering: { contentRetained: false },
        resource: { providerResourceId: conversationId, type: "channel" },
        conversation: { externalThreadId: thread.thread.id },
        message: { providerMessageId: "1740000000012" },
      },
    });
    const serializedDelivery = JSON.stringify(delivery);
    expect(serializedDelivery).not.toContain("private orphan content");
    expect(serializedDelivery).not.toContain("Alex External");
    expect(serializedDelivery).not.toContain("orphan-private-user");
    expect(serializedDelivery).not.toContain("U-TEAMS-ORPHAN-PRIVATE");
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);

    await service.shutdown();
    const restarted = createService();
    await db
      .update(chatDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(chatDeliveries.id, delivery.id));
    await restarted.service.processPendingDeliveries();

    await expect(
      db
        .select({
          state: chatDeliveries.state,
          attempts: chatDeliveries.attempts,
        })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, delivery.id)),
    ).resolves.toEqual([{ state: "filtered", attempts: 1 }]);
    expect(await restarted.service.listConversations(endpoint.id)).toHaveLength(
      0,
    );
    await expect(
      db
        .select({ id: chatExternalPrincipals.id })
        .from(chatExternalPrincipals)
        .where(eq(chatExternalPrincipals.companyId, fixture.companyId)),
    ).resolves.toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
    await restarted.service.shutdown();
  });

  it.each([
    { provider: "slack" as const, label: "Slack" },
    { provider: "microsoft-teams" as const, label: "Microsoft Teams" },
  ])(
    "round-trips a $label question modal and durably acknowledges denied or replayed tokens",
    async ({ provider }) => {
      const fixture = await seedCompany();
      let pauseNextFormOpen = false;
      let releaseFormOpenAuthorization!: () => void;
      let signalFormOpenAuthorization!: () => void;
      const formOpenAuthorizationEntered = new Promise<void>((resolve) => {
        signalFormOpenAuthorization = resolve;
      });
      const formOpenAuthorizationReleased = new Promise<void>((resolve) => {
        releaseFormOpenAuthorization = resolve;
      });
      const questionFormOpenAuthorizationBarrier = async () => {
        if (!pauseNextFormOpen) return;
        signalFormOpenAuthorization();
        await formOpenAuthorizationReleased;
      };
      const context =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture, {
              questionFormOpenAuthorizationBarrier,
            })
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
                {
                  questionFormOpenAuthorizationBarrier,
                },
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
      const { callbacks, endpoint, runtime, service } = context;
      if (!callbacks.onAction || !callbacks.onModalSubmit) {
        throw new Error("Expected question action and modal callbacks");
      }
      const teamsEndpointRuntime =
        provider === "microsoft-teams"
          ? runtime.endpoints.get(endpoint.id)
          : null;
      if (provider === "microsoft-teams" && !teamsEndpointRuntime) {
        throw new Error("Expected Teams endpoint runtime");
      }
      const teamsRouteCount = () =>
        teamsEndpointRuntime?.recordedMicrosoftTeamsRoutes.length ?? 0;
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
      const callbackThread =
        provider === "microsoft-teams"
          ? {
              ...channel.thread,
              channelId: `teams:${Buffer.from(teamsConversationId).toString("base64url")}`,
              id: `teams:${Buffer.from(`${teamsConversationId};messageid=modal-root`).toString("base64url")}`,
            }
          : channel.thread;
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
      await service.test(endpoint.id);
      const [conversation] = await readChatConversationsByEndpointId(endpoint.id);

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
          openModal: vi.fn(async (_modal?: unknown) => ({ viewId: "modal-view" })),
          raw:
            provider === "microsoft-teams"
              ? { serviceUrl: teamsServiceUrl }
              : {},
          thread: channel.thread,
          threadId: callbackThread.id,
          triggerId: `modal-trigger-${randomUUID()}`,
          user: modalUser,
          value: interaction.id,
        },
      });
      const routeCountBeforeDeniedOpen = teamsRouteCount();
      await callbacks.onAction(
        actionEvent(`pcf:${"A".repeat(22)}`) as Parameters<
          NonNullable<typeof callbacks.onAction>
        >[0],
      );
      await vi.waitFor(() =>
        expect(channel.postEphemeral).toHaveBeenCalledWith(
          modalUser.userId,
          "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
          { fallbackToDM: false },
        ),
      );
      expect(teamsRouteCount()).toBe(routeCountBeforeDeniedOpen);

      if (provider === "microsoft-teams") {
        pauseNextFormOpen = true;
        const racedOpen = actionEvent(openAction.actionId);
        const opening = callbacks.onAction(
          racedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        await formOpenAuthorizationEntered;
        await db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        releaseFormOpenAuthorization();
        await opening;
        expect(racedOpen.event.openModal).not.toHaveBeenCalled();
        expect(teamsRouteCount()).toBe(routeCountBeforeDeniedOpen);
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );
        pauseNextFormOpen = false;
      }

      if (provider === "slack") {
        const lockProbeOpen = actionEvent(openAction.actionId);
        let releaseProviderOpen!: () => void;
        const providerOpenEntered = vi.fn();
        lockProbeOpen.event.openModal = vi.fn(async () => {
          providerOpenEntered();
          await new Promise<void>((resolve) => {
            releaseProviderOpen = resolve;
          });
          return { viewId: "modal-lock-probe" };
        });
        const opening = callbacks.onAction(
          lockProbeOpen as Parameters<
            NonNullable<typeof callbacks.onAction>
          >[0],
        );
        await vi.waitFor(() =>
          expect(providerOpenEntered).toHaveBeenCalledTimes(1),
        );
        const membershipUpdate = db
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          )
          .returning({ id: companyMemberships.id })
          .then(() => "updated" as const);
        const updateOutcome = await Promise.race([
          membershipUpdate,
          new Promise<"timed_out">((resolve) =>
            setTimeout(() => resolve("timed_out"), 500),
          ),
        ]);
        releaseProviderOpen();
        await opening;
        await membershipUpdate;
        expect(updateOutcome).toBe("updated");
        expect(lockProbeOpen.event.openModal).toHaveBeenCalledTimes(1);
        await db
          .update(companyMemberships)
          .set({ membershipRole: "operator", updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, fixture.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, linkedUserId),
            ),
          );

        const failedOpen = actionEvent(openAction.actionId);
        failedOpen.event.openModal = vi.fn(async () => {
          throw Object.assign(new Error("Slack Web API rejected modal"), {
            code: "slack_webapi_platform_error",
            data: { error: "missing_scope", ok: false },
          });
        });
        await callbacks.onAction(
          failedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        await callbacks.onAction(
          failedOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
        );
        expect(failedOpen.event.openModal).toHaveBeenCalledTimes(1);
        await vi.waitFor(() =>
          expect(channel.postEphemeral).toHaveBeenCalledWith(
            modalUser.userId,
            "Paperclip could not open this form. Try the action again or open the linked Paperclip task.",
            { fallbackToDM: false },
          ),
        );
        const modalOpenFailures = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'phase' = 'open'`,
            ),
          );
        expect(modalOpenFailures).toEqual([
          expect.objectContaining({
            state: "filtered",
            attempts: 1,
            redactedError: expect.stringContaining(
              "Provider modal open failed",
            ),
            normalizedEvent: expect.objectContaining({
              modal: {
                phase: "open",
                outcome: "failed",
                disposition: "failed",
              },
            }),
          }),
        ]);
        expect(JSON.stringify(modalOpenFailures)).not.toContain(
          failedOpen.event.triggerId,
        );
      }

      const validOpen = actionEvent(openAction.actionId);
      await callbacks.onAction(
        validOpen as Parameters<NonNullable<typeof callbacks.onAction>>[0],
      );
      expect(validOpen.event.openModal).toHaveBeenCalledTimes(1);
      expect(teamsRouteCount()).toBeGreaterThanOrEqual(
        routeCountBeforeDeniedOpen + (provider === "microsoft-teams" ? 1 : 0),
      );
      const routeCountAfterValidOpen = teamsRouteCount();
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
        (child) => child.type === (provider === "slack" ? "radio_select" : "select"),
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
          raw:
            provider === "microsoft-teams"
              ? { serviceUrl: teamsServiceUrl }
              : {},
          relatedMessage: { id: publication.providerMessageId } as never,
          relatedThread: callbackThread,
          user: modalUser,
          values: {
            [selectField.id]: productionValue,
            [textField.id]: "Add regional failover",
          },
          viewId: "modal-view",
        },
      });
      const forgedSubmit = modalEvent(`pcfs:${"A".repeat(22)}`);
      await expect(
        callbacks.onModalSubmit(
          forgedSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      await expect(
        callbacks.onModalSubmit(
          forgedSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual({ action: "clear" });
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_token_not_current'`,
            ),
          ),
      ).resolves.toHaveLength(1);
      expect(teamsRouteCount()).toBe(routeCountAfterValidOpen);

      const validSubmit = modalEvent(modal.callbackId);
      const invalidSubmit = {
        ...validSubmit,
        event: {
          ...validSubmit.event,
          values: { ...validSubmit.event.values, [textField.id]: "" },
        },
      };
      const wakeupsBeforeInvalidForm = context.wakeup.mock.calls.length;
      const invalidFormResponse = await callbacks.onModalSubmit(
        invalidSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      if (provider === "microsoft-teams") {
        expect(invalidFormResponse).toMatchObject({
          action: "update",
          modal: {
            callbackId: modal.callbackId,
            privateMetadata: modal.callbackId,
            children: expect.arrayContaining([
              expect.objectContaining({
                type: "select",
                id: selectField.id,
                initialOption: productionValue,
              }),
              expect.objectContaining({
                type: "text_input",
                id: textField.id,
                initialValue: "",
              }),
              expect.objectContaining({
                type: "text",
                content: "What should the release note say?: Enter a response",
              }),
            ]),
          },
        });
      } else {
        expect(invalidFormResponse).toEqual({
          action: "errors",
          errors: { [textField.id]: "Enter a response" },
        });
      }
      expect(context.wakeup).toHaveBeenCalledTimes(wakeupsBeforeInvalidForm);
      await expect(
        db
          .select({ status: issueThreadInteractions.status })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interaction.id)),
      ).resolves.toEqual([{ status: "pending" }]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.providerActionId, modal.callbackId),
            ),
          ),
      ).resolves.toEqual([{ status: "issued" }]);
      await expect(
        db
          .select({ id: issueQuestionResponseDeliveries.id })
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
      ).resolves.toEqual([]);
      await expect(
        db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, fixture.companyId),
              eq(activityLog.entityId, conversation.issueId),
              eq(activityLog.action, "issue.thread_interaction_answered"),
            ),
          ),
      ).resolves.toEqual([]);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "viewer", updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      const deniedSubmitResponse = {
        action: "errors",
        errors: {
          [selectField.id]:
            "This form is no longer authorized. Close it and open the linked Paperclip task.",
        },
      };
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              sql`${chatDeliveries.normalizedEvent}->'modal'->>'code' = 'chat_modal_principal_not_authorized'`,
            ),
          ),
      ).resolves.toHaveLength(1);
      expect(teamsRouteCount()).toBe(routeCountAfterValidOpen);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "operator", updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );

      // Both callbacks load the issued token. Hold the duplicate until the
      // first callback commits its answer, exercising stale preflight state
      // rather than relying on database latency to produce the race.
      const originalLoadToken =
        chatQuestionForms.loadChatQuestionFormSubmissionToken;
      let issuedReplayToken: Awaited<ReturnType<typeof originalLoadToken>> =
        null;
      let tokenLoads = 0;
      let releaseFirstSubmit!: () => void;
      let releaseReplaySubmit!: () => void;
      const firstSubmitReleased = new Promise<void>((resolve) => {
        releaseFirstSubmit = resolve;
      });
      const replaySubmitReleased = new Promise<void>((resolve) => {
        releaseReplaySubmit = resolve;
      });
      const tokenLoadSpy = vi
        .spyOn(chatQuestionForms, "loadChatQuestionFormSubmissionToken")
        .mockImplementation(async (...args) => {
          const loaded = await originalLoadToken(...args);
          if (args[1].callbackId === modal.callbackId && tokenLoads < 2) {
            const ordinal = ++tokenLoads;
            expect(loaded?.status).toBe("issued");
            issuedReplayToken = loaded;
            await (ordinal === 1 ? firstSubmitReleased : replaySubmitReleased);
          }
          return loaded;
        });
      const firstSubmit = callbacks.onModalSubmit(
        validSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      const replaySubmit = callbacks.onModalSubmit(
        validSubmit as Parameters<
          NonNullable<typeof callbacks.onModalSubmit>
        >[0],
      );
      // Observe rejections immediately; finally joins both callbacks even when
      // the red assertion fails, so no held callback can leak into another test.
      const submissionsSettled = Promise.allSettled([
        firstSubmit,
        replaySubmit,
      ]);
      try {
        await vi.waitFor(() => expect(tokenLoads).toBe(2));
        releaseFirstSubmit();
        await vi.waitFor(async () => {
          const [current] = await db
            .select({ status: issueThreadInteractions.status })
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, interaction.id));
          expect(current?.status).toBe("answered");
        });
        releaseReplaySubmit();
        await expect(Promise.all([firstSubmit, replaySubmit])).resolves.toEqual(
          [{ action: "clear" }, { action: "clear" }],
        );
      } finally {
        releaseFirstSubmit();
        releaseReplaySubmit();
        await submissionsSettled;
        tokenLoadSpy.mockRestore();
      }
      expect(teamsRouteCount()).toBeGreaterThanOrEqual(
        routeCountAfterValidOpen + (provider === "microsoft-teams" ? 1 : 0),
      );
      await vi.waitFor(
        async () => {
          // The publication worker intentionally drains a bounded global batch.
          // A full-suite database can contain more than 25 older eligible rows,
          // so keep advancing FIFO until this interaction's resolution owns the
          // existing provider-message link.
          await service.processPendingPublications();
          const linked = await db
            .select({ publicationId: chatMessageLinks.publicationId })
            .from(chatMessageLinks)
            .where(
              and(
                eq(chatMessageLinks.endpointId, endpoint.id),
                eq(chatMessageLinks.conversationId, conversation.id),
                eq(
                  chatMessageLinks.providerMessageId,
                  publication.providerMessageId!,
                ),
              ),
            );
          expect(linked).toHaveLength(1);
          expect(linked[0]?.publicationId).not.toBe(publication.id);
          const resolutionState = linked[0]?.publicationId
            ? await db
                .select({ state: chatPublications.state })
                .from(chatPublications)
                .where(eq(chatPublications.id, linked[0].publicationId))
                .then((rows) => rows[0]?.state ?? null)
            : null;
          expect(resolutionState).toBe("published");
        },
        { timeout: 5_000 },
      );
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
      ).resolves.toEqual({ action: "clear" });
      if (!issuedReplayToken) throw new Error("Expected captured issued token");
      const staleReplay = async () => {
        const staleLoadSpy = vi
          .spyOn(chatQuestionForms, "loadChatQuestionFormSubmissionToken")
          .mockResolvedValueOnce(issuedReplayToken);
        try {
          return await callbacks.onModalSubmit!(
            validSubmit as Parameters<
              NonNullable<typeof callbacks.onModalSubmit>
            >[0],
          );
        } finally {
          staleLoadSpy.mockRestore();
        }
      };
      const [processedToken] = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, modal.callbackId),
          ),
        );
      expect(processedToken?.status).toBe("processed");
      // A terminal interaction alone cannot authorize stale-token recovery.
      // The exact processed receipt and its original resolving user must match.
      await db
        .update(chatActions)
        .set({
          result: {
            code: "question_form_answered",
            interactionId: randomUUID(),
          },
        })
        .where(eq(chatActions.id, processedToken.id));
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatActions)
        .set({ result: processedToken.result })
        .where(eq(chatActions.id, processedToken.id));
      await db
        .update(companyMemberships)
        .set({ membershipRole: "viewer" })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(companyMemberships)
        .set({ membershipRole: "operator" })
        .where(
          and(
            eq(companyMemberships.companyId, fixture.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, linkedUserId),
          ),
        );
      await db
        .update(chatIdentityLinks)
        .set({ status: "revoked" })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatIdentityLinks)
        .set({ status: "linked" })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      const relinkedUserId = `modal-relinked-user-${randomUUID()}`;
      await db.insert(authUsers).values({
        id: relinkedUserId,
        name: "Different Modal User",
        email: `${relinkedUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: relinkedUserId,
        status: "active",
        membershipRole: "operator",
      });
      await db
        .update(chatIdentityLinks)
        .set({ paperclipUserId: relinkedUserId })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual(deniedSubmitResponse);
      await expect(
        callbacks.onModalSubmit(
          validSubmit as Parameters<
            NonNullable<typeof callbacks.onModalSubmit>
          >[0],
        ),
      ).resolves.toEqual(deniedSubmitResponse);
      await db
        .update(chatIdentityLinks)
        .set({ paperclipUserId: linkedUserId })
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        );
      await expect(staleReplay()).resolves.toEqual({ action: "clear" });
      expect(
        await db
          .select()
          .from(issueQuestionResponseDeliveries)
          .where(
            eq(issueQuestionResponseDeliveries.interactionId, interaction.id),
          ),
      ).toHaveLength(1);
      expect(await service.listActivity(endpoint.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "delivery",
            status: "filtered",
            detail: "External chat modal submission denied by Paperclip",
            replayable: false,
          }),
        ]),
      );
    },
  );

  it.each([
    { provider: "github" as const, label: "GitHub" },
    { provider: "microsoft-teams" as const, label: "Microsoft Teams" },
  ])(
    "removes a $label endpoint without deleting its task or audit history",
    async ({ provider }) => {
      const fixture = await seedCompany();
      const configured =
        provider === "github"
          ? await configuredGitHubEndpoint(fixture)
          : await configuredTeamsEndpoint(fixture);
      const { callbacks, endpoint, runtime, service } = configured;
      const thread =
        provider === "github"
          ? makeThread({
              channelId: "paperclipai/paperclip",
              id: "github:paperclipai/paperclip:issue:97",
              name: "paperclipai/paperclip",
            })
          : makeThread({
              channelId: "teams-personal-cleanup",
              id: "teams:personal-cleanup",
              isDM: true,
              name: "Teams cleanup DM",
            });
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider,
        thread: thread.thread,
        message: makeMessage({
          id: `${provider}-cleanup-root`,
          raw:
            provider === "microsoft-teams"
              ? {
                  from: { aadObjectId: "097269c2-77cb-4d6e-9be4-9a6362969699" },
                }
              : undefined,
          text:
            provider === "github"
              ? "@maya preserve this GitHub task"
              : "Preserve this Teams task",
          mentioned: provider === "github",
          userId: provider === "github" ? "97001" : "29:teams-cleanup-user",
        }),
        trigger: provider === "github" ? "mention" : "direct_message",
      });
      const [conversation] = await service.listConversations(endpoint.id);
      expect(conversation).toBeDefined();
      const credentialCount = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, fixture.companyId))
        .then((rows) => rows.length);
      expect(credentialCount).toBe(provider === "github" ? 4 : 3);
      const deliveryCount = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(eq(chatDeliveries.endpointId, endpoint.id))
        .then((rows) => rows.length);
      expect(deliveryCount).toBeGreaterThan(0);

      const endpointBlocksSleep = async () => (await db.execute(sql`
        SELECT EXISTS (${incomingWakeWorkQuery("chat_endpoints")} AND endpoint.id = ${endpoint.id}::uuid) AS blocked`))[0].blocked;
      if (provider === "github") expect(await endpointBlocksSleep()).toBe(true);
      await service.configure(endpoint.id, { action: "remove" }, "owner-user");
      if (provider === "github") expect(await endpointBlocksSleep()).toBe(false);
      else expect(await endpointBlocksSleep()).toBe(true); // No persistent/provider coverage expansion.

      await expect(service.get(endpoint.id)).resolves.toMatchObject({
        status: "archived",
      });
      expect(runtime.endpoints.has(endpoint.id)).toBe(false);
      await expect(
        db
          .select({
            refs: toolConnections.credentialSecretRefs,
            status: toolConnections.status,
          })
          .from(toolConnections)
          .where(eq(toolConnections.id, endpoint.connectionId)),
      ).resolves.toEqual([{ refs: [], status: "archived" }]);
      await expect(
        db
          .select({ id: companySecrets.id })
          .from(companySecrets)
          .where(eq(companySecrets.companyId, fixture.companyId)),
      ).resolves.toHaveLength(0);
      await expect(
        db
          .select({ state: chatConversations.state })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversation!.id)),
      ).resolves.toEqual([{ state: "endpoint_removed" }]);
      await expect(
        db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, conversation!.issueId)),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id)),
      ).resolves.toHaveLength(deliveryCount);
    },
  );

  describe("Teams file receipt API projection", () => {
    type Part = {
      state?: typeof chatPublications.$inferInsert.state;
      transfer?: Partial<typeof chatTeamsFileTransfers.$inferInsert>;
    };

    async function projectionFixture(active = false) {
      const company = await seedCompany();
      const providerFetch = vi.fn(async () => {
        throw new Error("Projection GET must not contact a provider");
      });
      const configured = active ? await configuredTeamsEndpoint(company) : null;
      const context =
        configured ?? createService(new FakeChatSdkRuntime(), providerFetch);
      const endpoint =
        configured?.endpoint ??
        (await context.service.create(
          company.companyId,
          {
            provider: "microsoft-teams",
            assignedAgentId: company.assignedAgentId,
            name: "Read-only Teams file receipt fixture",
          },
          "owner-user",
        ));
      let issue: typeof issues.$inferSelect | undefined;
      let conversation: typeof chatConversations.$inferSelect | undefined;
      if (!configured) {
        [issue] = await db
          .insert(issues)
          .values({
            companyId: company.companyId,
            title: "Seeded file receipt projection",
            status: "backlog",
          })
          .returning();
        [conversation] = await db
          .insert(chatConversations)
          .values({
            companyId: company.companyId,
            endpointId: endpoint.id,
            issueId: issue!.id,
            externalConversationId: `teams:projection:${randomUUID()}`,
            externalLabel: "Synthetic personal conversation",
            isDirectMessage: true,
          })
          .returning();
      }
      if (configured) {
        const providerConversationId = `19:projection-${randomUUID()}@thread.tacv2`;
        const serviceUrl = "https://smba.trafficmanager.net/amer/";
        const rootMessageId = "1740000000991";
        const channel = makeThread({
          channelId: `teams:${Buffer.from(providerConversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
          id: `teams:${Buffer.from(`${providerConversationId};messageid=${rootMessageId}`).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`,
          name: "Active projection fixture",
        });
        await deliverMessage({
          callbacks: configured.callbacks,
          endpointId: endpoint.id,
          provider: "microsoft-teams",
          thread: channel.thread,
          message: makeMessage({
            id: rootMessageId,
            text: "@maya verify this active publication fixture",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(context.service, endpoint.id);
        await context.service.test(endpoint.id);
        [conversation] = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.externalThreadId, channel.thread.id),
            ),
          );
        if (!conversation)
          throw new Error("Expected admitted active Teams conversation");
        [issue] = await readIssuesById(conversation.issueId);
        await expect(context.service.get(endpoint.id)).resolves.toMatchObject({
          status: "active",
        });
      }
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: company.companyId,
          provider: "microsoft-teams",
          providerAccountId: randomUUID(),
          externalId: `projection-user-${randomUUID()}`,
        })
        .returning();
      const batch = async (parts: Part[]) => {
        const [comment] = await db
          .insert(issueComments)
          .values({
            companyId: company.companyId,
            issueId: issue!.id,
            authorUserId: "owner-user",
            body: "PRIVATE-COMMENT-PROJECTION-CANARY",
          })
          .returning();
        const publications: Array<typeof chatPublications.$inferSelect> = [];
        for (const [index, part] of parts.entries()) {
          const [publication] = await db
            .insert(chatPublications)
            .values({
              companyId: company.companyId,
              endpointId: endpoint.id,
              conversationId: conversation!.id,
              issueId: issue!.id,
              commentId: comment!.id,
              idempotencyKey: `projection:${randomUUID()}:${index}`,
              payload: { text: "PRIVATE-PAYLOAD-PROJECTION-CANARY" },
              state: part.state ?? "published",
              providerMessageId: `PRIVATE-CARD-PROJECTION-CANARY-${index}`,
              attempts: 1,
              createdAt: new Date(Date.now() + index),
            })
            .returning();
          publications.push(publication!);
          if (part.transfer) {
            await db.insert(chatTeamsFileTransfers).values({
              companyId: company.companyId,
              endpointId: endpoint.id,
              conversationId: conversation!.id,
              publicationId: publication!.id,
              issueId: issue!.id,
              commentId: comment!.id,
              attachmentId: randomUUID(),
              principalId: principal!.id,
              authorizedUserId: "owner-user",
              runtimeGeneration: 1,
              credentialFingerprint: "PRIVATE-FINGERPRINT-PROJECTION-CANARY",
              conversationGeneration: 1,
              sourceDigest: "1".repeat(64),
              authorityDigest: "2".repeat(64),
              tenantId: randomUUID(),
              botAppId: randomUUID(),
              aadObjectId: randomUUID(),
              providerConversationId: "PRIVATE-CONVERSATION-PROJECTION-CANARY",
              providerUserId: "PRIVATE-USER-PROJECTION-CANARY",
              sha256: "3".repeat(64),
              byteSize: 12,
              filename: `report-${index}.txt`,
              tokenSha256: createHash("sha256")
                .update(randomUUID())
                .digest("hex"),
              phase: "awaiting_consent",
              version: 2,
              consentMessageId: `PRIVATE-CARD-PROJECTION-CANARY-${index}`,
              expiresAt: new Date(
                Date.now() +
                  (part.transfer.phase === "expired" ? -60_000 : 600_000),
              ),
              privateState: {
                schema: "synthetic-private-state",
                ciphertext: "PRIVATE-CIPHERTEXT-PROJECTION-CANARY",
                uploadUrl:
                  "https://private.invalid/upload?token=PRIVATE-TOKEN-PROJECTION-CANARY",
                contentUrl:
                  "https://private.invalid/PRIVATE-CONTENT-PROJECTION-CANARY",
              },
              ...part.transfer,
            });
          }
        }
        return publications;
      };
      const snapshot = async () => ({
        publications: await db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.companyId, company.companyId))
          .orderBy(asc(chatPublications.id)),
        transfers: await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.companyId, company.companyId))
          .orderBy(asc(chatTeamsFileTransfers.id)),
        comments: await readIssueCommentsByCompanyId(company.companyId)
          .orderBy(asc(issueComments.id)),
        actions: await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.companyId, company.companyId))
          .orderBy(asc(chatActions.id)),
        deliveries: await db
          .select()
          .from(chatDeliveries)
          .where(eq(chatDeliveries.companyId, company.companyId))
          .orderBy(asc(chatDeliveries.id)),
        links: await db
          .select()
          .from(chatMessageLinks)
          .where(eq(chatMessageLinks.companyId, company.companyId))
          .orderBy(asc(chatMessageLinks.id)),
        wakes: await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, company.companyId))
          .orderBy(asc(agentWakeupRequests.id)),
        audit: await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, company.companyId))
          .orderBy(asc(activityLog.id)),
      });
      const statusPath = (publicationId: string) =>
        `/api/chat-endpoints/${endpoint.id}/conversations/${conversation!.id}/publications/${publicationId}/status`;
      const read = async (publicationId: string) => {
        const before = await snapshot();
        const app = routesApp(db, company.companyId, context.service);
        // Own one ready loopback listener for both reads. Creating and closing
        // a separate implicit Supertest listener per GET can reset the TCP
        // connection before Express receives it under the loaded macOS suite.
        const server = createServer(app);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const { status, activity } = await (async () => {
          try {
            const status = await request(server)
              .get(statusPath(publicationId))
              .expect(200);
            const activity = await request(server)
              .get(`/api/chat-endpoints/${endpoint.id}/activity`)
              .expect(200);
            return { status, activity };
          } finally {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        })();
        expect(status.body).toEqual(
          await context.service.getPublicationBatchStatus(
            endpoint.id,
            conversation!.id,
            publicationId,
          ),
        );
        expect(activity.body).toEqual(
          await context.service.listActivity(endpoint.id),
        );
        const serialized = JSON.stringify([status.body, activity.body]);
        expect(serialized).not.toMatch(
          /PROJECTION-CANARY|https?:|ciphertext|privateState|uploadUrl|contentUrl|tokenSha256|consentMessageId|fileInfoMessageId|responseActivityId|providerMessageId/,
        );
        expect(await snapshot()).toEqual(before);
        expect(providerFetch).not.toHaveBeenCalled();
        expect(context.wakeup).not.toHaveBeenCalled();
        expect(context.cancelRun).not.toHaveBeenCalled();
        expect(context.runtime.endpoints.size).toBe(0);
        return {
          status: status.body,
          activity: activity.body as Array<Record<string, unknown>>,
        };
      };
      return {
        ...company,
        ...context,
        endpoint,
        conversation: conversation!,
        principal: principal!,
        issue: issue!,
        batch,
        snapshot,
        read,
        statusPath,
      };
    }

    // These are persisted-state/API proofs, not provider upload or tenant-auth
    // proofs. No worker is started; every GET must preserve all seeded rows.
    it("projects mixed delivered, declined, expired and cancelled file outcomes without making GET effects", async () => {
      const fixture = await projectionFixture();
      try {
        const parts = await fixture.batch([
          {},
          {
            transfer: {
              phase: "delivered",
              fileInfoMessageId: "PRIVATE-FILE-RECEIPT-PROJECTION-CANARY",
            },
          },
          {
            transfer: {
              phase: "declined",
              responseActivityId: "PRIVATE-DECLINE-PROJECTION-CANARY",
            },
          },
          { transfer: { phase: "expired" } },
          {
            transfer: { phase: "cancelled", reason: "cancelled_after_upload" },
          },
        ]);
        const { status, activity } = await fixture.read(parts[0]!.id);
        expect(status).toMatchObject({
          total: 5,
          published: 2,
          declined: 1,
          expired: 1,
          cancelled: 1,
          settled: 5,
          awaitingConsent: 0,
          canDismiss: true,
          publication: { id: parts[2]!.id, state: "cancelled" },
        });
        expect(
          status.parts.map((part: { id: string; state: string }) => [
            part.id,
            part.state,
          ]),
        ).toEqual(
          parts.map((part, index) => [
            part.id,
            index < 2 ? "published" : "cancelled",
          ]),
        );
        expect(
          activity
            .filter((item) => parts.some((part) => part.id === item.id))
            .map((item) => item.status)
            .sort(),
        ).toEqual([
          "cancelled",
          "cancelled",
          "cancelled",
          "published",
          "published",
        ]);
        for (const item of activity) {
          expect(item.replayable).toBe(false);
          expect(item.resolutionActions).toEqual([]);
        }
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("keeps a cancelled head locked while a consent-card receipt waits for the file tail", async () => {
      const fixture = await projectionFixture();
      try {
        const [head, tail] = await fixture.batch([
          { state: "cancelled" },
          { transfer: {} },
        ]);
        const { status, activity } = await fixture.read(head!.id);
        expect(status).toMatchObject({
          total: 2,
          published: 0,
          declined: 0,
          expired: 0,
          cancelled: 1,
          settled: 1,
          awaitingConsent: 1,
          canDismiss: false,
          publication: { id: tail!.id, state: "awaiting_consent" },
        });
        expect(activity.find((item) => item.id === tail!.id)).toMatchObject({
          status: "awaiting_consent",
          replayable: false,
          resolutionActions: [],
          fileTransfer: {
            phase: "awaiting_consent",
            version: 2,
            filename: "report-1.txt",
          },
        });
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("preserves all-published legacy batches without transfer metadata and excludes other comments", async () => {
      const fixture = await projectionFixture();
      try {
        const parts = await fixture.batch([{}, {}]);
        await fixture.batch([{ state: "pending" }]);
        const { status } = await fixture.read(parts[0]!.id);
        expect(status).toMatchObject({
          total: 2,
          published: 2,
          declined: 0,
          expired: 0,
          cancelled: 0,
          settled: 2,
          awaitingConsent: 0,
          canDismiss: true,
          publication: { id: parts[1]!.id, state: "published" },
        });
        expect(status.parts.map((part: { id: string }) => part.id)).toEqual(
          parts.map((part) => part.id),
        );
        for (const part of status.parts)
          expect(part).not.toHaveProperty("fileTransfer");
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each([
      ["delivered without file receipt", { phase: "delivered" }],
      [
        "waiting without card receipt",
        { phase: "awaiting_consent", consentMessageId: null },
      ],
      ["declined without response receipt", { phase: "declined" }],
      [
        "malformed filename",
        {
          phase: "delivered",
          filename: "",
          fileInfoMessageId: "PRIVATE-FILE-PROJECTION-CANARY",
        },
      ],
      [
        "wrong-stage operator receipt",
        {
          phase: "delivered",
          privateState: {
            resolution: {
              schema: "paperclip.teams.file-resolution.v1",
              action: "mark_delivered",
              fromPhase: "upload_unknown",
            },
          },
        },
      ],
    ] satisfies Array<
      [string, Partial<typeof chatTeamsFileTransfers.$inferInsert>]
    >)(
      "refuses terminal success or actions for %s",
      async (_label, transfer) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([{ transfer }]);
          const { status, activity } = await fixture.read(part!.id);
          expect(status).toMatchObject({
            total: 1,
            published: 0,
            settled: 0,
            awaitingConsent: 0,
            canDismiss: false,
            publication: { id: part!.id, state: "delivery_unknown" },
          });
          expect(activity).toEqual([
            expect.objectContaining({
              id: part!.id,
              status: "delivery_unknown",
              replayable: false,
              resolutionActions: [],
            }),
          ]);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it.each([
      ["consent_unknown", ["cancel"]],
      ["upload_unknown", ["cancel"]],
      ["file_info_unknown", ["mark_delivered", "retry_anyway", "cancel"]],
      ["conflict", []],
    ] as const)(
      "offers only the exact %s stage actions",
      async (phase, actions) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([{ transfer: { phase } }]);
          const { status, activity } = await fixture.read(part!.id);
          expect(status).toMatchObject({
            published: 0,
            settled: 0,
            canDismiss: false,
            publication: { state: "delivery_unknown" },
          });
          expect(activity).toEqual([
            expect.objectContaining({
              id: part!.id,
              replayable: false,
              resolutionActions: actions,
              fileTransfer: {
                provider: "microsoft-teams",
                phase,
                version: 2,
                filename: "report-0.txt",
                expiresAt: expect.any(String),
              },
            }),
          ]);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it("requires exact endpoint, conversation, publication and Board company scope", async () => {
      const fixture = await projectionFixture();
      const other = await projectionFixture();
      try {
        const [part] = await fixture.batch([{ transfer: {} }]);
        const [foreign] = await other.batch([{ transfer: {} }]);
        const app = routesApp(db, fixture.companyId, fixture.service);
        const before = await fixture.snapshot();
        await request(app).get(fixture.statusPath(foreign!.id)).expect(404);
        await request(app)
          .get(
            fixture
              .statusPath(part!.id)
              .replace(fixture.conversation.id, other.conversation.id),
          )
          .expect(404);
        // Cross-company resources are deliberately concealed as not found.
        await request(app).get(other.statusPath(part!.id)).expect(404);
        await request(app)
          .get(`/api/chat-endpoints/${other.endpoint.id}/activity`)
          .expect(404);
        expect(await fixture.snapshot()).toEqual(before);
        const { status, activity } = await fixture.read(part!.id);
        expect(status.total).toBe(1);
        expect(activity.map((item) => item.id)).toEqual([part!.id]);
        expect(JSON.stringify([status, activity])).not.toContain(foreign!.id);
      } finally {
        try {
          await fixture.service.shutdown();
        } finally {
          await other.service.shutdown();
        }
      }
    });

    it("never projects a transfer from another conversation into Activity", async () => {
      const fixture = await projectionFixture();
      try {
        const [otherConversation] = await db
          .insert(chatConversations)
          .values({
            companyId: fixture.companyId,
            endpointId: fixture.endpoint.id,
            issueId: fixture.issue.id,
            externalConversationId: `teams:other:${randomUUID()}`,
            externalLabel: "Different conversation",
          })
          .returning();
        const [part] = await fixture.batch([
          {
            state: "pending",
            transfer: {
              conversationId: otherConversation!.id,
              phase: "file_info_unknown",
              filename: "WRONG-CONVERSATION-FILE.txt",
            },
          },
        ]);
        const { status, activity } = await fixture.read(part!.id);
        expect(status).toMatchObject({
          publication: { state: "pending" },
          canDismiss: false,
        });
        expect(status.publication).not.toHaveProperty("fileTransfer");
        expect(activity).toEqual([
          expect.objectContaining({
            id: part!.id,
            status: "pending",
            replayable: false,
            resolutionActions: [],
          }),
        ]);
        expect(activity[0]).not.toHaveProperty("fileTransfer");
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each([
      ["missing", undefined],
      ["wrong phase", { phase: "upload_unknown", version: 2 }],
      ["stale version", { phase: "file_info_unknown", version: 1 }],
    ] as const)(
      "refuses generic resolution with %s transfer preconditions without changing receipts",
      async (_label, fileTransfer) => {
        const fixture = await projectionFixture();
        try {
          const [part] = await fixture.batch([
            {
              state: "delivery_unknown",
              transfer: { phase: "file_info_unknown" },
            },
          ]);
          const before = await fixture.snapshot();
          const app = routesApp(db, fixture.companyId, fixture.service);
          // A missing or stale transfer hint must never fall through to ordinary
          // message retry, mark-delivered, or cancellation.
          for (const action of [
            "mark_delivered",
            "retry_anyway",
            "cancel",
          ] as const) {
            const response = await request(app)
              .post(
                `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/resolve`,
              )
              .send({ action, ...(fileTransfer ? { fileTransfer } : {}) })
              .expect(409);
            expect(response.body).toMatchObject({
              code: "chat_file_transfer_resolution_required",
            });
            await expect(
              fixture.service.resolvePublication(
                fixture.endpoint.id,
                part!.id,
                action,
                "owner-user",
                fileTransfer,
              ),
            ).rejects.toMatchObject({
              status: 409,
              details: { code: "chat_file_transfer_resolution_required" },
            });
            expect(await fixture.snapshot()).toEqual(before);
          }
          await fixture.read(part!.id);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it("refuses generic replay of a failed transfer without another provider attempt", async () => {
      const fixture = await projectionFixture();
      try {
        const [part] = await fixture.batch([
          { state: "failed", transfer: { phase: "consent_pending" } },
        ]);
        const before = await fixture.snapshot();
        const response = await request(
          routesApp(db, fixture.companyId, fixture.service),
        )
          .post(
            `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/replay`,
          )
          .expect(409);
        expect(response.body).toMatchObject({
          code: "chat_file_transfer_resolution_required",
        });
        await expect(
          fixture.service.replayPublication(fixture.endpoint.id, part!.id),
        ).rejects.toMatchObject({
          status: 409,
          details: { code: "chat_file_transfer_resolution_required" },
        });
        expect(await fixture.snapshot()).toEqual(before);
        const { activity } = await fixture.read(part!.id);
        expect(activity).toEqual([
          expect.objectContaining({
            id: part!.id,
            replayable: false,
            resolutionActions: [],
          }),
        ]);
      } finally {
        await fixture.service.shutdown();
      }
    });

    it("does not treat a caller-only transfer hint as ordinary delivery authority", async () => {
      const fixture = await projectionFixture();
      try {
        const [part] = await fixture.batch([{ state: "delivery_unknown" }]);
        const before = await fixture.snapshot();
        const response = await request(
          routesApp(db, fixture.companyId, fixture.service),
        )
          .post(
            `/api/chat-endpoints/${fixture.endpoint.id}/publications/${part!.id}/resolve`,
          )
          .send({
            action: "mark_delivered",
            fileTransfer: { phase: "file_info_unknown", version: 2 },
          })
          .expect(409);
        expect(response.body).toMatchObject({
          code: "chat_file_transfer_resolution_required",
        });
        expect(await fixture.snapshot()).toEqual(before);
        await fixture.read(part!.id);
      } finally {
        await fixture.service.shutdown();
      }
    });

    it.each(["draft", "verifying", "paused", "attention", "archived"] as const)(
      "does not consume a worker slot for a pending Teams transfer on a %s endpoint",
      async (status) => {
        const fixture = await projectionFixture();
        try {
          // Settle unrelated fixture work before arming this exact inactive
          // candidate. The transfer must not enter either publication worker.
          await fixture.service.processPendingPublications();
          await db
            .update(chatEndpoints)
            .set({ status })
            .where(eq(chatEndpoints.id, fixture.endpoint.id));
          const [part] = await fixture.batch([
            { state: "pending", transfer: { phase: "consent_pending" } },
          ]);
          const [endpointBefore] = await readChatEndpointsById(fixture.endpoint.id);
          expect(endpointBefore?.status).toBe(status);
          const before = await fixture.snapshot();
          await expect(
            fixture.service.processPendingPublications(1),
          ).resolves.toBe(0);
          await expect(
            fixture.service.processPendingPublications(1),
          ).resolves.toBe(0);
          expect(await fixture.snapshot()).toEqual(before);
          await expect(
            readChatEndpointsById(fixture.endpoint.id),
          ).resolves.toEqual([endpointBefore]);
          expect(fixture.runtime.replaceCount).toBe(0);
          // Also checks zero provider requests, runtime creation, wakeups, and
          // cancellation calls, with no projection/read-side mutations.
          await fixture.read(part!.id);
        } finally {
          await fixture.service.shutdown();
        }
      },
    );

    it.each(["pending", "streaming"] as const)(
      "generic publication worker ignores an existing %s Teams transfer on an active endpoint",
      async (state) => {
        const fixture = await projectionFixture(true);
        try {
          // Finish setup's ordinary outbox work before arming the transfer.
          await fixture.service.processPendingPublications();
          const ordinaryControl = await fixture.service.publishBoardMessage(
            fixture.endpoint.id,
            fixture.conversation.id,
            "Ordinary publication control before transfer ownership",
            `teams-worker-control-${randomUUID()}`,
            "owner-user",
          );
          expect(ordinaryControl.state).toBe("published");
          const [part] = await fixture.batch([
            {
              state,
              transfer: {
                phase:
                  state === "pending" ? "consent_pending" : "consent_sending",
                ...(state === "streaming"
                  ? {
                      attemptId: randomUUID(),
                      attemptExpiresAt: new Date(Date.now() + 90_000),
                    }
                  : {}),
              },
            },
          ]);
          if (state === "streaming")
            await db
              .update(chatPublications)
              .set({ updatedAt: new Date(Date.now() - 61_000) })
              .where(eq(chatPublications.id, part!.id));
          await expect(
            fixture.service.get(fixture.endpoint.id),
          ).resolves.toMatchObject({
            status: "active",
            setup: { step: "complete" },
          });
          const [connection] = await readToolConnectionsById(fixture.endpoint.connectionId);
          expect(connection).toMatchObject({
            status: "active",
            enabled: true,
          });
          const providerRuntime = fixture.runtime.endpoints.get(
            fixture.endpoint.id,
          );
          expect(providerRuntime).toBeDefined();
          // An actual ordinary provider post succeeded before the transfer was
          // seeded. An inactive fixture cannot satisfy this proof.
          expect(providerRuntime!.posts.length).toBeGreaterThan(0);
          const postsBefore = [...providerRuntime!.posts];
          const before = await fixture.snapshot();
          await fixture.service.processPendingPublications();
          expect(await fixture.snapshot()).toEqual(before);
          expect(providerRuntime!.posts).toEqual(postsBefore);
        } finally {
          await retirePublicationFixture(fixture.service, fixture.endpoint.id);
        }
      },
    );
  });

  it("supplements verified Teams edit, soft-delete, and restore activities against the existing task", async () => {
    const fixture = await seedCompany();
    const runtime = new FakeChatSdkRuntime();
    const { service } = createService(
      runtime,
      (async () =>
        new Response(JSON.stringify({ access_token: "teams-edit-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "microsoft-teams", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    const clientId = randomUUID();
    const tenantId = randomUUID();
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId,
          tenantId,
          clientSecret: "teams-edit-secret",
        },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Teams callbacks");
    const conversationId = "19:teams-edit@thread.tacv2;messageid=teams-root-1";
    const serviceUrl = "https://smba.trafficmanager.net/amer/";
    const threadId = `teams:${Buffer.from(conversationId).toString("base64url")}:${Buffer.from(serviceUrl).toString("base64url")}`;
    const channel = makeThread({
      channelId: threadId,
      id: threadId,
      name: "Teams edit channel",
    });
    const aadObjectId = "00000000-0000-4000-8000-000000000433";
    const providerUserId = "29:teams-edit-user";
    const messageId = "teams-message-1";
    const originalRaw = {
      id: messageId,
      type: "message",
      text: "<at>Maya</at> original Teams request",
      serviceUrl,
      from: {
        id: providerUserId,
        aadObjectId,
        name: "Teams Edit User",
      },
      conversation: {
        id: conversationId,
        conversationType: "channel",
        tenantId,
      },
      channelData: { tenant: { id: tenantId } },
    };
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "microsoft-teams",
      thread: channel.thread,
      message: makeMessage({
        id: messageId,
        raw: originalRaw,
        text: "@maya original Teams request",
        mentioned: true,
        userId: providerUserId,
      }),
      trigger: "mention",
    });
    await qualifySetupRoundTrip(service, endpoint.id, providerUserId);
    await service.test(endpoint.id);

    const endpointRuntime = runtime.endpoints.get(endpoint.id);
    if (!endpointRuntime) throw new Error("Expected Teams endpoint runtime");
    const initialRouteCount =
      endpointRuntime.recordedMicrosoftTeamsRoutes.length;
    const sendLifecycle = (payload: Record<string, unknown>) =>
      service.handleWebhook(
        endpoint.publicId,
        "microsoft-teams",
        new Request("https://paperclip.example/microsoft-teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    const foreignTenantId = randomUUID();
    const rejectedLifecyclePayloads = [
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "FOREIGN_TENANT_EDIT_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T13:58:00.000Z",
        conversation: {
          ...originalRaw.conversation,
          tenantId: foreignTenantId,
        },
        channelData: {
          eventType: "editMessage",
          tenant: { id: foreignTenantId },
        },
      },
      {
        ...originalRaw,
        type: "messageDelete",
        text: undefined,
        timestamp: "2026-09-06T13:59:00.000Z",
        conversation: {
          id: conversationId,
          conversationType: "channel",
        },
        channelData: { eventType: "softDeleteMessage" },
      },
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "CONFLICTING_TENANT_RESTORE_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T14:00:00.000Z",
        channelData: {
          eventType: "undeleteMessage",
          tenant: { id: foreignTenantId },
        },
      },
      {
        ...originalRaw,
        type: "messageUpdate",
        text: "TARGETED_EDIT_MUST_NOT_BE_RETAINED",
        timestamp: "2026-09-06T14:00:30.000Z",
        recipient: { id: clientId, isTargeted: true },
        channelData: {
          eventType: "editMessage",
          tenant: { id: tenantId },
        },
      },
    ];
    for (const payload of rejectedLifecyclePayloads) {
      await expect(sendLifecycle(payload)).resolves.toMatchObject({ ok: true });
    }
    expect(endpointRuntime.recordedMicrosoftTeamsRoutes).toHaveLength(
      initialRouteCount,
    );
    await expect(
      db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.eventKind, [
              "message_updated",
              "message_deleted",
              "message_restored",
            ]),
          ),
        ),
    ).resolves.toEqual([]);

    const editPayload = {
      ...originalRaw,
      type: "messageUpdate",
      text: "Corrected Teams request",
      timestamp: "2026-09-06T14:01:00.000Z",
      channelData: { eventType: "editMessage", tenant: { id: tenantId } },
    };
    const sendEdit = (payload = editPayload) => sendLifecycle(payload);
    const duplicateResponses = await Promise.all(
      Array.from({ length: 12 }, () => sendEdit()),
    );
    expect(duplicateResponses).toHaveLength(12);
    expect(duplicateResponses.every((response) => response.ok)).toBe(true);
    const sameTimestampRevision = {
      ...editPayload,
      text: "Corrected Teams request again in the same millisecond",
    };
    const revisedResponses = await Promise.all(
      Array.from({ length: 8 }, () => sendEdit(sameTimestampRevision)),
    );
    expect(revisedResponses).toHaveLength(8);
    expect(revisedResponses.every((response) => response.ok)).toBe(true);

    const deletePayload = {
      ...originalRaw,
      type: "messageDelete",
      text: undefined,
      timestamp: "2026-09-06T14:02:00.000Z",
      channelData: {
        eventType: "softDeleteMessage",
        tenant: { id: tenantId },
      },
    };
    const deleteResponses = await Promise.all(
      Array.from({ length: 12 }, () => sendLifecycle(deletePayload)),
    );
    expect(deleteResponses.every((response) => response.ok)).toBe(true);

    await expect(
      sendEdit({
        ...editPayload,
        text: "An edit must not resurrect a soft-deleted Teams message",
        timestamp: "2026-09-06T14:03:00.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });

    const restorePayload = {
      ...originalRaw,
      type: "messageUpdate",
      text: "Restored Teams request",
      timestamp: "2026-09-06T14:04:00.000Z",
      channelData: {
        eventType: "undeleteMessage",
        tenant: { id: tenantId },
      },
    };
    const restoreResponses = await Promise.all(
      Array.from({ length: 8 }, () => sendLifecycle(restorePayload)),
    );
    expect(restoreResponses.every((response) => response.ok)).toBe(true);
    await expect(
      sendEdit({
        ...editPayload,
        text: "Edited after Teams restored the message",
        timestamp: "2026-09-06T14:05:00.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle({
        ...deletePayload,
        timestamp: "2026-09-06T14:02:30.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendLifecycle({
        ...restorePayload,
        text: "STALE_TEAMS_RESTORE_CONTENT_MUST_BE_REDACTED",
        timestamp: "2026-09-06T14:03:30.000Z",
      }),
    ).resolves.toMatchObject({ ok: true });

    const [conversation] = await readChatConversationsByEndpointId(endpoint.id);
    const editComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .then((rows) =>
        rows.filter((comment) =>
          comment.body.startsWith("An external message was edited:"),
        ),
      );
    expect(editComments).toHaveLength(3);
    expect(editComments).toEqual(
      expect.arrayContaining([
        { body: "An external message was edited:\n\nCorrected Teams request" },
        {
          body: "An external message was edited:\n\nCorrected Teams request again in the same millisecond",
        },
        {
          body: "An external message was edited:\n\nEdited after Teams restored the message",
        },
      ]),
    );
    await expect(
      db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .then((rows) =>
          rows.filter(
            (comment) =>
              comment.body ===
                "An external message in this conversation was deleted." ||
              comment.body ===
                "An external message was restored:\n\nRestored Teams request",
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { body: "An external message in this conversation was deleted." },
        {
          body: "An external message was restored:\n\nRestored Teams request",
        },
      ]),
    );
    await expect(
      db
        .select({
          principalId: chatDeliveries.principalId,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            eq(chatDeliveries.eventKind, "message_updated"),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { principalId: expect.any(String), state: "processed" },
        { principalId: expect.any(String), state: "processed" },
        {
          principalId: null,
          state: "filtered",
        },
        { principalId: expect.any(String), state: "processed" },
      ]),
    );
    await expect(
      db
        .select({
          eventKind: chatDeliveries.eventKind,
          principalId: chatDeliveries.principalId,
          state: chatDeliveries.state,
        })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, endpoint.id),
            inArray(chatDeliveries.eventKind, [
              "message_deleted",
              "message_restored",
            ]),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          eventKind: "message_deleted",
          principalId: null,
          state: "processed",
        },
        {
          eventKind: "message_restored",
          principalId: expect.any(String),
          state: "processed",
        },
        {
          eventKind: "message_deleted",
          principalId: null,
          state: "filtered",
        },
        {
          eventKind: "message_restored",
          principalId: null,
          state: "filtered",
        },
      ]),
    );
    const filteredLifecyclePayloads = await db
      .select({ normalizedEvent: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "filtered"),
          inArray(chatDeliveries.eventKind, [
            "message_updated",
            "message_deleted",
            "message_restored",
          ]),
        ),
      );
    expect(filteredLifecyclePayloads).toHaveLength(3);
    expect(JSON.stringify(filteredLifecyclePayloads)).not.toContain(
      "An edit must not resurrect a soft-deleted Teams message",
    );
    expect(JSON.stringify(filteredLifecyclePayloads)).not.toContain(
      "STALE_TEAMS_RESTORE_CONTENT_MUST_BE_REDACTED",
    );
    expect(filteredLifecyclePayloads).toEqual(
      expect.arrayContaining([
        {
          normalizedEvent: expect.objectContaining({
            filtering: { contentRetained: false },
          }),
        },
      ]),
    );
    // The shared deletion-only tombstone path must not authorize a restore or
    // let an older delete override the current provider revision while disabled.
    const commentsBeforeDisabledLifecycle = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, conversation.issueId))
      .orderBy(issueComments.id);
    const priorLifecycleIds = new Set(
      (
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, endpoint.id))
      ).map((row) => row.id),
    );
    await service.replaceResources(endpoint.id, [
      { id: conversation.resourceId!, enabled: false },
    ]);
    await sendLifecycle({
      ...restorePayload,
      timestamp: "2026-09-06T14:06:00.000Z",
      text: "DISABLED_RESTORE_MUST_NOT_PERSIST",
    });
    await sendLifecycle({
      ...deletePayload,
      timestamp: "2026-09-06T14:02:45.000Z",
    });
    const latestLifecycle = (
      await readChatDeliveriesByEndpointId(endpoint.id)
    ).filter((row) => !priorLifecycleIds.has(row.id));
    expect(latestLifecycle).toHaveLength(2);
    expect(latestLifecycle.every((row) => row.state === "filtered")).toBe(true);
    expect(JSON.stringify(latestLifecycle)).not.toContain(
      "DISABLED_RESTORE_MUST_NOT_PERSIST",
    );
    await sendLifecycle({
      ...deletePayload,
      timestamp: "2026-09-06T14:07:00.000Z",
    });
    await service.replaceResources(endpoint.id, [
      { id: conversation.resourceId!, enabled: true },
    ]);
    await sendLifecycle({
      ...restorePayload,
      timestamp: "2026-09-06T14:06:30.000Z",
      text: "OLDER_RESTORE_MUST_NOT_PERSIST",
    });
    const afterDisabledDelete = (
      await readChatDeliveriesByEndpointId(endpoint.id)
    ).filter((row) => !priorLifecycleIds.has(row.id));
    expect(
      afterDisabledDelete.filter((row) => row.state === "processed"),
    ).toEqual([
      expect.objectContaining({
        eventKind: "message_deleted",
        conversationId: conversation.id,
        normalizedEvent: {
          providerEventId: expect.any(String),
          kind: "message_deleted",
          runtimeContext: expect.objectContaining({
            generation: expect.any(Number),
            credentialFingerprint: expect.any(String),
          }),
          conversation: {
            externalThreadId: `teams:${Buffer.from(conversationId).toString("base64url")}`,
          },
          message: {
            providerMessageId: messageId,
            targetProviderEventId: expect.any(String),
            providerSentAt: "2026-09-06T14:07:00.000Z",
          },
          filtering: { contentRetained: false },
        },
      }),
    ]);
    expect(afterDisabledDelete).toHaveLength(4);
    expect(
      afterDisabledDelete.filter((row) => row.state === "filtered"),
    ).toHaveLength(3);
    expect(JSON.stringify(afterDisabledDelete)).not.toContain(
      "OLDER_RESTORE_MUST_NOT_PERSIST",
    );
    await expect(
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, conversation.issueId))
        .orderBy(issueComments.id),
    ).resolves.toEqual(commentsBeforeDisabledLifecycle);
    await service.shutdown();
  });
});
