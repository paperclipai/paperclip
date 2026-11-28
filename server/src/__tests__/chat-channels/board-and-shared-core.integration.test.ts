import { chatInboundWakeNoticeWork } from "../../services/chat-inbound-wake-notice-work.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { reconcileTaskChatRetryReceipts } from "../../services/task-retry.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, activityLog, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companies, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { type ChatChannelService } from "../../services/chat-channels.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { createTeamsAdapter } from "@chat-adapter/teams";
import { issueService } from "../../services/issues.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES, telegramChatSdkCallbackData } from "../../services/chat-interaction-publications.js";
import { resolveChatRunPresentationAuthorizationReason } from "../../services/chat-run-publications.js";
import { projectSafeChatPublicationText } from "../../services/chat-publication-projection.js";
import { nativePublicationTextFits, renderPublicationTransportText } from "../../services/chat-publication-text-parts.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeTelegramFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createRetryFixtures } from "./retry-fixtures.js";

describeEmbeddedPostgres("chat channels: board and shared core", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rf = createRetryFixtures(h, gh);
  const { companyPrefixAttempts, freshCompanyPrefix, seedCompany, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatPublicationsByEndpointId, readChatPublicationsById, readChatConversationsById, readChatPublicationsByCommentId, readHeartbeatRunsByCompanyId, readAgentWakeupRequestsById, createService, retirePublicationFixture, chatWakeContext, qualifySetupRoundTrip, configuredSlackEndpoint, configuredTeamsEndpoint, configuredTelegramEndpoint, deliverMessage } = h;
  const { configuredGitHubEndpoint } = gh;
  const { busyChatRetryHttpFixture, safeNativeProgressFixture, committedChatResponseRecoveryFixture, deferredChatQueueFixture } = rf;

  async function telegramConfirmationRecoveryFixture(decision: "accept" | "reject" = "accept") {
    const fixture = await seedCompany();
    let injectSettlementCrash = true;
    const settlementBarrier = vi.fn(async () => {
      if (!injectSettlementCrash) return;
      injectSettlementCrash = false;
      throw new Error(
        "injected post-interaction confirmation settlement crash",
      );
    });
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, {
        confirmationResolutionPersistBarrier: settlementBarrier,
      });
    if (!callbacks.onAction)
      throw new Error("Telegram action callback was not registered");
    const externalUserId = "771234568";
    const dm = makeThread({
      channelId: externalUserId,
      id: `telegram:${externalUserId}`,
      isDM: true,
      name: "Telegram confirmation DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${externalUserId}:1`,
        text: "Prepare a release confirmation",
        userId: externalUserId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, externalUserId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation)
      throw new Error("Expected Telegram confirmation conversation");

    const linkedUserId = `telegram-confirmation-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: linkedUserId,
      name: "Telegram Confirmation User",
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
          eq(chatExternalPrincipals.provider, "telegram"),
          eq(chatExternalPrincipals.externalId, externalUserId),
        ),
      )
      .then((rows) => rows[0]);
    if (!principal) throw new Error("Expected Telegram confirmation principal");
    const linkIntent = await service.createLinkIntent(
      endpoint.id,
      principal.id,
      1_800,
    );
    const linkToken = new URL(linkIntent.confirmationUrl).searchParams.get(
      "token",
    );
    if (!linkToken) throw new Error("Telegram identity token was absent");
    await service.confirmIdentityLink(linkToken, linkedUserId);

    const interaction = await issueThreadInteractionService(db).create(
      {
        id: conversation.issueId,
        companyId: fixture.companyId,
      },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        title: "Release check",
        payload: {
          version: 1,
          prompt: "Proceed with Telegram production qualification?",
          acceptLabel: "Proceed",
          rejectLabel: "Stop",
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
          eq(
            chatPublications.idempotencyKey,
            `interaction:${interaction.id}:${endpoint.id}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(publication).toMatchObject({
      state: "published",
      payload: {
        interactionId: interaction.id,
        card: {
          kind: "confirmation",
          title: "Proceed with Telegram production qualification?",
          actions: [
            expect.objectContaining({
              type: "callback",
              label: "Proceed",
              style: "primary",
            }),
            expect.objectContaining({
              type: "callback",
              label: "Stop",
              style: "danger",
            }),
          ],
        },
      },
    });
    if (!publication.providerMessageId)
      throw new Error("Telegram confirmation was not delivered");
    const confirmationActions = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "confirmation_response"),
        ),
      );
    expect(confirmationActions).toHaveLength(2);
    expect(
      confirmationActions.every(
        (action) =>
          action.providerActionId.startsWith("pcq:") &&
          Buffer.byteLength(
            telegramChatSdkCallbackData(action.providerActionId),
            "utf8",
          ) <= TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
      ),
    ).toBe(true);
    const acceptAction = confirmationActions.find(
      (action) => action.payload.decision === decision,
    );
    if (!acceptAction)
      throw new Error("Telegram accept action was not persisted");

    wakeup.mockClear();
    const actionEvent = {
      endpointId: endpoint.id,
      provider: "telegram" as const,
      event: {
        actionId: acceptAction.providerActionId,
        adapter: {} as never,
        messageId: publication.providerMessageId,
        openModal: async () => undefined,
        raw: {
          id: `callback-${randomUUID()}`,
          data: telegramChatSdkCallbackData(acceptAction.providerActionId),
          from: { id: Number(externalUserId), first_name: "Telegram User" },
        },
        thread: dm.thread,
        threadId: dm.thread.id,
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
    };
    return { fixture, callbacks, onAction: callbacks.onAction, endpoint, service, wakeup, settlementBarrier, dm, conversation, linkedUserId, principal, interaction, publication, acceptAction, actionEvent };
  }

  it("retries a colliding company fixture prefix and creates a distinct complete fixture", async () => {
    const existing = await seedCompany();
    const [original] = await db.select().from(companies).where(eq(companies.id, existing.companyId));
    const candidates: string[] = [];
    const nextPrefix = vi.fn(() => {
      const prefix = candidates.length === 0 ? original!.issuePrefix : freshCompanyPrefix();
      candidates.push(prefix);
      return prefix;
    });
    const fixture = await seedCompany(nextPrefix);
    const [allocated] = await db.select().from(companies).where(eq(companies.id, fixture.companyId));
    expect(nextPrefix.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(allocated!.issuePrefix).toBe(candidates.at(-1));
    expect(allocated!.issuePrefix).toMatch(/^C[A-F0-9]{7}$/);
    expect(allocated!.issuePrefix).not.toBe(original!.issuePrefix);
    expect(fixture.companyId).not.toBe(existing.companyId);
    expect(await db.select().from(companies).where(eq(companies.id, existing.companyId))).toEqual([original]);
    expect((await db.select().from(agents).where(eq(agents.companyId, fixture.companyId))).map(agent => agent.id).sort())
      .toEqual([fixture.assignedAgentId, fixture.replacementAgentId].sort());
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, fixture.companyId)))
      .toEqual([expect.objectContaining({ principalId: "owner-user", membershipRole: "operator" })]);
  });

  it("bounds company fixture prefix collision retries without creating a partial fixture", async () => {
    const fixture = await seedCompany();
    const [company] = await db.select().from(companies).where(eq(companies.id, fixture.companyId));
    const before = await db.select({ id: companies.id }).from(companies);
    const nextPrefix = vi.fn(() => company!.issuePrefix);
    await expect(seedCompany(nextPrefix)).rejects.toThrow(`after ${companyPrefixAttempts} attempts`);
    expect(nextPrefix).toHaveBeenCalledTimes(companyPrefixAttempts);
    expect((await db.select({ id: companies.id }).from(companies)).map(row => row.id).sort())
      .toEqual(before.map(row => row.id).sort());
  });

  it("does not retry unrelated company fixture database errors", async () => {
    const nextPrefix = vi.fn(() => "C\0INVALID");
    await expect(seedCompany(nextPrefix)).rejects.toMatchObject({ cause: { code: "22021" } });
    expect(nextPrefix).toHaveBeenCalledOnce();
  });

  // Keep repeated fixture reads at one query owner. These return the real query
  // builder, preserving each caller's await, ordering, limits and assertions.

  it.each(["accept", "reject", "drain", "restart", "deferred", "failure", "paused endpoint", "future publication", "stale claim"] as const)("wakes interaction continuations from a committed response through %s", async mode => {
    const context = await telegramConfirmationRecoveryFixture(mode === "reject" ? "reject" : "accept");
    const errors: unknown[] = [];
    let canRun = true;
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    const originalWake = context.wakeup.getMockImplementation()!;
    context.wakeup.mockImplementation(async (...args) => {
      expect((context.service.runtime as unknown as FakeChatSdkRuntime).endpoints.get(context.endpoint.id)?.edits).toHaveLength(["paused endpoint", "future publication"].includes(mode) ? 0 : 1);
      return originalWake(...args);
    });
    if (mode === "deferred") context.wakeup.mockResolvedValueOnce(null);
    if (mode === "failure") context.wakeup.mockRejectedValueOnce(new Error("temporary continuation admission failure"));
    try {
      await context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
      await settle(); await quiet();
      if (["drain", "paused endpoint", "future publication"].includes(mode)) canRun = false;
      if (mode === "restart" || mode === "stale claim") await coordinator.stop();
      await expect(context.onAction(context.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
      if (["drain", "paused endpoint", "future publication"].includes(mode) || mode === "restart" || mode === "stale claim") {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        expect(context.wakeup).not.toHaveBeenCalled();
        await quiet();
        if (mode === "paused endpoint") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, context.endpoint.id));
        if (mode === "future publication") await db.update(chatPublications).set({ state: "retry", nextAttemptAt: new Date(Date.now() + 60_000) })
          .where(eq(chatPublications.idempotencyKey, `interaction-resolution:${context.interaction.id}:${context.endpoint.id}`));
        if (mode === "stale claim") await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ));
        canRun = true;
        if (mode === "restart" || mode === "stale claim") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
            canReconcile: () => true, onError: error => errors.push(error) });
          await context.service.registerInteractionContinuationWork(coordinator, () => canRun).ready;
        } else if (coordinator.nextWakeAt() !== null) {
          await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now()));
        }
      }
      if (mode === "stale claim") {
        const [action] = await db.select().from(chatActions).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ));
        expect(coordinator.nextWakeAt()).toBe(action.updatedAt.getTime() + 30_000);
        await vi.advanceTimersByTimeAsync(Math.max(0, coordinator.nextWakeAt()! - Date.now() - 1));
        expect(context.wakeup).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      if (mode === "deferred" || mode === "failure") {
        let retryAt = 0;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(10);
          const [action] = await db.select().from(chatActions).where(and(
            eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
          ));
          expect(action).toMatchObject({ status: "issued", result: { code: mode === "deferred" ? "interaction_wakeup_deferred" : "interaction_wakeup_failed" } });
          retryAt = action.updatedAt.getTime() + 30_000;
          expect(idleWorkSnapshot().active).toBe(0);
          expect(coordinator.nextWakeAt()).toBe(retryAt);
        }, { timeout: 10_000 });
        expect(context.wakeup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now() - 1));
        expect(context.wakeup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions).where(and(
          eq(chatActions.companyId, context.fixture.companyId), eq(chatActions.kind, "interaction_wakeup"),
        ))).toEqual([{ status: "processed" }]);
      }, { timeout: 10_000 });
      expect(context.wakeup).toHaveBeenCalledTimes(mode === "deferred" || mode === "failure" ? 2 : 1);
      expect(context.wakeup).toHaveBeenCalledWith(context.fixture.assignedAgentId, expect.objectContaining({
        idempotencyKey: `interaction:${context.interaction.id}:${mode === "reject" ? "rejected" : "accepted"}`, allowRunCoalescing: false,
      }));
      await settle(); await quiet();
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); vi.useRealTimers(); await context.service.shutdown(); }
  });

  it("parks pending confirmation history, passes malformed prefixes, and wakes on the outer interaction commit", async () => {
    const waiting = await telegramConfirmationRecoveryFixture();
    const terminal = await telegramConfirmationRecoveryFixture();
    const pendingIds = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const invalidIds = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`);
    await db.insert(chatActions).values([...pendingIds, ...invalidIds].map(id => ({
      ...waiting.acceptAction, id, providerActionId: `confirmation-history:${id}`, status: "processing",
      conversationId: invalidIds.includes(id) ? null : waiting.conversation.id, result: null,
    })));
    await expect(terminal.onAction(terminal.actionEvent)).rejects.toThrow("injected post-interaction confirmation settlement crash");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => errors.push(error) });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const settle = async () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 30_000 });
    const quiet = async () => {
      const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
      } finally { select.mockRestore(); transaction.mockRestore(); }
    };
    try {
      await waiting.service.registerTerminalConfirmationWork(coordinator, () => true).ready;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10);
        expect(await db.select({ status: chatActions.status }).from(chatActions)
          .where(eq(chatActions.id, terminal.acceptAction.id))).toEqual([{ status: "processed" }]);
      }, { timeout: 10_000 });
      await settle();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      expect(await db.select({ id: chatActions.id }).from(chatActions).where(and(
        inArray(chatActions.id, invalidIds), eq(chatActions.status, "failed"),
        eq(sql<string>`${chatActions.result}->>'code'`, "confirmation_action_binding_invalid"),
      ))).toHaveLength(101);
      await quiet();
      const [issue] = await db.select().from(issues).where(eq(issues.id, waiting.conversation.issueId));
      await expect(db.transaction(async tx => {
        await issueThreadInteractionService(tx as unknown as Db).acceptInteraction(issue, waiting.interaction.id, {}, { userId: waiting.linkedUserId });
        expect(await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, waiting.interaction.id))).toEqual([{ status: "pending" }]);
        throw new Error("rollback outer confirmation decision");
      })).rejects.toThrow("rollback outer confirmation decision");
      await settle(); await quiet();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      await db.transaction(async tx => {
        await issueThreadInteractionService(tx as unknown as Db).acceptInteraction(issue, waiting.interaction.id, {}, { userId: waiting.linkedUserId });
        expect(await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, waiting.interaction.id))).toEqual([{ status: "pending" }]);
        expect(await db.select({ id: chatActions.id }).from(chatActions)
          .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(101);
      });
      await settle(); await quiet();
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processing")))).toHaveLength(0);
      expect(await db.select({ id: chatActions.id }).from(chatActions)
        .where(and(inArray(chatActions.id, pendingIds), eq(chatActions.status, "processed")))).toHaveLength(1);
      expect(await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, waiting.fixture.companyId),
        eq(sql<string>`${activityLog.details}->>'interactionId'`, waiting.interaction.id),
        eq(sql<string>`${activityLog.details}->>'source'`, "external_chat"),
      ))).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers();
      await db.delete(chatActions).where(inArray(chatActions.id, [...pendingIds, ...invalidIds]));
    }
  });

  it.each(["early_release", "expired_release", "authorization_expired"] as const)("honors a prepared Retry identity wait after %s", async mode => {
    const f = await busyChatRetryHttpFixture();
    let release = () => {};
    let holding: Promise<unknown> | undefined;
    let releaseAuthorization = () => {};
    let authorizationHolding: Promise<unknown> | undefined;
    let processing: Promise<void> | undefined;
    try {
      const originalInput = (await readAgentWakeupRequestsById(f.action.id))[0];
      const response = await request(f.app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await f.service.processFailedChatRunRetry(response.body.chatActionId);
      const processDue = async () => {
        const [current] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(String(current.result?.retryAt)) - Date.now()) + 1));
        await f.service.processFailedChatRunRetry(current.id);
      };
      await f.releaseIdentity();
      f.wakeup.mockRejectedValueOnce(new Error("temporary_wakeup_unavailable"));
      await processDue();
      const [prepared] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(prepared.status).toBe("issued");
      expect(prepared.payload.sourceAuthorizationPending).toBeUndefined();
      expect(prepared.result?.identityContentionPending).toBeUndefined();
      let acquired = () => {};
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      holding = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${f.companyId}:${f.action.principalId}`}, 0))`);
        acquired(); await held;
      });
      await locked;
      await processDue();
      const [waiting] = await db.select().from(chatActions).where(eq(chatActions.id, response.body.chatActionId));
      expect(waiting).toMatchObject({ status: "issued", result: { attemptCount: 1, identityContentionCount: 2,
        identityContentionDeadlineAt: prepared.result?.identityContentionDeadlineAt } });
      expect(f.wakeup).toHaveBeenCalledOnce();
      if (mode === "expired_release") {
        const expired = new Date(Date.now() - 1).toISOString();
        await db.update(chatActions).set({ result: { ...waiting.result,
          identityContentionDeadlineAt: expired, retryAt: expired } }).where(eq(chatActions.id, waiting.id));
      }
      let authorizationDeadline = 0, authorizationPid = 0;
      if (mode === "authorization_expired") {
        authorizationDeadline = Date.now() + 5_000;
        await db.update(chatActions).set({ result: { ...waiting.result,
          identityContentionDeadlineAt: new Date(authorizationDeadline).toISOString(), retryAt: new Date(0).toISOString() } })
          .where(eq(chatActions.id, waiting.id));
        let acquiredAuthorization = () => {};
        const authorizationLocked = new Promise<void>(resolve => { acquiredAuthorization = resolve; });
        const heldAuthorization = new Promise<void>(resolve => { releaseAuthorization = resolve; });
        authorizationHolding = db.transaction(async tx => {
          await tx.select({ id: chatConversations.id }).from(chatConversations).where(and(
            eq(chatConversations.companyId, f.companyId), eq(chatConversations.id, f.conversation.id))).for("update");
          const [{ pid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
          authorizationPid = Number(pid);
          acquiredAuthorization(); await heldAuthorization;
        });
        await authorizationLocked;
      }
      release(); await holding;
      if (mode === "authorization_expired") {
        processing = processDue();
        await vi.waitFor(async () => {
          const [{ blocked }] = await db.execute(sql`select exists(select 1 from pg_stat_activity
            where ${authorizationPid} = any(pg_blocking_pids(pid))) as blocked`);
          expect(blocked).toBe(true);
        }, { timeout: 5_000, interval: 25 });
        await new Promise(resolve => setTimeout(resolve, Math.max(0, authorizationDeadline - Date.now()) + 1));
        releaseAuthorization(); await authorizationHolding;
        await processing;
      } else await processDue();
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, waiting.id));
      expect(settled.status).toBe(mode === "early_release" ? "processed" : "failed");
      expect(settled.result?.identityContentionPending).toBeUndefined();
      if (mode !== "early_release") {
        expect(settled.result).toMatchObject({ code: "failed_chat_retry_contention_expired", attemptCount: 1 });
        expect(f.wakeup).toHaveBeenCalledOnce();
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]).toMatchObject({ status: "failed", runId: null });
        expect((await readAgentWakeupRequestsById(f.action.id))[0]).toEqual(originalInput);
        expect(await readChatPublicationsByEndpointId(f.endpoint.id)).toEqual(f.originalPublications);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(0);
      } else {
        await reconcileTaskChatRetryReceipts(db, { companyId: f.companyId, requestId: response.body.requestId });
        expect((await readAgentWakeupRequestsById(response.body.requestId))[0]?.runId).toBeTruthy();
        expect(f.wakeup).toHaveBeenCalledTimes(2);
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(run => run.retryOfRunId === f.runId)).toHaveLength(1);
      }
    } finally {
      releaseAuthorization(); release(); await authorizationHolding; await processing;
      await holding; await f.releaseIdentity(); await f.service.shutdown();
    }
  });

  it.each(["denied", "contended"] as const)("yields a %s inbound notice backlog between bounded passes without losing work", async mode => {
    const context = await deferredChatQueueFixture();
    const other = await deferredChatQueueFixture();
    const rejectedIds = Array.from({ length: 150 }, () => randomUUID());
    let release = () => {};
    let holder: Promise<unknown> | undefined;
    try {
      const [receipt] = await readAgentWakeupRequestsById(context.action.id);
      const at = new Date(context.action.createdAt.getTime() + (mode === "denied" ? -1000 : 1000)).toISOString();
      await db.insert(chatActions).values(rejectedIds.map(id => ({
        ...context.action, id, providerActionId: `inbound_wakeup:${id}`,
        payload: { ...context.action.payload, commentId: randomUUID() },
        createdAt: sql`${at}::timestamptz + interval '0.000123 seconds'`,
      })));
      await db.insert(agentWakeupRequests).values(rejectedIds.map(id => ({
        ...receipt, id, idempotencyKey: `chat-fairness-fixture:${id}`,
      })));
      if (mode === "contended") {
        let locked!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        holder = db.transaction(async tx => {
          await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, context.action.id)).for("update");
          locked(); await hold;
        });
        await ready;
      }
      const worker = chatInboundWakeNoticeWork(context.service);
      const [entry] = await worker.load({ companyId: context.fixture.companyId, issueId: context.conversation.issueId });
      const [otherEntry] = await worker.load({ companyId: other.fixture.companyId, issueId: other.conversation.issueId });
      const transaction = vi.spyOn(db, "transaction");
      try {
        let remaining = await worker.check(entry!);
        expect(transaction).toHaveBeenCalledTimes(100);
        expect(remaining).toMatchObject({ cursor: expect.any(Object), contended: mode === "contended" });
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
        // Another scope can finish while the first still has a saved cursor.
        expect(await worker.check(otherEntry!)).toBeNull();
        expect(await readChatPublicationsByEndpointId(other.endpoint.id)).toHaveLength(1);
        transaction.mockClear();
        remaining = await worker.check(remaining!);
        expect(transaction).toHaveBeenCalledTimes(51);
        if (mode === "contended") {
          expect(remaining).toMatchObject({ cursor: null });
          expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([]);
          release(); await holder;
          remaining = await worker.check(remaining!);
          expect(remaining).not.toBeNull();
          remaining = await worker.check(remaining!);
        }
        expect(remaining).toBeNull();
        expect(await readChatPublicationsByEndpointId(context.endpoint.id)).toEqual([expect.objectContaining({
          commentId: context.action.payload.commentId,
          payload: { text: "Your follow-up is queued.", progressState: "queued" },
        })]);
      } finally { transaction.mockRestore(); }
    } finally {
      release(); await holder;
      await context.service.shutdown(); await other.service.shutdown();
      await db.delete(chatActions).where(inArray(chatActions.id, [...rejectedIds, context.action.id]));
      await db.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, [...rejectedIds, context.action.id]));
    }
  });

  describe("provider timestamp provenance after closed conversations", () => {
    async function assertTimestampBinding(input: {
      context: Awaited<ReturnType<typeof configuredTeamsEndpoint>>;
      fixture: Awaited<ReturnType<typeof seedCompany>>;
      delivery: typeof chatDeliveries.$inferSelect;
      expected: string | null;
      marker: string;
    }) {
      const { context, fixture, delivery, expected, marker } = input;
      const normalized = delivery.normalizedEvent.message as Record<
        string,
        unknown
      >;
      expect(normalized.providerSentAt).toBe(expected);
      expect(normalized.providerSentAtSource).toBe(expected ? marker : undefined);
      await db
        .update(chatDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(chatDeliveries.id, delivery.id));
      await context.service.processPendingDeliveries(25, delivery.id);
      const [processed] = await readChatDeliveriesById(delivery.id);
      expect(processed).toMatchObject({
        state: "processed",
        normalizedEvent: delivery.normalizedEvent,
      });
      const [conversation] = await readChatConversationsById(processed!.conversationId!);
      const snapshot = await chatWakeContext({
        endpointId: context.endpoint.id,
        issueId: conversation!.issueId,
        provider: context.endpoint.provider,
        providerMessageId: String(normalized.providerMessageId),
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
      // Real service admission; the fixture scheduler does not run a model.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: fixture.companyId,
        agentId: fixture.assignedAgentId,
        runtimeMode: "native",
        nativeIssueId: conversation!.issueId,
        status: "running",
        wakeupRequestId: action!.id,
        startedAt: new Date(),
        contextSnapshot: { ...snapshot, paperclipHarnessCheckedOut: true },
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId, status: "claimed" })
        .where(eq(agentWakeupRequests.id, action!.id));
      const authority = () =>
        resolveChatRunPresentationAuthorizationReason(db, {
          companyId: fixture.companyId,
          issueId: conversation!.issueId,
          runId,
        });
      // Missing timestamp provenance does not disable ordinary no-close work.
      await expect(authority()).resolves.toBe("allow_chat_run_presentation");
      // Deliberately unproved historical-control fixture. This bare publication
      // is not an authorized /close and does not simulate a Teams personal
      // close remaining in the same generation. Valid source clocks cannot
      // manufacture its missing original command and authorization receipts.
      const [unprovedControl] = await db
        .insert(chatPublications)
        .values({
          companyId: fixture.companyId,
          endpointId: context.endpoint.id,
          conversationId: conversation!.id,
          issueId: conversation!.issueId,
          idempotencyKey: `control:close:timestamp-fixture:${randomUUID()}`,
          payload: { text: "Historical conversation close" },
          state: "published",
          providerMessageId: "historical-control",
          publishedAt: new Date(
            (expected ? Date.parse(expected) : delivery.receivedAt.getTime()) -
              5_000,
          ),
        })
        .returning({ id: chatPublications.id });
      await expect(
        db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            eq(
              chatActions.providerActionId,
              `task-control-authorization:${unprovedControl!.id}`,
            ),
          ),
      ).resolves.toEqual([]);
      await expect(authority()).resolves.toBe("internal_agent_write");
      // A retained SDK display clock, missing marker, or foreign marker cannot
      // turn that unproved history into permission to publish either.
      const legacyMessage: Record<string, unknown> = {
        ...normalized,
        providerSentAt: expected ?? delivery.receivedAt.toISOString(),
      };
      delete legacyMessage.providerSentAtSource;
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            ...delivery.normalizedEvent,
            message: legacyMessage,
          },
        })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
      await db
        .update(chatDeliveries)
        .set({
          normalizedEvent: {
            ...delivery.normalizedEvent,
            message: {
              ...legacyMessage,
              providerSentAtSource: "other_provider_clock",
            },
          },
        })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
      await db
        .update(chatDeliveries)
        .set({ normalizedEvent: delivery.normalizedEvent })
        .where(eq(chatDeliveries.id, delivery.id));
      await expect(authority()).resolves.toBe("internal_agent_write");
    }

    it.each([
      "missing",
      "empty",
      "invalid",
      "numeric",
      "hour24",
      "calendar",
      "valid",
      "date_object",
      "display_override",
    ] as const)(
      "retains only the actual Teams activity clock, not SDK display fallback (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const context = await configuredTeamsEndpoint(fixture, {
          deferWebhookProcessing: true,
          scheduleDeferredWork: () => undefined,
        });
        const config = context.runtime.configurations.get(
          context.endpoint.id,
        )!.providerConfig;
        if (config.provider !== "microsoft-teams")
          throw new Error("Expected Teams");
        const adapter = createTeamsAdapter({ ...config.credentials });
        const timestamp = new Date(Date.now() - 1_000).toISOString();
        const raw = {
          id: `timestamp-${randomUUID()}`,
          type: "message",
          channelId: "msteams",
          ...(mode === "missing"
            ? {}
            : {
                timestamp:
                  mode === "empty"
                    ? ""
                    : mode === "invalid"
                      ? "not-a-date"
                      : mode === "numeric"
                        ? Date.now()
                        : mode === "hour24"
                          ? "2026-09-08T24:00:00Z"
                          : mode === "calendar"
                            ? "2026-02-30T00:00:00Z"
                            : mode === "date_object"
                              ? new Date(timestamp)
                              : timestamp,
              }),
          serviceUrl: "https://smba.trafficmanager.net/amer/",
          from: {
            id: `29:${randomUUID()}`,
            aadObjectId: randomUUID(),
            name: "Timestamp fixture",
          },
          recipient: { id: `28:${config.credentials.appId}` },
          conversation: {
            id: `a:${randomUUID()}`,
            conversationType: "personal",
            tenantId: config.credentials.appTenantId,
          },
          channelData: { tenant: { id: config.credentials.appTenantId } },
          text: "Keep this exact timestamp source",
        };
        const message = adapter.parseMessage(raw);
        const providerRuntime = context.runtime.endpoints.get(
          context.endpoint.id,
        )!;
        const getThread = providerRuntime.thread.bind(providerRuntime);
        vi.spyOn(providerRuntime, "thread").mockImplementation((id) => ({
          ...getThread(id),
          isDM: adapter.isDM(id),
        }));
        if (mode === "display_override") message.metadata.dateSent = new Date();
        const display = message.metadata.dateSent.getTime();
        try {
          await deliverMessage({
            callbacks: context.callbacks,
            endpointId: context.endpoint.id,
            provider: "microsoft-teams",
            thread: makeThread({
              id: message.threadId,
              channelId: message.threadId,
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
          expect(delivery?.state).toBe("received");
          expect(message.metadata.dateSent.getTime()).toBe(display);
          await assertTimestampBinding({
            context,
            fixture,
            delivery: delivery!,
            expected: ["valid", "date_object", "display_override"].includes(
              mode,
            )
              ? timestamp
              : null,
            marker: "teams_activity_timestamp",
          });
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it.each(["ordinary", "task"] as const)(
      "retains only raw Telegram date through the pinned parser or runtime slash path (%s)",
      async (path) => {
        for (const mode of ["missing", "invalid", "valid"] as const) {
          const fixture = await seedCompany();
          const context = await configuredTelegramEndpoint(fixture, {
            deferWebhookProcessing: true,
            scheduleDeferredWork: () => undefined,
          });
          const configuration = context.runtime.configurations.get(
            context.endpoint.id,
          )!;
          if (configuration.providerConfig.provider !== "telegram")
            throw new Error("Expected Telegram");
          const current = await context.service.get(context.endpoint.id);
          const providerFetch = fakeTelegramFetch(
            Number(current.botExternalId),
          );
          const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) =>
              String(input).endsWith("/sendChatAction")
                ? Response.json({ ok: true, result: true })
                : providerFetch(input),
            );
          const pinned = createChatSdkEndpointRuntime({
            ...configuration,
            logger: "silent",
          });
          try {
            await pinned.initialize();
            const providerRuntime = context.runtime.endpoints.get(
              context.endpoint.id,
            )!;
            Object.assign(providerRuntime, {
              parseTelegramCommandMessage:
                pinned.parseTelegramCommandMessage.bind(pinned),
            });
            const date = Math.floor(Date.now() / 1_000) - 1;
            const text =
              path === "task"
                ? "/task Keep this exact timestamp source"
                : "Keep this exact timestamp source";
            const raw = {
              message_id: 41,
              ...(mode === "missing"
                ? {}
                : { date: mode === "invalid" ? "not-a-date" : date }),
              chat: { id: 77117711, type: "private" },
              from: {
                id: 77117711,
                is_bot: false,
                first_name: "Timestamp fixture",
              },
              text,
              ...(path === "task"
                ? { entities: [{ type: "bot_command", offset: 0, length: 5 }] }
                : {}),
            };
            if (path === "ordinary") {
              // Missing-date ordinary messages fail earlier SDK serialization;
              // isolate the real parser→service boundary here without claiming
              // that malformed ordinary input traverses the webhook dispatcher.
              const message = pinned.parseTelegramCommandMessage(raw)!;
              await deliverMessage({
                callbacks: context.callbacks,
                endpointId: context.endpoint.id,
                provider: "telegram",
                message,
                thread: makeThread({
                  id: message.threadId,
                  channelId: "77117711",
                  isDM: true,
                }).thread,
                trigger: "direct_message",
              });
            } else {
              const response = await pinned.handleWebhook(
                new Request("https://paperclip.example/timestamp-fixture", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-telegram-bot-api-secret-token":
                      configuration.providerConfig.credentials.secretToken,
                  },
                  body: JSON.stringify({ update_id: 900, message: raw }),
                }),
              );
              expect(response.status).toBe(200);
            }
            const [delivery] = await readChatDeliveriesByEndpointId(context.endpoint.id);
            expect(delivery?.state).toBe("received");
            await assertTimestampBinding({
              context,
              fixture,
              delivery: delivery!,
              expected:
                mode === "valid" ? new Date(date * 1_000).toISOString() : null,
              marker: "telegram_message_date",
            });
          } finally {
            await pinned.shutdown();
            fetchSpy.mockRestore();
            await retirePublicationFixture(
              context.service,
              context.endpoint.id,
            );
          }
        }
      },
    );
  });

  describe("Lossless long Board publications", { timeout: 45_000 }, () => {
    async function longFixture(
      provider: "slack" | "github" | "microsoft-teams",
    ) {
      const fixture = await seedCompany();
      const context =
        provider === "slack"
          ? await configuredSlackEndpoint(fixture)
          : provider === "github"
            ? await configuredGitHubEndpoint(fixture)
            : await configuredTeamsEndpoint(fixture);
      try {
        if (provider === "slack") {
          const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: fixture.companyId, provider: "slack", providerAccountId: "T-PAPERCLIP", externalId: "UBOARD" }).returning();
          await db.insert(chatIdentityLinks).values({ companyId: fixture.companyId, endpointId: context.endpoint.id, principalId: principal.id, paperclipUserId: "owner-user", status: "linked", confirmedAt: new Date() });
        }
        const teamsChannel = `teams:${Buffer.from("19:long-publication@thread.tacv2").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`;
        if (provider === "microsoft-teams") {
          await db.insert(chatEndpointResources).values({
            companyId: fixture.companyId,
            endpointId: context.endpoint.id,
            type: "channel",
            providerResourceId: "19:long-publication@thread.tacv2",
            label: "Long publication channel",
            availability: "available",
            enabled: true,
          });
        }
        const channel = makeThread({
          channelId:
            provider === "slack"
              ? "C-LONG-BOARD"
              : provider === "github"
                ? "paperclipai/paperclip"
                : teamsChannel,
          id:
            provider === "slack"
              ? "slack:C-LONG-BOARD:9900.1"
              : provider === "github"
                ? "github:paperclipai/paperclip:issue:9900"
                : `teams:${Buffer.from("19:long-publication@thread.tacv2;messageid=99001").toString("base64url")}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}`,
          name: "long-board",
        });
        await deliverMessage({
          callbacks: context.callbacks,
          endpointId: context.endpoint.id,
          provider,
          thread: channel.thread,
          message: makeMessage({
            id: provider === "slack" ? "9900.1" : "99001",
            text: "@maya begin the long Board publication fixture",
            mentioned: true,
          }),
          trigger: "mention",
        });
        await qualifySetupRoundTrip(context.service, context.endpoint.id);
        await context.service.test(context.endpoint.id);
        const [conversation] = await context.service.listConversations(
          context.endpoint.id,
        );
        if (!conversation)
          throw new Error("Expected long publication conversation");
        const transport = context.runtime.endpoints.get(context.endpoint.id)!;
        transport.posts.length = 0;
        return { ...context, fixture, conversation, transport, channel };
      } catch (error) {
        await retirePublicationFixture(context.service, context.endpoint.id);
        throw error;
      }
    }
    const orderedBatch = (commentId: string) =>
      readChatPublicationsByCommentId(commentId)
        .orderBy(
          asc(chatPublications.createdAt),
          asc(sql`${chatPublications.payload}->'transportPart'->>'orderKey'`),
        );

    it.each([
      ["slack", "new"],
      ["github", "existing"],
      ["microsoft-teams", "existing"],
    ] as const)(
      "preserves all 100000 characters for %s %s-comment publication",
      async (provider, source) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        try {
          const marker = "END-OF-100000-CHARACTER-BOARD-SEND";
          const body = "a".repeat(100_000 - marker.length) + marker;
          const comment =
            source === "existing"
              ? await issueService(db).addComment(conversation.issueId, body, {
                  userId: "owner-user",
                })
              : null;
          const publication = comment
            ? await service.publishComment(
                endpoint.id,
                conversation.id,
                comment.id,
              )
            : await service.publishBoardMessage(
                endpoint.id,
                conversation.id,
                body,
                "lossless-long-board-send",
                "owner-user",
              );
          for (let drain = 0; drain < 20; drain++)
            await service.processPendingPublications();
          expect(publication?.commentId).toBeTruthy();
          const expectedText = provider === "slack" && source === "new" ? `**Owner User (via Paperclip)**\n\n${body}` : body;
          const rows = await orderedBatch(publication!.commentId!);
          expect(rows.every((row) => row.state === "published")).toBe(true);
          expect(rows.map((row) => row.payload.text).join("") === expectedText).toBe(
            true,
          );
          expect(transport.posts.map((post) => post.text)).toEqual(
            rows.map((row) => renderPublicationTransportText(row.payload)),
          );
          expect(
            transport.posts.every((post) =>
              nativePublicationTextFits(provider, post.text),
            ),
          ).toBe(true);
          expect(rows.map(row => row.payload.text).join("").endsWith(marker)).toBe(true);
          const before = transport.posts.length;
          if (comment)
            await service.publishComment(
              endpoint.id,
              conversation.id,
              comment.id,
            );
          else
            await service.publishBoardMessage(
              endpoint.id,
              conversation.id,
              body,
              "lossless-long-board-send",
              "owner-user",
            );
          expect(transport.posts).toHaveLength(before);
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );

    it.each(["slack", "github", "microsoft-teams"] as const)(
      "preserves %s code, Unicode and sanitization expansion through actual durable parts",
      async (provider) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        try {
          const body =
            "```ts\n" +
            "const answer = '😀';\n".repeat(4_000) +
            "```\n\n" +
            "@here ".repeat(1_000) +
            "END-OF-RICH-BOARD";
          expect(body.length).toBeLessThanOrEqual(100_000);
          const safe = projectSafeChatPublicationText(provider === "slack" ? `**Owner User (via Paperclip)**\n\n${body}` : body);
          const publication = await service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            body,
            "long-rich-board-send",
            "owner-user",
          );
          for (let drain = 0; drain < 20; drain++)
            await service.processPendingPublications();
          const rows = await orderedBatch(publication.commentId!);
          expect(rows.every((row) => row.state === "published")).toBe(true);
          expect(rows.map((row) => row.payload.text).join("") === safe).toBe(
            true,
          );
          expect(transport.posts.map((post) => post.text)).toEqual(
            rows.map((row) => renderPublicationTransportText(row.payload)),
          );
          expect(
            transport.posts.every((post) =>
              nativePublicationTextFits(provider, post.text),
            ),
          ).toBe(true);
          expect(transport.posts.at(-1)?.text).toContain("END-OF-RICH-BOARD");
          expect(JSON.stringify(transport.posts)).not.toContain("@here");
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );

    it.each(["discord", "telegram"] as const)(
      "retains a complete 100000-character %s response in the existing Markdown document transport",
      async (provider) => {
        const context = await safeNativeProgressFixture(
          provider,
          provider === "discord" ? "811" : "812",
        );
        try {
          await qualifySetupRoundTrip(
            context.service,
            context.endpoint.id,
            provider === "telegram"
              ? context.thread.thread.channelId
              : "U-SAFE-PROGRESS",
          );
          await context.service.test(context.endpoint.id);
          context.providerRuntime.posts.length = 0;
          const marker = "\n```\nEND-OF-COMPLETE-DOCUMENT";
          const body =
            "```txt\n" + "x".repeat(100_000 - marker.length - 7) + marker;
          expect(body.length).toBe(100_000);
          const publication = await context.service.publishBoardMessage(
            context.endpoint.id,
            context.conversation.id,
            body,
            "long-document-board-send",
            "owner-user",
          );
          for (let drain = 0; drain < 5; drain++)
            await context.service.processPendingPublications();
          const rows = await orderedBatch(publication.commentId!);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.state).toBe("published");
          expect(rows[0]!.payload.text).toBe(body);
          expect(rows[0]!.payload.transportPart?.mode).toBe(
            `${provider}_markdown_attachment`,
          );
          expect(context.providerRuntime.posts).toHaveLength(1);
          const post = context.providerRuntime.posts[0]!;
          const upload = (
            provider === "discord" ? post.files?.[0] : post.attachments?.[0]
          ) as { data: Buffer };
          expect(Buffer.isBuffer(upload.data)).toBe(true);
          expect(upload.data.equals(Buffer.from(body))).toBe(true);
          await context.service.processPendingPublications();
          expect(context.providerRuntime.posts).toHaveLength(1);
        } finally {
          await retirePublicationFixture(context.service, context.endpoint.id);
        }
      },
    );

    it.each(["slack", "github"] as const)(
      "keeps an ambiguous %s text part blocked across restart and retries only that part and its tail",
      async (provider) => {
        const { service, endpoint, conversation, transport } =
          await longFixture(provider);
        let restarted: ChatChannelService | undefined;
        try {
          const body = "a".repeat(99_990) + "FINAL-TAIL";
          const expectedText = provider === "slack" ? `**Owner User (via Paperclip)**\n\n${body}` : body;
          let attempts = 0;
          transport.postHook = async () => {
            if (++attempts === 2)
              throw new Error("connection closed after request write");
          };
          const blocked = await service.publishBoardMessage(
            endpoint.id,
            conversation.id,
            body,
            "long-unknown-board-send",
            "owner-user",
          );
          expect(blocked.state).toBe("delivery_unknown");
          const initial = await orderedBatch(blocked.commentId!);
          expect(initial[0]!.state).toBe("published");
          expect(initial[1]!.id).toBe(blocked.id);
          expect(
            initial
              .slice(2)
              .every((row) => row.state === "pending" && row.attempts === 0),
          ).toBe(true);
          expect(attempts).toBe(2);
          await service.shutdown();
          const fresh = createService(new FakeChatSdkRuntime());
          restarted = fresh.service;
          await restarted.processPendingPublications();
          await restarted.processPendingPublications();
          expect(await orderedBatch(blocked.commentId!)).toEqual(initial);
          expect(fresh.runtime.endpoints.get(endpoint.id)?.posts ?? []).toEqual(
            [],
          );
          await expect(
            restarted.replayPublication(endpoint.id, blocked.id),
          ).rejects.toMatchObject({ status: 409 });
          await restarted.resolvePublication(
            endpoint.id,
            blocked.id,
            "retry_anyway",
            "owner-user",
          );
          for (let drain = 0; drain < 20; drain++)
            await restarted.processPendingPublications();
          const final = await orderedBatch(blocked.commentId!);
          expect(final[0]).toEqual(initial[0]);
          expect(final.every((row) => row.state === "published")).toBe(true);
          expect(final[1]!.attempts).toBe(2);
          expect(final.slice(2).every((row) => row.attempts === 1)).toBe(true);
          const resumed = fresh.runtime.endpoints.get(endpoint.id)!.posts;
          expect(final.map(row => row.payload.text).join("")).toBe(expectedText);
          expect([...transport.posts, ...resumed].map(post => post.text)).toEqual(
            final.map(row => renderPublicationTransportText(row.payload)),
          );
          expect(
            (
              await restarted.getPublicationBatchStatus(
                endpoint.id,
                conversation.id,
                initial[0]!.id,
              )
            ).published,
          ).toBe(final.length);
          await restarted.processPendingPublications();
          expect(await orderedBatch(blocked.commentId!)).toEqual(final);
        } finally {
          await service.shutdown();
          await retirePublicationFixture(restarted ?? service, endpoint.id);
        }
      },
    );

    it("preserves an accepted native Slack response whose rendered mentions exceed the Markdown cap", async () => {
      const summary = "@U12345678 ".repeat(1_080) + "NATIVE-END";
      expect(summary.length).toBeLessThan(12_000);
      const context = await committedChatResponseRecoveryFixture(
        "slack",
        "coordinator",
        false,
        undefined,
        () => summary,
      );
      try {
        expect(await context.repair()).toBe(true);
        const [comment] = await db
          .select()
          .from(issueComments)
          .where(eq(issueComments.createdByRunId, context.runId));
        await context.service.processPendingPublications(100);
        const rows = await orderedBatch(comment!.id);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((row) => row.state === "published")).toBe(true);
        expect(rows.map((row) => row.payload.text).join("")).toBe(
          summary.trim(),
        );
        expect(
          rows.every((row) =>
            nativePublicationTextFits(
              "slack",
              renderPublicationTransportText(row.payload),
            ),
          ),
        ).toBe(true);
        expect(await context.repair()).toBe(false);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    });

    it.each([
      { prefix: "https://private.example/?token=PRIVATE" },
      { suffix: { token: "PRIVATE" } },
    ])(
      "refuses malformed persisted wrappers before provider I/O %#",
      async (badWrapper) => {
        const { service, endpoint, conversation, transport, fixture } =
          await longFixture("slack");
        try {
          const comment = await issueService(db).addComment(
            conversation.issueId,
            "Safe content",
            { userId: "owner-user" },
          );
          const [publication] = await db
            .insert(chatPublications)
            .values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              conversationId: conversation.id,
              issueId: conversation.issueId,
              commentId: comment.id,
              idempotencyKey: `explicit:${comment.id}:${endpoint.id}`,
              state: "pending",
              payload: {
                text: "Safe content",
                transportPart: {
                  batchId: randomUUID(),
                  count: 1,
                  index: 0,
                  orderKey: "fixture:0000",
                  ...badWrapper,
                },
              } as never,
            })
            .returning();
          await service.processPendingPublications();
          expect(transport.posts).toEqual([]);
          const [after] = await readChatPublicationsById(publication!.id);
          expect(after!.state).toBe("failed");
          expect(after!.redactedError).not.toContain("PRIVATE");
          expect(after!.providerMessageId).toBeNull();
        } finally {
          await retirePublicationFixture(service, endpoint.id);
        }
      },
    );
  });
});
