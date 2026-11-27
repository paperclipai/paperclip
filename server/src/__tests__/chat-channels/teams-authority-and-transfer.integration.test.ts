import { chatHistoryActionBlocks } from "../helpers/chat-history-proof.js";
import { conflict } from "../../errors.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, eq, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, activityLog, authUsers, chatActions, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, chatTeamsFileTransfers, completionContracts, companyMemberships, heartbeatRuns, issueComments, issueAttachments, issues } from "@paperclipai/db";
import { chatChannelService, type ChatChannelServiceOptions, type ChatChannelService } from "../../services/chat-channels.js";
import type { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { createTeamsAdapter } from "@chat-adapter/teams";
import { bindTeamsPersonalRecipient, parseTeamsPersonalRecipient, parseTeamsPersonalRecipientBinding, type TeamsPersonalRecipientAdmission } from "../../services/chat-teams-personal-recipient.js";
import { issueService } from "../../services/issues.js";
import type { PrpStructuredRunResult, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "../../services/native-runtime/native-run-finalizer.js";
import { NativeRunCoordinatorStore } from "../../services/native-runtime/native-run-coordinator-store.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, makeThread, routesApp } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";

describeEmbeddedPostgres("chat channels: teams authority and transfer", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const { seedCompany, readChatDeliveriesByEndpointId, readChatDeliveriesById, readHeartbeatRunsById, readIssuesById, readChatConversationsById, readChatPublicationsByCommentId, readChatTeamsFileTransfersById, receiptBackedWakeup, createService, createStorageService, retirePublicationFixture, qualifySetupRoundTrip, configuredTeamsEndpoint, deliverMessage } = h;

  async function teamsFileAuthorityFixture(
    settings: { linkedRecipient?: boolean; separateSponsor?: boolean } = {},
  ) {
    const { installTeamsFileConsentHook } =
      await import("../../services/chat-teams-file-consent.js");
    type ConsentCard = ReturnType<
      typeof import("../../services/chat-teams-file-consent.js").buildTeamsFileConsentCard
    >;
    type FileCard = ReturnType<
      typeof import("../../services/chat-teams-file-consent.js").buildTeamsUploadedFileCard
    >;
    const fixture = await seedCompany();
    const storage = createStorageService();
    const bytes = Buffer.from("Exact original Teams file bytes.\n", "utf8");
    const consentCards: Array<{ threadId: string; card: ConsentCard }> = [];
    const fileCards: Array<{ threadId: string; card: FileCard }> = [];
    const controls: {
      beforeConsentReceipt?: () => Promise<void>;
      beforeFileInfoReceipt?: () => Promise<void>;
    } = {};
    const handlers = new Map<
      string,
      (context: { activity: unknown }) => Promise<{ status: number }>
    >();
    const runtime = new FakeChatSdkRuntime();
    const replace = runtime.replaceEndpoint.bind(runtime);
    vi.spyOn(runtime, "replaceEndpoint").mockImplementation(async (options) => {
      const instance = await replace(options);
      const thread = instance.thread.bind(instance);
      vi.spyOn(instance, "thread").mockImplementation((id) => ({
        ...thread(id),
        isDM: true,
      }));
      Object.assign(instance, {
        sendTeamsFileConsentCard: async (
          threadId: string,
          card: ConsentCard,
        ) => {
          consentCards.push({ threadId, card });
          await controls.beforeConsentReceipt?.();
          return { id: `native-consent-${consentCards.length}` };
        },
        sendTeamsUploadedFileCard: async (threadId: string, card: FileCard) => {
          fileCards.push({ threadId, card });
          await controls.beforeFileInfoReceipt?.();
          return { id: `native-file-${fileCards.length}` };
        },
      });
      if (
        options.providerConfig.provider === "microsoft-teams" &&
        options.callbacks.onTeamsFileConsent
      ) {
        handlers.clear();
        installTeamsFileConsentHook(
          { on: (name, callback) => handlers.set(name, callback) },
          {
            companyId: options.companyId,
            endpointId: options.endpointId,
            tenantId: String(options.providerConfig.credentials.appTenantId),
            botAppId: String(options.providerConfig.credentials.appId),
            onConsent: async (event) =>
              options.callbacks.onTeamsFileConsent!({
                endpointId: options.endpointId,
                provider: "microsoft-teams",
                event,
              }),
          },
        );
      }
      return instance;
    });
    const uploadRequest = vi.fn<
      NonNullable<ChatChannelServiceOptions["teamsFileUploadRequest"]>
    >(async () =>
      Response.json(
        {
          id: "teams-drive-item-1",
          name: "authority-report.txt",
          size: bytes.length,
        },
        { status: 201 },
      ),
    );
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(
      async () => ({ accepted: true }),
    );
    const cancelRun = vi.fn(async () => ({ status: "cancelled" }));
    const service = chatChannelService(db, {
      fetch: async () =>
        Response.json({ access_token: "synthetic-teams-access" }),
      runtime: runtime as unknown as ChatSdkRuntime,
      heartbeat: { wakeup: receiptBackedWakeup(wakeup), cancelRun },
      storage: storage.storage,
      publicBaseUrl: "https://paperclip.example",
      teamsFileUploadRequest: uploadRequest,
      scheduleDeferredWork: () => undefined,
    });
    const endpoint = await service.create(
      fixture.companyId,
      {
        provider: "microsoft-teams",
        assignedAgentId: fixture.assignedAgentId,
        name: "Teams native file authority",
      },
      "owner-user",
    );
    const tenantId = randomUUID();
    const botAppId = randomUUID();
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: {
          clientId: botAppId,
          tenantId,
          clientSecret: "synthetic-file-secret",
        },
      },
      "owner-user",
    );
    const aadObjectId = randomUUID();
    const recipientUserId = `teams-linked-${randomUUID()}`;
    const sponsorUserId = settings.separateSponsor
      ? `teams-sponsor-${randomUUID()}`
      : "owner-user";
    for (const userId of [
      settings.linkedRecipient ? recipientUserId : null,
      settings.separateSponsor ? sponsorUserId : null,
    ]) {
      if (!userId) continue;
      await db.insert(authUsers).values({
        id: userId,
        name: "Teams authority member",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId: fixture.companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "operator",
      });
    }
    if (settings.separateSponsor)
      await db
        .update(chatEndpoints)
        .set({ sponsorUserId })
        .where(eq(chatEndpoints.id, endpoint.id));
    if (settings.linkedRecipient) {
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "microsoft-teams",
          providerAccountId: tenantId,
          externalId: aadObjectId,
          kind: "user",
          isBot: false,
        })
        .returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal!.id,
        paperclipUserId: recipientUserId,
        status: "linked",
        confirmedAt: new Date(),
      });
    }
    const providerUserId = `29:file-author-${randomUUID()}`;
    const providerConversationId = `a:file-authority-${randomUUID()}`;
    const adapter = createTeamsAdapter({
      appId: botAppId,
      appPassword: "unused-parser-only",
      appTenantId: tenantId,
      appType: "SingleTenant",
    });
    const raw = {
      id: `file-source-${randomUUID()}`,
      type: "message",
      channelId: "msteams",
      timestamp: new Date().toISOString(),
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      from: { id: providerUserId, aadObjectId, name: "File recipient" },
      recipient: { id: `28:${botAppId}` },
      conversation: {
        id: providerConversationId,
        conversationType: "personal",
        tenantId,
      },
      channelData: { tenant: { id: tenantId } },
      text: "Use only my exact original personal conversation.",
    };
    const message = adapter.parseMessage(raw);
    const sourceThread = makeThread({
      id: message.threadId,
      channelId: message.threadId,
      isDM: true,
      name: "Native personal file",
    });
    const deliver = async (activity = raw) => {
      const callbacks = runtime.configurations.get(endpoint.id)!.callbacks;
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "microsoft-teams",
        thread: sourceThread.thread,
        message: adapter.parseMessage(activity),
        trigger: "direct_message",
      });
    };
    await deliver();
    await qualifySetupRoundTrip(service, endpoint.id, aadObjectId);
    await service.test(endpoint.id);
    await service.processPendingPublications();
    const [sourceDelivery] = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          sql`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' = ${raw.id}`,
        ),
      );
    const [conversation] = await readChatConversationsById(sourceDelivery!.conversationId!);
    const [issue] = await readIssuesById(conversation!.issueId);
    const [sourceAction] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.deliveryId, sourceDelivery!.id),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      );
    expect(sourceDelivery).toMatchObject({
      state: "processed",
      normalizedEvent: {
        teamsPersonalRecipient: {
          aadObjectId,
          providerUserId,
          providerConversationId,
        },
      },
    });
    expect(sourceAction).toMatchObject({ status: "processed" });
    await expect(service.get(endpoint.id)).resolves.toMatchObject({
      status: "active",
    });
    const createFile = async () => {
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${issue!.id}`,
        originalFilename: "authority-report.txt",
        contentType: "text/plain",
        body: bytes,
      });
      return issueService(db).createAttachment({
        issueId: issue!.id,
        ...stored,
        createdByUserId: "owner-user",
      });
    };
    const dispatchConsent = async (
      action: "accept" | "decline" = "accept",
      patch: Record<string, unknown> = {},
      retainedHandler?: (context: {
        activity: unknown;
      }) => Promise<{ status: number }>,
    ) => {
      const card = consentCards.at(-1)?.card;
      if (!card)
        throw new Error("Expected real service consent card before callback");
      const activity = {
        id: `consent-response-${randomUUID()}`,
        type: "invoke",
        name: "fileConsent/invoke",
        channelId: "msteams",
        from: raw.from,
        recipient: raw.recipient,
        conversation: raw.conversation,
        channelData: raw.channelData,
        replyToId: `native-consent-${consentCards.length}`,
        value: {
          type: "fileUpload",
          action,
          context:
            action === "accept"
              ? card.content.acceptContext
              : card.content.declineContext,
          ...(action === "accept"
            ? {
                uploadInfo: {
                  name: card.name,
                  fileType: "txt",
                  uniqueId: "teams-drive-item-1",
                  uploadUrl:
                    "https://fixture.sharepoint.com/upload?secret=PRIVATE-UPLOAD-CANARY",
                  contentUrl:
                    "https://fixture.sharepoint.com/personal/authority-report.txt",
                },
              }
            : {}),
        },
        ...patch,
      };
      const handler = retainedHandler ?? handlers.get(`file.consent.${action}`);
      if (!handler)
        throw new Error("Expected registered service consent callback");
      return handler({ activity });
    };
    return {
      fixture,
      storage,
      bytes,
      runtime,
      service,
      endpoint,
      tenantId,
      botAppId,
      aadObjectId,
      providerUserId,
      providerConversationId,
      adapter,
      raw,
      message,
      sourceThread,
      sourceDelivery: sourceDelivery!,
      sourceAction: sourceAction!,
      conversation: conversation!,
      issue: issue!,
      consentCards,
      fileCards,
      uploadRequest,
      wakeup,
      cancelRun,
      createFile,
      deliver,
      dispatchConsent,
      controls,
      handlers,
      recipientUserId,
      sponsorUserId,
    };
  }

  it("tracks the actual Board Teams claim and retires recovery when its receipt commits", async () => {
    const context = await teamsFileAuthorityFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    context.controls.beforeConsentReceipt = async () => { entered(); await hold; };
    let send: ReturnType<typeof context.service.publishBoardMessage> | undefined;
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await context.service.registerTeamsAttemptRecoveryWork(coordinator, () => true).ready;
      expect(coordinator.nextWakeAt()).toBeNull();
      const attachment = await context.createFile();
      send = context.service.publishBoardMessage(context.endpoint.id, context.conversation.id,
        "File with an active claim", `teams-attempt-${randomUUID()}`, "owner-user", [attachment.id]);
      await ready;
      const [claim] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
      expect(claim.phase).toBe("consent_sending"); expect(context.consentCards).toHaveLength(1);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000); expect(coordinator.nextWakeAt()).toBe(claim.attemptExpiresAt!.getTime());
      }, { timeout: 5000 });
      release(); await send;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const [settled] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, claim.id));
      expect(settled.phase).toBe("awaiting_consent"); expect(settled.attemptId).toBeNull();
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
      try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
      finally { reads.mockRestore(); writes.mockRestore(); }
      expect(context.consentCards).toHaveLength(1); expect(context.fileCards).toEqual([]);
      expect(context.uploadRequest).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally {
      release(); await send;
      await coordinator.stop(); vi.useRealTimers();
      await retirePublicationFixture(context.service, context.endpoint.id);
      // This test intentionally leaves unused consent; do not feed the next global expiry fixture.
      await db.delete(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
    }
  });

  it("expires Teams consent from the committed Board transfer without periodic maintenance", async () => {
    const context = await teamsFileAuthorityFixture();
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const settle = () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      // Register before the ordinary Board producer, with no transfer rows yet.
      await context.service.registerTeamsConsentExpiryWork(coordinator, () => true).ready;
      expect(coordinator.nextWakeAt()).toBeNull();
      const attachment = await context.createFile();
      const publication = await context.service.publishBoardMessage(context.endpoint.id, context.conversation.id,
        "A file awaiting consent", `teams-expiry-${randomUUID()}`, "owner-user", [attachment.id]);
      const [transfer] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.publicationId, publication.id));
      expect(transfer.phase).toBe("awaiting_consent"); expect(context.consentCards).toHaveLength(1);
      await settle(); expect(coordinator.nextWakeAt()).toBe(transfer.expiresAt.getTime());
      const reads = vi.spyOn(db, "select");
      try { await vi.advanceTimersByTimeAsync(10_000); expect(reads).not.toHaveBeenCalled(); }
      finally { reads.mockRestore(); }
      await vi.advanceTimersByTimeAsync(transfer.expiresAt.getTime() - Date.now() + 1000); await settle();
      const [expired] = await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, transfer.id));
      const [projected] = await db.select().from(chatPublications).where(eq(chatPublications.id, publication.id));
      expect(expired.phase).toBe("expired"); expect(projected.state).toBe("cancelled");
      expect(coordinator.nextWakeAt()).toBeNull();
      expect(context.consentCards).toHaveLength(1); expect(context.fileCards).toEqual([]);
      expect(context.uploadRequest).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers();
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  describe("Teams personal-recipient admission and durable restart", () => {
    async function recipientFixture() {
      const fixture = await seedCompany();
      const context = await configuredTeamsEndpoint(fixture, {
        deferWebhookProcessing: true,
        scheduleDeferredWork: () => undefined,
      });
      const configuration = context.runtime.configurations.get(
        context.endpoint.id,
      )!;
      if (configuration.providerConfig.provider !== "microsoft-teams") {
        throw new Error("Expected Teams provider configuration");
      }
      const credentials = configuration.providerConfig.credentials;
      const tenantId = String(credentials.appTenantId);
      const botAppId = String(credentials.appId);
      const aadObjectId = randomUUID();
      const providerUserId = `29:personal-${randomUUID()}`;
      const providerConversationId = `a:personal-${randomUUID()}`;
      const adapter = createTeamsAdapter({
        appId: botAppId,
        appPassword: "synthetic-unused-parser-secret",
        appTenantId: tenantId,
        appType: "SingleTenant",
      });
      const raw = {
        id: `recipient-${randomUUID()}`,
        type: "message",
        channelId: "msteams",
        timestamp: new Date().toISOString(),
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        from: { id: providerUserId, aadObjectId, name: "Recipient Fixture" },
        recipient: { id: `28:${botAppId}` },
        conversation: {
          id: providerConversationId,
          conversationType: "personal",
          tenantId,
        },
        channelData: { tenant: { id: tenantId } },
        text: "Keep this exact personal request",
        token: "SYNTHETIC-RECIPIENT-TOKEN-NEVER-PERSIST",
      };
      // Real installed normalization; the service runtime, provider transport
      // and scheduler below are fake. This is not a JWT/live Teams send proof.
      const message = adapter.parseMessage(raw);
      const sourceThread = makeThread({
        id: message.threadId,
        channelId: message.threadId,
        isDM: true,
        name: "Personal recipient fixture",
      });
      const restart = () => {
        const runtime = new FakeChatSdkRuntime();
        const replace = runtime.replaceEndpoint.bind(runtime);
        vi.spyOn(runtime, "replaceEndpoint").mockImplementation(
          async (options) => {
            const endpointRuntime = await replace(options);
            const thread = endpointRuntime.thread.bind(endpointRuntime);
            vi.spyOn(endpointRuntime, "thread").mockImplementation((id) => ({
              ...thread(id),
              isDM: adapter.isDM(id),
            }));
            return endpointRuntime;
          },
        );
        return createService(runtime, undefined, {
          scheduleDeferredWork: () => undefined,
        });
      };
      return {
        ...context,
        fixture,
        adapter,
        raw,
        message,
        sourceThread,
        tenantId,
        botAppId,
        aadObjectId,
        providerUserId,
        providerConversationId,
        restart,
      };
    }

    it("preserves actual-parser personal recipient proof across database admission and reconstructed restart", async () => {
      const context = await recipientFixture();
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        await deliverMessage({
          callbacks: context.callbacks,
          endpointId: context.endpoint.id,
          provider: "microsoft-teams",
          thread: context.sourceThread.thread,
          message: context.message,
          trigger: "direct_message",
        });
        const [received] = await readChatDeliveriesByEndpointId(context.endpoint.id);
        expect(received).toMatchObject({
          state: "received",
          attempts: 0,
          conversationId: null,
        });
        const origin = received!.normalizedEvent.runtimeContext as {
          generation: number;
          credentialFingerprint: string;
        };
        const admission: TeamsPersonalRecipientAdmission = {
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          runtimeGeneration: origin.generation,
          credentialFingerprint: origin.credentialFingerprint,
          tenantId: context.tenantId,
          botAppId: context.botAppId,
          providerEventId: received!.providerEventId,
          threadId: context.message.threadId,
          isDirectMessage: true,
        };
        const proof = received!.normalizedEvent.teamsPersonalRecipient;
        expect(proof).toEqual({
          schema: "paperclip.teams.personal-recipient.v1",
          companyId: context.fixture.companyId,
          endpointId: context.endpoint.id,
          runtimeGeneration: origin.generation,
          credentialFingerprint: origin.credentialFingerprint,
          tenantId: context.tenantId,
          botAppId: context.botAppId,
          aadObjectId: context.aadObjectId,
          providerUserId: context.providerUserId,
          providerConversationId: context.providerConversationId,
          providerActivityId: context.raw.id,
          providerEventId: received!.providerEventId,
        });
        expect(parseTeamsPersonalRecipient(proof, admission)).toEqual(proof);
        expect(JSON.stringify(proof)).not.toMatch(
          /SYNTHETIC-RECIPIENT|trafficmanager|Recipient Fixture|Keep this/,
        );
        expect(JSON.stringify(received!.normalizedEvent)).not.toContain(
          "SYNTHETIC-RECIPIENT-TOKEN",
        );
        expect(context.wakeup).not.toHaveBeenCalled();
        await context.service.shutdown();
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, received!.id));
        restarted = context.restart();
        await restarted.service.processPendingDeliveries(1, received!.id);
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({ state: "processed" });
        expect(processed!.normalizedEvent).toEqual(received!.normalizedEvent);
        const [conversation] = await readChatConversationsById(processed!.conversationId!);
        const [principal] = await db
          .select()
          .from(chatExternalPrincipals)
          .where(
            and(
              eq(chatExternalPrincipals.companyId, context.fixture.companyId),
              eq(chatExternalPrincipals.externalId, context.aadObjectId),
            ),
          );
        expect(principal).toBeDefined();
        const scope = {
          admission,
          deliveryId: processed!.id,
          principalId: principal!.id,
          externalPrincipalId: principal!.externalId,
          conversationId: conversation!.id,
          conversationGeneration: conversation!.sessionGeneration,
        };
        const bound = bindTeamsPersonalRecipient(
          processed!.normalizedEvent.teamsPersonalRecipient,
          scope,
        );
        expect(bound).not.toBeNull();
        expect(
          parseTeamsPersonalRecipientBinding(
            JSON.parse(JSON.stringify(bound)),
            scope,
          ),
        ).toEqual(bound);
        expect(
          parseTeamsPersonalRecipientBinding(bound, {
            ...scope,
            conversationGeneration: scope.conversationGeneration + 1,
          }),
        ).toBeNull();
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        await restarted.service.processPendingDeliveries(1, received!.id);
        expect(restarted.wakeup).toHaveBeenCalledTimes(1);
        expect(
          (
            await readChatDeliveriesById(received!.id)
          )[0]!.normalizedEvent,
        ).toEqual(received!.normalizedEvent);
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            restarted?.service ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    it("does not invent personal recipient proof when an AAD-only legacy delivery resumes without original runtime evidence", async () => {
      const context = await recipientFixture();
      let restarted: ReturnType<typeof createService> | undefined;
      try {
        const providerEventId = `teams:${Buffer.from(context.providerConversationId).toString("base64url")}:${context.message.id}`;
        // A separate synthetic legacy receipt, not a stripped modern proof.
        // Its AAD principal and personal route cannot reconstruct BF from.id.
        const normalizedEvent = {
          providerEventId,
          kind: "direct_message",
          trigger: "direct_message",
          principal: {
            externalId: context.aadObjectId,
            displayName: "Legacy person",
            handle: "legacy",
          },
          conversation: {
            externalConversationId: context.message.threadId,
            externalThreadId: context.message.threadId,
            label: "Legacy personal",
            isDirectMessage: true,
            providerUrl: null,
          },
          message: {
            providerMessageId: context.message.id,
            text: "Legacy receipt",
            mentionedBot: false,
            attachments: [],
          },
        };
        const [received] = await db
          .insert(chatDeliveries)
          .values({
            companyId: context.fixture.companyId,
            endpointId: context.endpoint.id,
            providerEventId,
            deduplicationKey: createHash("sha256")
              .update(providerEventId)
              .digest("hex"),
            eventKind: "direct_message",
            normalizedEvent,
            state: "received",
            nextAttemptAt: new Date(0),
          })
          .returning();
        await context.service.shutdown();
        restarted = context.restart();
        await restarted.service.processPendingDeliveries(1, received!.id);
        const [processed] = await readChatDeliveriesById(received!.id);
        expect(processed).toMatchObject({
          state: "failed",
          redactedError:
            "This accepted chat message is no longer authorized to start work",
        });
        expect(processed!.normalizedEvent).toEqual(normalizedEvent);
        expect(
          processed!.normalizedEvent.teamsPersonalRecipient,
        ).toBeUndefined();
        expect(restarted.wakeup).not.toHaveBeenCalled();
        expect(JSON.stringify(processed!.normalizedEvent)).not.toContain(
          context.providerUserId,
        );
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            restarted?.service ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    it("redacts a rejected personal destination instead of persisting its derived recipient proof", async () => {
      const context = await recipientFixture();
      try {
        await context.service.update(
          context.endpoint.id,
          { allowDirectMessages: false },
          "owner-user",
        );
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        await deliverMessage({
          callbacks,
          endpointId: context.endpoint.id,
          provider: "microsoft-teams",
          thread: context.sourceThread.thread,
          message: context.message,
          trigger: "direct_message",
        });
        const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
        expect(delivery).toMatchObject({
          state: "filtered",
          conversationId: null,
          normalizedEvent: { filtering: { contentRetained: false } },
        });
        expect(
          delivery!.normalizedEvent.teamsPersonalRecipient,
        ).toBeUndefined();
        expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
          context.providerUserId,
        );
        expect(JSON.stringify(delivery!.normalizedEvent)).not.toContain(
          context.aadObjectId,
        );
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
  });

  describe("Teams exact self-unknown source continuation", () => {
    async function nativeFileFixture() {
      const context = await teamsFileAuthorityFixture();
      const runId = randomUUID();
      const contractId = randomUUID();
      const sessionId = randomUUID();
      const runnerId = randomUUID();
      const contractSha256 = createHash("sha256")
        .update(contractId)
        .digest("hex");
      await db.insert(completionContracts).values({
        id: contractId,
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v3",
        risk: "low",
        completionAuthority: "agent_claim_policy",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {
          revision: "teams-native-v1",
          objective: "Return the requested file",
          criteria: [
            { id: "response", requirement: "Return the exact selected file" },
          ],
        },
        canonicalSha256: contractSha256,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: context.fixture.companyId,
        agentId: context.fixture.assignedAgentId,
        status: "running",
        wakeupRequestId: context.sourceAction.id,
        runtimeMode: "native",
        nativeIssueId: context.issue.id,
        nativeSessionId: sessionId,
        runnerInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        contextSnapshot: {
          issueId: context.issue.id,
          taskKey: context.issue.identifier,
          source: "chat:microsoft-teams",
          wakeCommentId: context.sourceAction.payload.commentId,
          wakeCommentIds: [context.sourceAction.payload.commentId],
        },
      });
      await db
        .update(agentWakeupRequests)
        .set({ status: "completed", runId })
        .where(eq(agentWakeupRequests.id, context.sourceAction.id));
      const stored = await context.storage.storage.putFile({
        companyId: context.fixture.companyId,
        namespace: `issues/${context.issue.id}`,
        originalFilename: "authority-report.txt",
        contentType: "text/plain",
        body: context.bytes,
      });
      const attachment = await issueService(db).createAttachment({
        issueId: context.issue.id,
        ...stored,
        createdByAgentId: context.fixture.assignedAgentId,
        createdByRunId: runId,
      });
      await issueService(db).addComment(
        context.issue.id,
        "Selected the exact requested file.",
        { agentId: context.fixture.assignedAgentId, runId },
        {
          attachmentIds: [attachment.id],
          authorType: "agent",
          authorizationReason: "allow_self",
        },
      );
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          errorCode: "adapter_failed",
          finishedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(issues)
        .set({ status: "in_review", executionRunId: null })
        .where(eq(issues.id, context.issue.id));
      const result: PrpStructuredRunResult = {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "yielded",
        summary:
          "Here is the exact requested file. I will wait for your next message.",
        completionClaim: {
          contractRevision: "teams-native-v1",
          objectiveSatisfied: true,
          criteria: [
            { criterionId: "response", status: "satisfied", evidenceRefs: [] },
          ],
          remainingWork: [],
        },
        evidence: [],
        verification: [],
        attentionRequests: [],
        artifacts: [],
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next authorized message.",
          idempotencyKey: `wait:${runId}`,
        },
      };
      const terminal: PrpTerminalState = {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "yielded",
        workAssessmentId: randomUUID(),
        statusDecisionId: randomUUID(),
      };
      await new NativeRunCoordinatorStore(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId,
        agentId: context.fixture.assignedAgentId,
        normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerId,
        completionContractId: contractId,
        completionContractSha256: contractSha256,
        completionContractRevision: "teams-native-v1",
        completionContractCriterionIds: ["response"],
      }).completeRun({ result, terminal, turnId: `turn-${runId}` });
      await finalizeNativeRun({
        db,
        runId,
        workspaceFinalizeStatus: "succeeded",
      });
      await repairCommittedNativeChatResponse(db, {
        companyId: context.fixture.companyId,
        issueId: context.issue.id,
        runId,
      });
      const [run] = await readHeartbeatRunsById(runId);
      expect(run).toMatchObject({
        status: "succeeded",
        resultJson: {
          nativeCommittedChatResponse: {
            schema: "paperclip.native_committed_chat_response.v1",
          },
        },
      });
      return { ...context, runId, attachment };
    }

    // Actual parser/admission and accepted native-result composition. Provider
    // sends and authenticated App routing are controlled, not live tenant proof.
    it("accepts the exact native file after a lost consent-card receipt without reposting", async () => {
      const context = await nativeFileFixture();
      try {
        const instance = context.runtime.endpoints.get(
          context.endpoint.id,
        )! as unknown as {
          sendTeamsFileConsentCard: (
            threadId: string,
            card: unknown,
          ) => Promise<{ id: string }>;
        };
        const send = instance.sendTeamsFileConsentCard.bind(instance);
        vi.spyOn(instance, "sendTeamsFileConsentCard").mockImplementation(
          async (threadId, card) => {
            await send(threadId, card);
            throw new Error("controlled lost card POST receipt");
          },
        );
        await context.service.processPendingPublications();
        const [unknown] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
        expect(unknown).toMatchObject({
          phase: "consent_unknown",
          consentMessageId: null,
          attemptId: null,
        });
        expect(context.consentCards).toHaveLength(1);
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          consentMessageId: null,
          fileInfoMessageId: "native-file-1",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
        await expect(
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: context.runId,
              initiatedByUserId: "owner-user",
            }),
          ),
        ).rejects.toMatchObject({
          details: { code: "chat_failed_run_retry_not_authorized" },
        });
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
    it.each([
      "sibling_unknown",
      "foreign_comment_run",
      "unowned_attachment",
      "source_edited",
      "upload_unknown",
      "active_attempt",
    ] as const)(
      "does not exempt other unknown effects or changed native authority: %s",
      async (variant) => {
        const context = await nativeFileFixture();
        try {
          context.controls.beforeConsentReceipt = async () => {
            throw new Error("controlled lost card POST receipt");
          };
          await context.service.processPendingPublications();
          const [unknown] = await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
          expect(unknown).toMatchObject({
            phase: "consent_unknown",
            attemptId: null,
          });
          if (variant === "sibling_unknown") {
            await db.insert(chatPublications).values({
              companyId: unknown!.companyId,
              endpointId: unknown!.endpointId,
              conversationId: unknown!.conversationId,
              issueId: unknown!.issueId,
              commentId: unknown!.commentId,
              state: "delivery_unknown",
              idempotencyKey: `run:${context.runId}:other-unknown`,
              payload: { text: "Other uncertain effect" },
            });
          } else if (variant === "foreign_comment_run") {
            await db
              .update(issueComments)
              .set({ createdByRunId: null })
              .where(eq(issueComments.id, unknown!.commentId));
          } else if (variant === "unowned_attachment") {
            await db
              .update(issueAttachments)
              .set({ originatingRunId: null })
              .where(eq(issueAttachments.id, context.attachment.id));
          } else if (variant === "source_edited") {
            await db
              .update(issueComments)
              .set({ updatedAt: new Date(Date.now() + 1) })
              .where(
                eq(
                  issueComments.id,
                  String(context.sourceAction.payload.commentId),
                ),
              );
          } else if (variant === "upload_unknown") {
            await db
              .update(chatTeamsFileTransfers)
              .set({ phase: "upload_unknown", version: unknown!.version + 1 })
              .where(eq(chatTeamsFileTransfers.id, unknown!.id));
          } else {
            await db
              .update(chatTeamsFileTransfers)
              .set({
                attemptId: randomUUID(),
                attemptExpiresAt: new Date(Date.now() + 90_000),
              })
              .where(eq(chatTeamsFileTransfers.id, unknown!.id));
          }
          const [before] = await readChatTeamsFileTransfersById(unknown!.id);
          await expect(context.dispatchConsent()).resolves.toEqual({
            status: 403,
          });
          const [after] = await readChatTeamsFileTransfersById(unknown!.id);
          expect(after).toEqual(before);
          expect(context.consentCards).toHaveLength(1);
          expect(context.uploadRequest).not.toHaveBeenCalled();
          expect(context.fileCards).toEqual([]);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it("retries only the confirmed native file-info stage with an exact audited phase/version, never its PUT", async () => {
      const context = await nativeFileFixture();
      try {
        await context.service.processPendingPublications();
        context.controls.beforeFileInfoReceipt = async () => {
          throw new Error("controlled lost file-info POST receipt");
        };
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [unknown] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
        expect(unknown).toMatchObject({
          phase: "file_info_unknown",
          attemptId: null,
          fileInfoMessageId: null,
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        for (const requested of [
          undefined,
          { phase: "consent_unknown" as const, version: unknown!.version },
          {
            phase: "file_info_unknown" as const,
            version: unknown!.version - 1,
          },
        ]) {
          await expect(
            context.service.resolvePublication(
              context.endpoint.id,
              unknown!.publicationId,
              "retry_anyway",
              "owner-user",
              requested,
            ),
          ).rejects.toMatchObject({
            status: 409,
            details: { code: "chat_file_transfer_resolution_required" },
          });
        }
        const [unchanged] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(unchanged).toEqual(unknown);
        context.controls.beforeFileInfoReceipt = undefined;
        await context.service.resolvePublication(
          context.endpoint.id,
          unknown!.publicationId,
          "retry_anyway",
          "owner-user",
          { phase: "file_info_unknown", version: unknown!.version },
        );
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(unknown!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          fileInfoMessageId: "native-file-2",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(2);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });
  });

  describe("Teams current file authority and composed Board transfer", () => {
    // Actual installed inbound parser + real admission, intent, transfer,
    // projection and callback service. Runtime sends/PUT and the authenticated
    // App hook ingress are controlled here; this is not tenant/JWT/live proof.
    it("freezes the original recipient at Board Send and publishes only after consent and exact-byte PUT", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const attachment = await context.createFile();
        const publication = await context.service.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "One original file for the current task recipient",
          `teams-board-file-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, context.endpoint.id),
              eq(chatActions.kind, "teams_board_file_intent"),
            ),
          );
        expect(intent).toMatchObject({
          status: "processed",
          deliveryId: context.sourceDelivery.id,
          principalId: context.sourceAction.principalId,
          payload: {
            publicationId: publication.id,
            attachmentId: attachment.id,
            sourceActionId: context.sourceAction.id,
            userId: "owner-user",
          },
        });
        const [transfer] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(transfer).toMatchObject({
          phase: "awaiting_consent",
          providerUserId: context.providerUserId,
          aadObjectId: context.aadObjectId,
          providerConversationId: context.providerConversationId,
          sha256: createHash("sha256").update(context.bytes).digest("hex"),
          byteSize: context.bytes.length,
          consentMessageId: "native-consent-1",
          fileInfoMessageId: null,
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.fileCards).toEqual([]);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(await chatHistoryActionBlocks(db, intent!.id)).toBe(true);
        const before = await context.service.getPublicationBatchStatus(
          context.endpoint.id,
          context.conversation.id,
          publication.id,
        );
        expect(before).toMatchObject({
          published: 1,
          awaitingConsent: 1,
          canDismiss: false,
        });
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [done] = await readChatTeamsFileTransfersById(transfer!.id);
        expect(done).toMatchObject({
          phase: "delivered",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: "native-file-1",
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.uploadRequest.mock.calls[0]![1]).toMatchObject({
          method: "PUT",
          redirect: "manual",
          body: context.bytes,
        });
        expect(context.fileCards).toHaveLength(1);
        expect(await chatHistoryActionBlocks(db, intent!.id)).toBe(false);
        const status = await context.service.getPublicationBatchStatus(
          context.endpoint.id,
          context.conversation.id,
          publication.id,
        );
        expect(status).toMatchObject({
          published: 2,
          awaitingConsent: 0,
          settled: 2,
          canDismiss: true,
        });
        expect(
          JSON.stringify([
            status,
            await context.service.listActivity(context.endpoint.id),
          ]),
        ).not.toMatch(
          /PRIVATE-UPLOAD-CANARY|pcfc_|ciphertext|fixture\.sharepoint/,
        );
        await context.service.processPendingPublications();
        expect(context.consentCards).toHaveLength(1);
        expect(context.fileCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("stages native Board file consent on the first send from a cold reconstructed service", async () => {
      const context = await teamsFileAuthorityFixture();
      const coldRuntime = new FakeChatSdkRuntime();
      const replace = coldRuntime.replaceEndpoint.bind(coldRuntime);
      const consentPost = vi.fn(async (_threadId: string, _card: unknown) => ({
        id: "cold-consent-1",
      }));
      vi.spyOn(coldRuntime, "replaceEndpoint").mockImplementation(
        async (options) => {
          const instance = await replace(options);
          const thread = instance.thread.bind(instance);
          vi.spyOn(instance, "thread").mockImplementation((id) => ({
            ...thread(id),
            isDM: true,
          }));
          Object.assign(instance, {
            sendTeamsFileConsentCard: consentPost,
            sendTeamsUploadedFileCard: async () => {
              throw new Error("No upload is authorized before consent");
            },
          });
          return instance;
        },
      );
      const coldWakeup = vi.fn<
        ChatChannelServiceOptions["heartbeat"]["wakeup"]
      >(async () => ({ accepted: true }));
      let coldService: ChatChannelService | undefined;
      try {
        const attachment = await context.createFile();
        await context.service.shutdown();
        coldService = chatChannelService(db, {
          fetch: async () =>
            Response.json({ access_token: "synthetic-cold-access" }),
          runtime: coldRuntime as unknown as ChatSdkRuntime,
          heartbeat: {
            wakeup: receiptBackedWakeup(coldWakeup),
            cancelRun: vi.fn(async () => ({ status: "cancelled" })),
          },
          storage: context.storage.storage,
          publicBaseUrl: "https://paperclip.example",
          teamsFileUploadRequest: context.uploadRequest,
          scheduleDeferredWork: () => undefined,
        });
        expect(coldRuntime.endpoints.size).toBe(0);
        expect(coldRuntime.replaceCount).toBe(0);
        await expect(
          coldService.get(context.endpoint.id),
        ).resolves.toMatchObject({ status: "active" });
        const publication = await coldService.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "First Board send after service reconstruction",
          `teams-cold-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        const [intent] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, context.endpoint.id),
              eq(chatActions.kind, "teams_board_file_intent"),
            ),
          );
        expect(intent).toMatchObject({
          deliveryId: context.sourceDelivery.id,
          principalId: context.sourceAction.principalId,
          payload: {
            publicationId: publication.id,
            sourceActionId: context.sourceAction.id,
            attachmentId: attachment.id,
          },
        });
        expect(
          await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.publicationId, publication.id)),
        ).toEqual([
          expect.objectContaining({
            phase: "awaiting_consent",
            consentMessageId: "cold-consent-1",
            fileInfoMessageId: null,
            providerUserId: context.providerUserId,
            aadObjectId: context.aadObjectId,
            sha256: createHash("sha256").update(context.bytes).digest("hex"),
          }),
        ]);
        expect(consentPost).toHaveBeenCalledTimes(1);
        expect(coldWakeup).not.toHaveBeenCalled();
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(
          await coldService.getPublicationBatchStatus(
            context.endpoint.id,
            context.conversation.id,
            publication.id,
          ),
        ).toMatchObject({
          published: 1,
          awaitingConsent: 1,
          canDismiss: false,
        });
      } finally {
        try {
          await context.service.shutdown();
        } finally {
          await retirePublicationFixture(
            coldService ?? context.service,
            context.endpoint.id,
          );
        }
      }
    });

    async function beginTeamsBoardTransfer(
      context: Awaited<ReturnType<typeof teamsFileAuthorityFixture>>,
    ) {
      const attachment = await context.createFile();
      const publication = await context.service.publishBoardMessage(
        context.endpoint.id,
        context.conversation.id,
        "The exact current original file",
        `teams-authority-race-${randomUUID()}`,
        "owner-user",
        [attachment.id],
      );
      const [transfer] = await db
        .select()
        .from(chatTeamsFileTransfers)
        .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
      expect(transfer).toMatchObject({
        phase: "awaiting_consent",
        consentMessageId: "native-consent-1",
      });
      expect(context.consentCards).toHaveLength(1);
      expect(context.uploadRequest).not.toHaveBeenCalled();
      return { publication, transfer: transfer! };
    }

    it.each(["linked_recipient", "sponsor", "board_author"] as const)(
      "rechecks revoked %s authority before acceptance and before PUT",
      async (role) => {
        for (const boundary of ["accept", "put"] as const) {
          const context = await teamsFileAuthorityFixture({
            linkedRecipient: role === "linked_recipient",
            separateSponsor: true,
          });
          try {
            const { transfer } = await beginTeamsBoardTransfer(context);
            if (boundary === "put")
              await expect(context.dispatchConsent()).resolves.toEqual({
                status: 200,
              });
            if (role === "linked_recipient")
              await db
                .update(chatIdentityLinks)
                .set({ status: "revoked", revokedAt: new Date() })
                .where(
                  and(
                    eq(chatIdentityLinks.companyId, context.fixture.companyId),
                    eq(chatIdentityLinks.endpointId, context.endpoint.id),
                    eq(
                      chatIdentityLinks.principalId,
                      context.sourceAction.principalId!,
                    ),
                  ),
                );
            else
              await db
                .update(companyMemberships)
                .set({ membershipRole: "viewer" })
                .where(
                  and(
                    eq(companyMemberships.companyId, context.fixture.companyId),
                    eq(companyMemberships.principalType, "user"),
                    eq(
                      companyMemberships.principalId,
                      role === "sponsor" ? context.sponsorUserId : "owner-user",
                    ),
                  ),
                );
            const [before] = await readChatTeamsFileTransfersById(transfer.id);
            if (boundary === "accept") {
              const outcome = await context.dispatchConsent();
              // No success ACK for a revoked principal. The current callback
              // contract distinguishes explicit denial from closed transient failure.
              expect([403, 503]).toContain(outcome.status);
            }
            await context.service.processPendingPublications();
            expect(
              await readChatTeamsFileTransfersById(transfer.id),
            ).toEqual([before]);
            expect(context.uploadRequest).not.toHaveBeenCalled();
            expect(context.fileCards).toEqual([]);
            expect(context.consentCards).toHaveLength(1);
          } finally {
            await retirePublicationFixture(
              context.service,
              context.endpoint.id,
            );
          }
        }
      },
    );

    it("rejects a retained old-runtime consent callback after normal pause and resume", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer } = await beginTeamsBoardTransfer(context);
        const oldRuntime = context.runtime.endpoints.get(context.endpoint.id);
        const oldHandler = context.handlers.get("file.consent.accept")!;
        await context.service.configure(
          context.endpoint.id,
          { action: "pause" },
          "owner-user",
        );
        await context.service.configure(
          context.endpoint.id,
          { action: "resume" },
          "owner-user",
        );
        expect(context.runtime.endpoints.get(context.endpoint.id)).not.toBe(
          oldRuntime,
        );
        const [before] = await readChatTeamsFileTransfersById(transfer.id);
        await expect(
          context.dispatchConsent("accept", {}, oldHandler),
        ).resolves.toEqual({ status: 403 });
        expect(
          await readChatTeamsFileTransfersById(transfer.id),
        ).toEqual([before]);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(context.fileCards).toEqual([]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("deduplicates the same actual acceptance activity before and after file delivery", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer } = await beginTeamsBoardTransfer(context);
        const activity = { id: `same-accept-${randomUUID()}` };
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await context.service.processPendingPublications();
        const [before] = await readChatTeamsFileTransfersById(transfer.id);
        expect(before?.phase).toBe("delivered");
        await expect(
          context.dispatchConsent("accept", activity),
        ).resolves.toEqual({ status: 200 });
        await context.service.processPendingPublications();
        expect(
          await readChatTeamsFileTransfersById(transfer.id),
        ).toEqual([before]);
        expect(
          await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, context.endpoint.id),
                eq(chatActions.kind, "teams_file_consent"),
              ),
            ),
        ).toHaveLength(1);
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("durably accepts a callback inside the consent POST before the native receipt returns", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        let duringPost: typeof chatTeamsFileTransfers.$inferSelect | undefined;
        context.controls.beforeConsentReceipt = async () => {
          await expect(context.dispatchConsent()).resolves.toEqual({
            status: 200,
          });
          [duringPost] = await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.endpointId, context.endpoint.id));
          expect(duringPost).toMatchObject({
            phase: "consent_sending",
            consentMessageId: null,
            responseActivityId: expect.any(String),
          });
          expect(JSON.stringify(duringPost)).not.toContain(
            "PRIVATE-UPLOAD-CANARY",
          );
          expect(context.uploadRequest).not.toHaveBeenCalled();
        };
        const attachment = await context.createFile();
        await context.service.publishBoardMessage(
          context.endpoint.id,
          context.conversation.id,
          "Early callback exact file",
          `teams-early-${randomUUID()}`,
          "owner-user",
          [attachment.id],
        );
        expect(duringPost).toBeDefined();
        const [finished] = await readChatTeamsFileTransfersById(duringPost!.id);
        expect(finished).toMatchObject({
          phase: "delivered",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: "native-file-1",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("offers only exact conflict cancellation after valid Teams consent receipts disagree", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { publication } = await beginTeamsBoardTransfer(context);
        const wakeCount = context.wakeup.mock.calls.length;
        await expect(context.dispatchConsent("accept")).resolves.toEqual({
          status: 200,
        });
        await expect(context.dispatchConsent("decline")).resolves.toEqual({
          status: 403,
        });
        const [conflict] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(conflict).toMatchObject({
          phase: "conflict",
          attemptId: null,
          attemptExpiresAt: null,
        });
        const app = routesApp(db, context.fixture.companyId, context.service);
        const before = await readChatPublicationsByCommentId(publication.commentId!);
        const activity = await request(app)
          .get(`/api/chat-endpoints/${context.endpoint.id}/activity`)
          .expect(200);
        const item = activity.body.find(
          (row: { id: string }) => row.id === publication.id,
        );
        expect(item).toMatchObject({
          status: "delivery_unknown",
          replayable: false,
          resolutionActions: ["cancel"],
          fileTransfer: { phase: "conflict", version: conflict!.version },
        });
        expect(JSON.stringify(activity.body)).not.toMatch(
          /PRIVATE-UPLOAD-CANARY|pcfc_|ciphertext|fixture\.sharepoint/,
        );
        expect(
          await db
            .select()
            .from(chatTeamsFileTransfers)
            .where(eq(chatTeamsFileTransfers.publicationId, publication.id)),
        ).toEqual([conflict]);
        expect(
          await readChatPublicationsByCommentId(publication.commentId!),
        ).toEqual(before);
        const path = `/api/chat-endpoints/${context.endpoint.id}/publications/${publication.id}/resolve`;
        const hint = { phase: "conflict", version: conflict!.version };
        for (const action of ["mark_delivered", "retry_anyway"])
          await request(app)
            .post(path)
            .send({ action, fileTransfer: hint })
            .expect(409);
        await request(app)
          .post(path)
          .send({ action: "cancel", fileTransfer: hint })
          .expect(204);
        await request(app)
          .post(path)
          .send({ action: "cancel", fileTransfer: hint })
          .expect(409);
        const [cancelled] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.publicationId, publication.id));
        expect(cancelled).toMatchObject({
          phase: "cancelled",
          reason: "operator_cancelled_conflict",
          version: conflict!.version + 1,
          fileInfoMessageId: null,
        });
        expect(
          await context.service.getPublicationBatchStatus(
            context.endpoint.id,
            context.conversation.id,
            publication.id,
          ),
        ).toMatchObject({
          published: 1,
          cancelled: 1,
          settled: 2,
          canDismiss: true,
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).not.toHaveBeenCalled();
        expect(context.fileCards).toHaveLength(0);
        expect(context.wakeup).toHaveBeenCalledTimes(wakeCount);
        await expect(
          db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, context.fixture.companyId),
                eq(activityLog.entityId, publication.id),
                eq(activityLog.action, "chat.publication_cancel"),
              ),
            ),
        ).resolves.toEqual([
          expect.objectContaining({
            actorType: "user",
            actorId: "owner-user",
            details: expect.objectContaining({
              previousPhase: "conflict",
              previousVersion: conflict!.version,
              nextPhase: "cancelled",
              duplicateRiskAcknowledged: false,
            }),
          }),
        ]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it("retries only fileInfo after a confirmed PUT and an explicitly resolved missing fileInfo receipt", async () => {
      const context = await teamsFileAuthorityFixture();
      try {
        const { transfer, publication } =
          await beginTeamsBoardTransfer(context);
        context.controls.beforeFileInfoReceipt = async () => {
          throw new Error(
            "Synthetic provider ACK timeout after attempted fileInfo POST",
          );
        };
        await expect(context.dispatchConsent()).resolves.toEqual({
          status: 200,
        });
        await context.service.processPendingPublications();
        const [unknown] = await readChatTeamsFileTransfersById(transfer.id);
        expect(unknown).toMatchObject({
          phase: "file_info_unknown",
          consentMessageId: "native-consent-1",
          fileInfoMessageId: null,
        });
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.fileCards).toHaveLength(1);
        await context.service.processPendingPublications();
        expect(context.fileCards).toHaveLength(1);
        context.controls.beforeFileInfoReceipt = undefined;
        await context.service.resolvePublication(
          context.endpoint.id,
          publication.id,
          "retry_anyway",
          "owner-user",
          { phase: "file_info_unknown", version: unknown!.version },
        );
        const [finished] = await readChatTeamsFileTransfersById(transfer.id);
        expect(finished).toMatchObject({
          phase: "delivered",
          fileInfoMessageId: "native-file-2",
        });
        expect(context.consentCards).toHaveLength(1);
        expect(context.uploadRequest).toHaveBeenCalledTimes(1);
        expect(context.uploadRequest.mock.calls[0]![1]).toMatchObject({
          body: context.bytes,
        });
        expect(context.fileCards).toHaveLength(2);
        expect(
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, context.fixture.companyId),
                eq(activityLog.entityId, publication.id),
                eq(activityLog.action, "chat.publication_retry_anyway"),
              ),
            ),
        ).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              previousPhase: "file_info_unknown",
              duplicateRiskAcknowledged: true,
            }),
          }),
        ]);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it.each([
      "missing_original_proof",
      "mismatched_original_aad",
      "different_admitted_recipient",
    ] as const)(
      "keeps the task-link fallback with no native file intent for %s",
      async (variant) => {
        const context = await teamsFileAuthorityFixture();
        try {
          if (variant === "different_admitted_recipient") {
            await context.deliver({
              ...context.raw,
              id: `other-source-${randomUUID()}`,
              from: {
                ...context.raw.from,
                id: `29:other-${randomUUID()}`,
                aadObjectId: randomUUID(),
              },
            });
          } else {
            const normalized = { ...context.sourceDelivery.normalizedEvent };
            if (variant === "missing_original_proof")
              delete normalized.teamsPersonalRecipient;
            else
              normalized.teamsPersonalRecipient = {
                ...(normalized.teamsPersonalRecipient as Record<
                  string,
                  unknown
                >),
                aadObjectId: randomUUID(),
              };
            await db
              .update(chatDeliveries)
              .set({ normalizedEvent: normalized })
              .where(eq(chatDeliveries.id, context.sourceDelivery.id));
          }
          const attachment = await context.createFile();
          const publication = await context.service.publishBoardMessage(
            context.endpoint.id,
            context.conversation.id,
            "Share the authorized original file",
            `teams-safe-fallback-${randomUUID()}`,
            "owner-user",
            [attachment.id],
          );
          expect(
            await db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, context.endpoint.id),
                  eq(chatActions.kind, "teams_board_file_intent"),
                ),
              ),
          ).toEqual([]);
          expect(
            await db
              .select()
              .from(chatTeamsFileTransfers)
              .where(
                eq(chatTeamsFileTransfers.endpointId, context.endpoint.id),
              ),
          ).toEqual([]);
          expect(context.consentCards).toEqual([]);
          expect(context.fileCards).toEqual([]);
          expect(context.uploadRequest).not.toHaveBeenCalled();
          expect(publication.state).toBe("published");
          expect(
            context.runtime.endpoints
              .get(context.endpoint.id)!
              .posts.some((post) => post.text.includes(context.issue.id)),
          ).toBe(true);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );
  });
});
