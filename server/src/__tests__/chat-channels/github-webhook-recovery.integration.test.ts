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

describeEmbeddedPostgres("chat channels: github webhook recovery", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readChatDeliveriesByEndpointId, readChatDeliveriesById, readChatActionsById, readChatPublicationsById, readToolConnectionsById, readIssuesByCompanyId, createService, retirePublicationFixture, qualifySetupRoundTrip, deliverMessage } = h;
  const { githubWebhookVerificationResponse, recordGitHubWebhookVerification, signedGitHubWebhookRequest, configuredGitHubEndpoint, attachFakeGitHubIssueCommentWebhook, githubPreIngressRecoveryFixture } = gh;


  it("singleflights concurrent cold GitHub runtime initialization", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    await runtime.removeEndpoint(endpoint.id);
    const replacementsBeforeBurst = runtime.replaceCount;
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    runtime.initializeHook = () => initializationGate;
    const body = JSON.stringify({ installation: { id: 2468 } });
    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
    const send = (delivery: string) =>
      service.handleWebhook(
        endpoint.publicId,
        "github",
        new Request("https://paperclip.example/github", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "installation_repositories",
            "x-github-delivery": delivery,
            "x-hub-signature-256": `sha256=${signature}`,
          },
          body,
        }),
      );

    const requests = [send("github-cold-1"), send("github-cold-2")];
    await vi.waitFor(() => {
      expect(runtime.replaceCount).toBe(replacementsBeforeBurst + 1);
    });
    releaseInitialization();
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(runtime.replaceCount).toBe(replacementsBeforeBurst + 1);
    expect(
      runtime.endpoints.get(endpoint.id)?.initialize,
    ).toHaveBeenCalledTimes(1);
  });

  it("durably stages GitHub webhooks within budget before cold runtime initialization", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture, {
        githubWebhookResponseBudgetMs: 25,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    // The setup helper intentionally uses setImmediate until setup completes,
    // while this test replaces later work with a captured queue. Let those
    // setup-era callbacks join the runtime singleflight before measuring the
    // cold request so their replacement is not attributed to this webhook.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.reconcileProviderRuntimes();
    deferred.length = 0;
    await runtime.removeEndpoint(endpoint.id);
    const replacementsBeforeRequest = runtime.replaceCount;
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    runtime.initializeHook = () => initializationGate;

    const startedAt = Date.now();
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-cold-budget",
        event: "installation_repositories",
        payload: { installation: { id: 2468 } },
        webhookSecret,
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(202);
    expect(elapsedMs).toBeLessThan(500);
    // The durable response budget is intentionally independent of cold
    // runtime startup. Under a loaded event loop the 202 can win the budget
    // race before the background processor reaches replaceEndpoint, so wait
    // for the explicit initialization boundary instead of assuming same-tick
    // scheduling.
    await vi.waitFor(() => {
      expect(runtime.replaceCount).toBe(replacementsBeforeRequest + 1);
    });
    expect(deferred).toHaveLength(0);
    await expect(
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "github_webhook_ingress:github-cold-budget",
            ),
          ),
        )
        .then((rows) => rows[0]),
    ).resolves.toMatchObject({ status: "processing" });

    releaseInitialization();
    await vi.waitFor(
      () => {
        expect(
          runtime.endpoints.get(endpoint.id)?.webhookRequest,
        ).not.toBeNull();
      },
      { timeout: 2_000 },
    );
    await vi.waitFor(async () => {
      const action = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "github_webhook_ingress:github-cold-budget",
            ),
          ),
        )
        .then((rows) => rows[0]);
      expect(action).toMatchObject({ status: "processed" });
      expect(action?.payload).not.toHaveProperty("body");
    });
    await service.shutdown();
  });

  it("durably stages GitHub webhooks while credential mutation owns the processing lease", async () => {
    const fixture = await seedCompany();
    const deferred: Array<() => void> = [];
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture, {
        githubWebhookResponseBudgetMs: 25,
        scheduleDeferredWork: (task) => deferred.push(task),
      });
    deferred.length = 0;
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookRequest = null;
    await db.insert(chatEndpointLeases).values({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      leaseKey: "credentials",
      token: "external-credential-mutation",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const startedAt = Date.now();
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-authentication-lane-budget",
        event: "installation_repositories",
        payload: { installation: { id: 2468 } },
        webhookSecret,
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(202);
    expect(elapsedMs).toBeLessThan(500);
    expect(providerRuntime.webhookRequest).toBeNull();
    expect(deferred).toHaveLength(0);
    // The HTTP response budget can expire before the asynchronous worker has
    // claimed the durable receipt. Wait for its claim while the lease is held.
    await vi.waitFor(
      async () => {
        await expect(
          db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(
                  chatActions.providerActionId,
                  "github_webhook_ingress:github-authentication-lane-budget",
                ),
              ),
            )
            .then((rows) => rows[0]),
        ).resolves.toMatchObject({ status: "processing" });
      },
      { timeout: 2_000 },
    );

    await db
      .delete(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, endpoint.id),
          eq(chatEndpointLeases.leaseKey, "credentials"),
        ),
      );
    await vi.waitFor(
      () => {
        expect(providerRuntime.webhookRequest).not.toBeNull();
      },
      { timeout: 2_000 },
    );
    await vi.waitFor(async () => {
      const action = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              "github_webhook_ingress:github-authentication-lane-budget",
            ),
          ),
        )
        .then((rows) => rows[0]);
      expect(action).toMatchObject({ status: "processed" });
      expect(action?.payload).not.toHaveProperty("body");
    });
    await service.shutdown();
  });

  it("recovers an authenticated GitHub webhook after shutdown before deferred work starts", async () => {
    const fixture = await seedCompany();
    const configured = await configuredGitHubEndpoint(fixture);
    const deferred: Array<() => void> = [];
    const receiverRuntime = new FakeChatSdkRuntime();
    const receiver = createService(receiverRuntime, undefined, {
      deferWebhookProcessing: true,
      scheduleDeferredWork: (task) => deferred.push(task),
    }).service;
    const delivery = `github-restart-${randomUUID()}`;
    const bodyMarker = `restart-body-${randomUUID()}`;

    const response = await receiver.handleWebhook(
      configured.endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 97531,
            full_name: "paperclipai/paperclip",
            name: "paperclip",
            owner: { id: 1357, login: "paperclipai" },
          },
          issue: { number: 91 },
          comment: { id: 9191, body: bodyMarker },
          sender: { id: 42, login: "octocat" },
        },
        webhookSecret: configured.webhookSecret,
      }),
    );

    expect(response.status).toBe(202);
    expect(deferred).toHaveLength(1);
    const staged = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, configured.endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(staged).toMatchObject({
      status: "received",
      payload: expect.objectContaining({
        body: expect.stringContaining(bodyMarker),
      }),
    });
    const conflictingMarker = `conflicting-body-${randomUUID()}`;
    const conflictingDuplicate = await receiver.handleWebhook(
      configured.endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 97531,
            full_name: "paperclipai/paperclip",
            name: "paperclip",
            owner: { id: 1357, login: "paperclipai" },
          },
          issue: { number: 91 },
          comment: { id: 9191, body: conflictingMarker },
          sender: { id: 42, login: "octocat" },
        },
        webhookSecret: configured.webhookSecret,
      }),
    );
    expect(conflictingDuplicate.status).toBe(202);
    const afterConflictingDuplicate = await db
      .select({ payload: chatActions.payload })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, configured.endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      );
    expect(afterConflictingDuplicate).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          body: expect.stringContaining(bodyMarker),
        }),
      }),
    ]);
    expect(JSON.stringify(afterConflictingDuplicate[0]?.payload)).not.toContain(
      conflictingMarker,
    );

    // The scheduler never began the callback. Graceful shutdown must leave
    // the authenticated receipt available to the next server process.
    await receiver.shutdown();
    const restartedRuntime = new FakeChatSdkRuntime();
    const restarted = createService(restartedRuntime).service;
    await restarted.processPendingGitHubWebhookIngress(25, staged!.id);

    expect(
      restartedRuntime.endpoints.get(configured.endpoint.id)?.webhookRequest,
    ).not.toBeNull();
    const processed = await readChatActionsById(staged!.id)
      .then((rows) => rows[0]);
    expect(processed).toMatchObject({
      status: "processed",
      payload: expect.objectContaining({
        bodySha256: expect.any(String),
        redacted: true,
      }),
    });
    expect(processed?.payload).not.toHaveProperty("body");

    const recoveredRuntime = restartedRuntime.endpoints.get(
      configured.endpoint.id,
    );
    if (!recoveredRuntime) throw new Error("Expected recovered GitHub runtime");
    recoveredRuntime.webhookRequest = null;
    const duplicate = await restarted.handleWebhook(
      configured.endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 97531,
            full_name: "paperclipai/paperclip",
            name: "paperclip",
            owner: { id: 1357, login: "paperclipai" },
          },
          issue: { number: 91 },
          comment: { id: 9191, body: bodyMarker },
          sender: { id: 42, login: "octocat" },
        },
        webhookSecret: configured.webhookSecret,
      }),
    );
    expect(duplicate.status).toBe(202);
    expect(recoveredRuntime.webhookRequest).toBeNull();
    await restarted.shutdown();
    await configured.service.shutdown();
  });

  describe("GitHub webhook recovery scheduling", () => {
    it.each(["unconfigured", "disabled"])("leaves %s recovery quiet", async mode => {
      const f = mode === "unconfigured" ? null : await githubPreIngressRecoveryFixture();
      const service = f?.service ?? createService().service;
      if (f) {
        const [endpoint] = await readChatEndpointsById(f.endpoint.id);
        if (mode === "cloud") await db.update(chatEndpoints).set({ setup: { ...endpoint.setup,
          github: { ...endpoint.setup.github!, cloudRegistrationId: "relay-owned" } } }).where(eq(chatEndpoints.id, endpoint.id));
        else await service.configure(endpoint.id, { action: "pause" }, "owner-user");
        f.requests.length = 0;
      }
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); writes.mockRestore(); vi.useRealTimers(); }
        expect(f?.requests ?? []).toEqual([]); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each(["null", "deleted"])("rejects a %s assigned agent before GitHub recovery can become orphaned", async mode => {
      const f = await githubPreIngressRecoveryFixture();
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      await f.makeScanDue();


      const mutation = mode === "null"
        ? db.execute(sql`update ${chatEndpoints} set assigned_agent_id = null where ${chatEndpoints.id} = ${endpoint.id}`)
        : mode === "missing"
          ? db.update(chatEndpoints).set({ assignedAgentId: randomUUID() }).where(eq(chatEndpoints.id, endpoint.id))
          : db.delete(agents).where(eq(agents.id, endpoint.assignedAgentId));
      const integrityCode = mode === "null" ? "23502"
        : mode === "deleted" ? expect.stringMatching(/^(23001|23503)$/) : "23503";
      await expect(mutation).rejects.toMatchObject({ cause: { code: integrityCode } });
      expect((await readChatEndpointsById(endpoint.id))[0].assignedAgentId).toBe(endpoint.assignedAgentId);
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, endpoint.assignedAgentId)))
        .toEqual([{ id: endpoint.assignedAgentId }]);
      f.requests.length = 0;
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active,
          scheduled: (coordinator.nextWakeAt() ?? 0) > Date.now() + 30_000 }), { timeout: 5000 })
          .toEqual({ active: 0, scheduled: true });
        expect(f.posts).toHaveLength(1);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select");
        try { await vi.advanceTimersByTimeAsync(15_000); expect(reads).not.toHaveBeenCalled(); }
        finally { reads.mockRestore(); vi.useRealTimers(); }
        expect(f.posts).toHaveLength(1); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("waits for the saved recovery deadline and requests a genuine GitHub redelivery", async () => {
      const f = await githubPreIngressRecoveryFixture();
      await f.makeScanDue();
      const state = await f.checkpoint();
      const dueAt = Date.now() + 30_000;
      await db.update(chatSdkState).set({ value: { ...(state.value as Record<string, unknown>),
        nextScanAt: new Date(dueAt).toISOString() } }).where(eq(chatSdkState.id, state.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBe(dueAt);
        const reads = vi.spyOn(db, "select");
        try { await vi.advanceTimersByTimeAsync(15_000); expect(reads).not.toHaveBeenCalled(); }
        finally { reads.mockRestore(); }
        expect(f.requests).toEqual([]);
        await vi.advanceTimersByTimeAsync(16_000);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect(f.posts).toHaveLength(1); });
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect((await f.receipt())?.status).toBe("processed"); });
        expect(await f.ingress()).toBeUndefined(); expect(f.wakeup).not.toHaveBeenCalled();
        expect((await f.callback()).status).toBe(202);
        expect(await f.ingress()).toBeDefined();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("reactivates recovery from real resume and cancels its deadline on pause", async () => {
      const f = await githubPreIngressRecoveryFixture();
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      await db.update(chatEndpoints).set({ setup: { ...endpoint.setup, step: "complete" } }).where(eq(chatEndpoints.id, endpoint.id));
      await f.service.configure(f.endpoint.id, { action: "pause" }, "owner-user");
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        await expect.poll(() => coordinator.nextWakeAt(), { timeout: 5000 }).toBeNull();
        const oldVersion = (await f.checkpoint()).version;
        await f.service.configure(f.endpoint.id, { action: "resume" }, "owner-user");
        await expect.poll(async () => (await f.checkpoint()).version, { timeout: 5000 }).toBeGreaterThan(oldVersion);
        await expect.poll(() => {
          const next = coordinator.nextWakeAt();
          return { active: idleWorkSnapshot().active, future: next !== null && next > Date.now() + 30_000 };
        }, { timeout: 5000 }).toEqual({ active: 0, future: true });
        await f.service.configure(f.endpoint.id, { action: "pause" }, "owner-user");
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
      } finally { await coordinator.stop(); }
    });

    it.each(["restart", "standby"] as const)("reconstructs due GitHub recovery through %s", async mode => {
      const f = await githubPreIngressRecoveryFixture();
      await f.makeScanDue();
      let canRun = false;
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby" || canRun, onError: error => errors.push(error) });
      try {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => canRun).ready;
        if (mode === "restart") await coordinator.stop();
        const reads = vi.spyOn(db, "select");
        try { await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); }
        finally { reads.mockRestore(); }
        expect(f.requests).toEqual([]);
        canRun = true;
        if (mode === "restart") {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
          await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        }
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect((await f.receipt())?.status).toBe("processed"); });
        expect(f.posts).toHaveLength(1); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("retains GitHub recovery configuration intent through nested commit and rollback", async () => {
      const f = await githubPreIngressRecoveryFixture();
      const old = await f.checkpoint();
      const oldWindow = old.value as Record<string, unknown>;
      await db.update(chatSdkState).set({ value: { ...oldWindow,
        nextScanAt: new Date(Date.now() + 86_400_000).toISOString() } }).where(eq(chatSdkState.id, old.id));
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      const change = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
        await notifyChatEndpointConfiguration(tx, endpoint);
        await tx.update(chatEndpoints).set({ setup: { ...endpoint.setup,
          runtimeGeneration: Number(oldWindow.generation) + 1 } as typeof endpoint.setup }).where(eq(chatEndpoints.id, endpoint.id));
      };
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      let pauseRearm = false;
      let rearmEntered = false;
      let releaseRearm!: () => void;
      const rearmMayFinish = new Promise<void>(resolve => { releaseRearm = resolve; });
      const register = coordinator.register.bind(coordinator);
      const registration = vi.spyOn(coordinator, "register").mockImplementation((queue, task) => register(queue, {
        ...task,
        hasPending: async () => {
          const pending = await task.hasPending();
          if (pauseRearm) {
            const window = (await f.checkpoint()).value as Record<string, unknown>;
            if (window.generation === Number(oldWindow.generation) + 1 && window.outcome === "epoch_initialized") {
              rearmEntered = true;
              await rearmMayFinish;
            }
          }
          return pending;
        },
      }));
      let release!: () => void;
      let pending: Promise<unknown> | undefined;
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        await expect(db.transaction(async tx => { await tx.transaction(change); throw new Error("rollback epoch"); })).rejects.toThrow("rollback epoch");
        expect((await f.checkpoint()).version).toBe(old.version);
        let entered!: () => void;
        const held = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        pending = db.transaction(async tx => { await tx.transaction(change); entered(); await wait; });
        await held;
        expect((await f.checkpoint()).version).toBe(old.version);
        expect(f.requests).toEqual([]);
        pauseRearm = true; release(); await pending;
        await expect.poll(async () => (await f.checkpoint()).value, { timeout: 5000 }).toMatchObject({
          generation: Number(oldWindow.generation) + 1, outcome: "epoch_initialized" });
        await expect.poll(() => rearmEntered, { timeout: 5000 }).toBe(true);
        expect(f.requests).toEqual([]);
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(idleWorkSnapshot().active).toBeGreaterThan(0);
        pauseRearm = false;
        releaseRearm();
        await expect.poll(() => {
          const next = coordinator.nextWakeAt();
          return { active: idleWorkSnapshot().active, bounded: next !== null && next < Date.now() + 90_000 };
        }, { timeout: 5000 }).toEqual({ active: 0, bounded: true });
        expect(f.requests).toEqual([]);
      } finally { releaseRearm(); release?.(); await pending; await coordinator.stop(); registration.mockRestore(); }
    });

    it("preempts a future GitHub recovery window when only credential references change", async () => {
      const f = await githubPreIngressRecoveryFixture();
      const old = await f.checkpoint();
      const oldWindow = old.value as Record<string, unknown>;
      await db.update(chatSdkState).set({ value: { ...oldWindow,
        nextScanAt: new Date(Date.now() + 86_400_000).toISOString() } }).where(eq(chatSdkState.id, old.id));
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.endpoint.connectionId));
        await db.transaction(async tx => {
          await notifyChatEndpointConfiguration(tx, f.endpoint);
          await tx.update(toolConnections).set({ credentialSecretRefs: connection.credentialSecretRefs.map(ref => ({ ...ref,
            versionSelector: ref.versionSelector === 1 ? "latest" : 1 })) }).where(eq(toolConnections.id, connection.id));
        });
        // Credential synchronization and epoch initialization commit separately.
        // Require the final epoch receipt, not just the intermediate fingerprint.
        await expect.poll(async () => {
          const value = (await f.checkpoint()).value as Record<string, unknown>;
          return { ...value, fingerprintChanged: typeof value.credentialFingerprint === "string"
            && value.credentialFingerprint !== oldWindow.credentialFingerprint };
        }, { timeout: 5000 }).toMatchObject({
          fingerprintChanged: true, generation: oldWindow.generation, outcome: "epoch_initialized",
        });
        expect(f.requests).toEqual([]);
      } finally { await coordinator.stop(); }
    });

    it("recovers a failed GitHub deadline reconstruction after drain without passive SQL", async () => {
      const f = await githubPreIngressRecoveryFixture(); await f.makeScanDue();
      let canRun = true;
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true,
        onError: error => errors.push(error) });
      const reads = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("recovery inventory unavailable"); });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => canRun).ready;
        expect(errors).toHaveLength(1);
        reads.mockRestore(); canRun = false;
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
        const passive = vi.spyOn(db, "select");
        try { await vi.advanceTimersByTimeAsync(60_000); expect(passive).not.toHaveBeenCalled(); }
        finally { passive.mockRestore(); }
        canRun = true;
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(10); expect((await f.receipt())?.status).toBe("processed"); });
        expect(errors).toHaveLength(1);
      } finally { reads.mockRestore(); await coordinator.stop(); vi.useRealTimers(); }
    });

    it("reconstructs more than one page of GitHub recovery deadlines and dispatches fair batches of five", async () => {
      const first = await githubPreIngressRecoveryFixture(), second = await githubPreIngressRecoveryFixture();
      const ids: string[] = [];
      for (const [f, count] of [[first, 103], [second, 3]] as const) {
        const [endpoint] = await readChatEndpointsById(f.endpoint.id);
        const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, endpoint.connectionId));
        const copies = Array.from({ length: count }, () => ({ id: randomUUID(), connectionId: randomUUID(),
          appId: BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)).toString() }));
        await db.insert(toolConnections).values(copies.map(copy => ({ ...connection, id: copy.connectionId, uid: copy.connectionId })));
        await db.insert(chatEndpoints).values(copies.map(copy => ({ ...endpoint, id: copy.id, connectionId: copy.connectionId,
          publicId: copy.id, botExternalId: copy.appId, botUsername: "recovery-" + copy.id })));
        ids.push(...copies.map(copy => copy.id));
      }
      const windows = () => db.select({ companyId: chatSdkState.companyId }).from(chatSdkState).where(and(
        inArray(chatSdkState.endpointId, ids), eq(chatSdkState.stateKey, "paperclip:github-webhook-recovery:v1")));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      try {
        await first.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        const initial = await windows();
        expect(initial).toHaveLength(5);
        expect(new Set(initial.map(row => row.companyId)).size).toBe(2);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect(await windows()).toHaveLength(106);
        }, { timeout: 10_000 });
        expect(first.requests).toEqual([]); expect(second.requests).toEqual([]); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it.each([
      ["drain", false, false],
      ["shutdown", true, false],
      ["drain", false, true],
    ] as const)("preserves a GitHub redelivery stopped before transport (%s, prior receipt: %s, superseded: %s)", async (mode, priorReceipt, superseded) => {
      const f = await githubPreIngressRecoveryFixture();
      await f.makeScanDue();
      if (priorReceipt) {
        await f.service.processFailedGitHubWebhookDeliveries(5, f.endpoint.id);
        const sent = (await f.receipt())!;
        await db.update(chatActions).set({ result: { ...sent.result, retryAt: new Date(0).toISOString(),
          requestedAt: new Date(Date.now() - 60_000).toISOString() } }).where(eq(chatActions.id, sent.id));
        f.setDeliveries([{ ...f.original, id: "9007199254740994", redelivery: true,
          delivered_at: new Date(Date.now() - 15_000).toISOString() }, f.original]);
        await f.makeScanDue();
      }
      const previous = await f.receipt();
      let successor: Awaited<ReturnType<typeof f.receipt>> | undefined;
      f.posts.length = 0;
      let canRun = true, stoppedAfterClaim = false;
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true,
        onError: () => undefined });
      let stopping: Promise<void> | undefined;
      const transaction = db.transaction.bind(db);
      const transactions = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        const result = await transaction(callback, options);
        if (typeof result === "string" && !stoppedAfterClaim) {
          const receipt = await f.receipt();
          if (receipt?.id === result && receipt.status === "processing") {
            if (superseded) {
              await db.update(chatActions).set({ result: { ...receipt.result,
                requestedAt: new Date(Date.now() + 1000).toISOString() } }).where(eq(chatActions.id, receipt.id));
              successor = await f.receipt();
            }
            stoppedAfterClaim = true; canRun = false;
            if (mode === "shutdown") stopping = coordinator.stop();
          }
        }
        return result;
      }) as Db["transaction"]);
      try {
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => canRun).ready;
        await stopping;
        expect(stoppedAfterClaim).toBe(true); expect(f.posts).toEqual([]);
        if (superseded) expect(await f.receipt()).toEqual(successor);
        else if (previous) expect(await f.receipt()).toMatchObject({ status: previous.status,
          result: previous.result, payload: previous.payload });
        else expect(await f.receipt()).toBeUndefined();
        transactions.mockRestore();
        await coordinator.stop();
        await f.makeScanDue();
        canRun = true;
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
        await f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true).ready;
        if (superseded) {
          expect(f.posts).toEqual([]);
          expect(await f.receipt()).toEqual(successor);
        } else {
          expect(f.posts).toHaveLength(1);
          expect(await f.receipt()).toMatchObject({ status: "processed", result: { attempts: priorReceipt ? 2 : 1 } });
        }
      } finally { transactions.mockRestore(); await coordinator.stop(); await stopping; }
    });

    it("joins held GitHub history at shutdown without starting another HTTP request", async () => {
      const f = await githubPreIngressRecoveryFixture(); await f.makeScanDue();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      f.setBeforeList(async () => { entered(); await held; });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
      let deliveries = 0;
      const unrelated = coordinator.register(DELIVERY_QUEUES.feedback, { retryMs: 1000,
        run: async () => { deliveries++; }, hasPending: async () => false });
      await unrelated.ready;
      const worker = f.service.registerGitHubWebhookRecoveryWork(coordinator, () => true);
      let stopping: Promise<void> | undefined;
      try {
        await started;
        unrelated.wake();
        await expect.poll(() => deliveries).toBe(2);
        const count = f.requests.length;
        let stopped = false;
        stopping = coordinator.stop().then(() => { stopped = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stopped).toBe(false);
        release(); await worker.ready; await stopping;
        expect(f.requests).toHaveLength(count); expect(f.posts).toEqual([]);
        expect((await f.checkpoint()).value).toMatchObject({ outcome: "scan_failed" });
      } finally { release(); await (stopping ?? coordinator.stop()); }
    });
  });

  it("leaves Cloud-managed GitHub webhook recovery to the relay", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      const [endpoint] = await readChatEndpointsById(context.endpoint.id);
      await db.update(chatEndpoints).set({ setup: { ...endpoint.setup,
        github: { ...endpoint.setup.github!, cloudRegistrationId: "cloud-registration" },
      } }).where(eq(chatEndpoints.id, endpoint.id));
      const checkpoint = await context.checkpoint();
      await db.update(chatSdkState).set({ value: { ...(checkpoint.value as Record<string, unknown>), outcome: "callback_mismatch" } }).where(eq(chatSdkState.id, checkpoint.id));
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(5, endpoint.id);
      expect((await context.service.listActivity(endpoint.id)).some(row => row.summary === "GitHub webhook recovery needs attention")).toBe(false);
      expect(context.requests).toEqual([]);
      expect(context.posts).toEqual([]);
    } finally { await context.service.shutdown(); }
  });

  it("automatically recovers a pre-ingress GitHub failure only through a genuine callback and normal durable workers", async () => {
    const context = await githubPreIngressRecoveryFixture();
    const { service, endpoint } = context;
    try {
      await context.makeScanDue();
      await service.processFailedGitHubWebhookDeliveries(5, endpoint.id);
      expect(context.posts).toEqual([
        `/app/hook/deliveries/${context.deliveryId}/attempts`,
      ]);
      expect(await context.ingress()).toBeUndefined();
      expect(context.wakeup).not.toHaveBeenCalled();
      const receipt = await context.receipt();
      expect(receipt).toMatchObject({
        status: "processed",
        result: { attempts: 1, latestAttemptId: context.deliveryId },
      });
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain(context.body);
      expect(serialized).not.toContain("private-provider-header-canary");
      expect(serialized).not.toContain("private-proxy-body-canary");
      const repairActivity = async () =>
        (await service.listActivity(endpoint.id)).find(
          (entry) => entry.id === receipt!.id,
        );
      expect(await repairActivity()).toMatchObject({
        kind: "repair",
        status: "pending",
        summary: "GitHub webhook redelivery requested",
        detail: expect.stringContaining(
          "does not yet confirm receipt or a reply",
        ),
      });
      // A coincident GUID in another endpoint's inbox is not this callback's
      // receipt, even when that other endpoint has already processed it.
      const other = await service.create(
        context.fixture.companyId,
        {
          provider: "github",
          assignedAgentId: context.fixture.assignedAgentId,
          name: "Unrelated GitHub receipt",
        },
        "owner-user",
      );
      await db.insert(chatActions).values({
        companyId: context.fixture.companyId,
        endpointId: other.id,
        kind: "github_webhook_ingress",
        providerActionId: `github_webhook_ingress:${context.guid}`,
        status: "processed",
        payload: {
          version: 1,
          deliveryId: context.guid,
          eventType: "issue_comment",
          redacted: true,
        },
      });
      expect(await repairActivity()).toMatchObject({
        status: "pending",
        summary: "GitHub webhook redelivery requested",
      });

      // A successful recovery POST is not a delivery. Only the separately
      // authenticated provider callback may put content into the durable inbox.
      expect((await context.callback("not-the-secret")).status).toBe(401);
      expect(await context.ingress()).toBeUndefined();
      expect((await context.callback()).status).toBe(202);
      const ingress = await context.ingress();
      expect(ingress).toMatchObject({ status: "received" });
      await service.processPendingGitHubWebhookIngress(1, ingress!.id);
      const deliveries = await readChatDeliveriesByEndpointId(endpoint.id);
      for (const delivery of deliveries) {
        // Advance only this fixture's persisted coalescing deadline; the
        // production batching delay is exercised by its dedicated tests.
        await db
          .update(chatDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(chatDeliveries.id, delivery.id));
        await service.processPendingDeliveries(1, delivery.id);
      }
      expect(context.wakeup).toHaveBeenCalledTimes(1);
      const tasks = await readIssuesByCompanyId(context.fixture.companyId);
      expect(tasks).toHaveLength(1);
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, tasks[0]!.id));
      expect(comments).toEqual([{ body: context.body }]);
      expect(await context.ingress()).toMatchObject({
        status: "processed",
        payload: { redacted: true },
      });
      expect(await repairActivity()).toMatchObject({
        kind: "repair",
        status: "received",
        summary: "GitHub webhook received after recovery request",
        detail:
          "Paperclip received this callback. Its normal access checks and processing still apply.",
        replayable: false,
        resolutionActions: [],
      });

      await context.callback();
      await context.makeScanDue();
      await service.processFailedGitHubWebhookDeliveries(5, endpoint.id);
      expect(context.posts).toHaveLength(1);
      expect(context.wakeup).toHaveBeenCalledTimes(1);
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("does not adopt historical pre-ingress GitHub failures when initializing a recovery epoch", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue(false);
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toEqual([]);
      expect(await context.receipt()).toBeUndefined();
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("immediately initializes a new GitHub recovery generation despite the previous epoch's 24-hour backoff", async () => {
    const context = await githubPreIngressRecoveryFixture();
    const baseTime = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(baseTime));
      const oldState = await context.checkpoint();
      const oldWindow = oldState.value as Record<string, unknown>;
      const previousDeadline = new Date(
        baseTime + 24 * 60 * 60_000,
      ).toISOString();
      await db
        .update(chatSdkState)
        .set({ value: { ...oldWindow, nextScanAt: previousDeadline } })
        .where(eq(chatSdkState.id, oldState.id));
      const oldFailure = {
        ...context.original,
        id: "91000",
        guid: randomUUID(),
      };

      await context.service.configure(
        context.endpoint.id,
        { action: "pause" },
        "owner-user",
      );
      await context.service.configure(
        context.endpoint.id,
        { action: "reconnect" },
        "owner-user",
      );
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      context.requests.length = 0;
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      const reset = (await context.checkpoint()).value as Record<
        string,
        unknown
      >;
      expect(reset.generation).not.toBe(oldWindow.generation);
      expect(reset.floor).toBe(new Date(baseTime).toISOString());
      expect(Date.parse(String(reset.nextScanAt))).toBe(baseTime + 60_000);
      expect(context.requests).toEqual([]);
      expect(context.posts).toEqual([]);

      // This message belongs to the new window; the other failure predates
      // reconnect and must never be adopted when the old backoff is cleared.
      const createdAt = new Date(baseTime + 1_000).toISOString();
      context.original.delivered_at = createdAt;
      context.payload.comment.created_at = createdAt;
      context.payload.comment.updated_at = createdAt;
      context.setCanonicalComment({
        created_at: createdAt,
        updated_at: createdAt,
      });
      context.setDeliveries([context.original, oldFailure]);
      vi.setSystemTime(new Date(baseTime + 61_000));
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toEqual([
        `/app/hook/deliveries/${context.deliveryId}/attempts`,
      ]);
      expect(
        context.requests.some((entry) =>
          entry.pathname.includes(oldFailure.id),
        ),
      ).toBe(false);
      expect(await context.receipt()).toMatchObject({
        payload: { generation: reset.generation, floor: reset.floor },
        result: { attempts: 1 },
      });
    } finally {
      vi.useRealTimers();
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it.each(["received", "processed"])(
    "suppresses automatic pre-ingress GitHub redelivery for any existing local receipt (%s)",
    async (status) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        await context.callback();
        const ingress = await context.ingress();
        await db
          .update(chatActions)
          .set({ status, result: { attempts: 5, retryable: false } })
          .where(eq(chatActions.id, ingress!.id));
        const before = await context.ingress();
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        expect(await context.receipt()).toBeUndefined();
        expect(await context.ingress()).toEqual(before);
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("coalesces concurrent automatic pre-ingress GitHub scans into one provider redelivery", async () => {
    const context = await githubPreIngressRecoveryFixture();
    const competitor = createService(
      new FakeChatSdkRuntime(),
      context.providerFetch,
    ).service;
    let release!: () => void;
    let entered!: () => void;
    const parked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      context.setBeforeList(async () => {
        entered();
        await barrier;
      });
      await context.makeScanDue();
      const scans = Promise.all([
        context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        ),
        competitor.processFailedGitHubWebhookDeliveries(5, context.endpoint.id),
      ]);
      await parked;
      release();
      await scans;
      expect(
        context.requests.filter(
          (request) => request.pathname === "/app/hook/deliveries",
        ),
      ).toHaveLength(1);
      expect(context.posts).toHaveLength(1);
      expect(await context.receipt()).toMatchObject({
        result: { attempts: 1 },
      });
    } finally {
      release();
      await competitor.shutdown();
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("does not retry automatic pre-ingress GitHub redelivery without a distinct failed provider attempt", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      const receipt = await context.receipt();
      await db
        .update(chatActions)
        .set({
          result: { ...receipt!.result, retryAt: new Date(0).toISOString() },
        })
        .where(eq(chatActions.id, receipt!.id));
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      expect(await context.receipt()).toMatchObject({
        result: { attempts: 1, latestAttemptId: context.deliveryId },
      });
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it.each(["pending", "4xx"])(
    "does not request automatic pre-ingress GitHub recovery while the latest provider attempt is %s",
    async (state) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        context.setDeliveries([
          {
            ...context.original,
            id: "9007199254740994",
            redelivery: true,
            status_code:
              state === "pending" ? null : state === "4xx" ? 400 : 502,
            throttled_at:
              state === "throttled" ? new Date().toISOString() : null,
            delivered_at: new Date(
              Date.now() - (state === "too recent" ? 1_000 : 15_000),
            ).toISOString(),
          },
          context.original,
        ]);
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        expect(await context.receipt()).toBeUndefined();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("does not let ineligible pre-ingress GitHub candidates exhaust every future recovery scan", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      const bots = Array.from({ length: 5 }, (_, index) => ({
        ...context.original,
        id: String(10_000 + index),
        guid: randomUUID(),
      }));
      for (const bot of bots)
        context.setDetail(bot, {
          ...context.payload,
          comment: {
            ...context.payload.comment,
            user: { ...context.payload.comment.user, type: "Bot" },
          },
        });
      context.setDeliveries([...bots, context.original]);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toEqual([]);
      const rejected = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, context.endpoint.id),
            eq(chatActions.kind, "github_webhook_recovery"),
          ),
        );
      expect(rejected).toHaveLength(5);
      for (const receipt of rejected) {
        expect(receipt).toMatchObject({
          status: "cancelled",
          result: { attempts: 0 },
        });
        expect(receipt.payload.original).toEqual({
          id: expect.any(String),
          guid: expect.any(String),
        });
      }
      expect(JSON.stringify(rejected)).not.toContain(context.body);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      expect(
        context.requests.filter((request) =>
          /^\/app\/hook\/deliveries\/\d+$/.test(request.pathname),
        ),
      ).toHaveLength(6);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("quarantines an ambiguous automatic pre-ingress GitHub redelivery without blindly repeating the POST", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      context.setBeforePost(async () => {
        throw new Error(
          "provider connection closed after accepting the request",
        );
      });
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(await context.receipt()).toMatchObject({
        status: "delivery_unknown",
        result: { attempts: 1 },
      });
      const receipt = await context.receipt();
      await db
        .update(chatActions)
        .set({
          result: { ...receipt!.result, retryAt: new Date(0).toISOString() },
        })
        .where(eq(chatActions.id, receipt!.id));
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      expect(context.wakeup).not.toHaveBeenCalled();
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it.each(["successful sibling", "disabled repository"])(
    "rejects automatic pre-ingress GitHub recovery after %s",
    async (change) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        if (change === "successful sibling")
          context.setDeliveries([
            {
              ...context.original,
              id: "9007199254740994",
              redelivery: true,
              status_code: 202,
              delivered_at: new Date(Date.now() - 15_000).toISOString(),
            },
            context.original,
          ]);
        if (change === "edited comment")
          context.setCanonicalComment({
            body: "edited after the original callback",
          });
        if (change === "disabled repository") {
          const resources = await context.service.listResources(
            context.endpoint.id,
          );
          await context.service.replaceResources(
            context.endpoint.id,
            resources.map((resource) => ({ id: resource.id, enabled: false })),
          );
        }
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        if (change === "edited comment") {
          expect(await context.receipt()).toMatchObject({
            status: "cancelled",
            result: { attempts: 0, code: "source_changed_or_unavailable" },
          });
          expect(await chatHistoryActionBlocks(db, (await context.receipt())!.id)).toBe(false);
        } else expect(await context.receipt()).toBeUndefined();
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it.each(["truncated history", "ordering drift"])(
    "fails closed on automatic pre-ingress GitHub recovery with %s",
    async (mode) => {
      const context = await githubPreIngressRecoveryFixture();
      try {
        if (mode === "truncated history") context.setHistoryHasMore(true);
        else
          context.setDeliveries([
            context.original,
            {
              ...context.original,
              id: "9007199254740994",
              guid: randomUUID(),
              delivered_at: new Date(Date.now() - 15_000).toISOString(),
            },
          ]);
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toEqual([]);
        expect(await context.receipt()).toBeUndefined();
        expect((await context.checkpoint()).value).toMatchObject({
          outcome:
            mode === "truncated history"
              ? "history_limit_reached"
              : "scan_failed",
        });
        expect(
          context.requests.filter(
            (request) => request.pathname === "/app/hook/deliveries",
          ),
        ).toHaveLength(mode === "truncated history" ? 3 : 1);
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("stops automatic pre-ingress GitHub pagination at the epoch floor without adopting older failures", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      context.setHistoryHasMore(true);
      context.setDeliveries([
        context.original,
        {
          ...context.original,
          id: "9007199254740994",
          guid: randomUUID(),
          delivered_at: new Date(Date.now() - 180_000).toISOString(),
        },
      ]);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      expect(
        context.requests.filter(
          (request) => request.pathname === "/app/hook/deliveries",
        ),
      ).toHaveLength(1);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it.each(["issue", "sender"])(
    "rejects a signed automatic GitHub callback whose original %s identity changed",
    async (field) => {
      const context = await githubPreIngressRecoveryFixture(
        field === "pull request"
          ? "pull_request_review_comment"
          : "issue_comment",
      );
      try {
        await context.makeScanDue();
        await context.service.processFailedGitHubWebhookDeliveries(
          5,
          context.endpoint.id,
        );
        expect(context.posts).toHaveLength(1);
        const changed = {
          ...context.payload,
          ...(field === "issue" ? { issue: { id: 9290, number: 92 } } : {}),
          ...(field === "pull request"
            ? { pull_request: { id: 9290, number: 92 } }
            : {}),
          ...(field === "sender"
            ? { sender: { id: 99, login: "different-user", type: "User" } }
            : {}),
          ...(field === "action" ? { action: "edited" } : {}),
        };
        expect(
          (await context.callback(context.webhookSecret, changed)).status,
        ).toBe(200);
        expect(await context.ingress()).toBeUndefined();
        expect(context.wakeup).not.toHaveBeenCalled();
      } finally {
        await retirePublicationFixture(context.service, context.endpoint.id);
      }
    },
  );

  it("rechecks canonical content before processing an automatically recovered GitHub callback", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      await context.callback();
      const staged = await context.ingress();
      expect(staged).toMatchObject({ status: "received" });
      context.setCanonicalComment({
        body: "changed after successful callback staging",
      });
      await context.service.processPendingGitHubWebhookIngress(1, staged!.id);
      expect(await context.ingress()).toMatchObject({
        status: "cancelled",
        result: { code: "github_webhook_recovery_source_changed" },
        payload: { redacted: true },
      });
      expect(context.wakeup).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, context.fixture.companyId)),
      ).toEqual([]);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("denies a stale automatic GitHub callback after pause and reconnect even with the still-current HMAC secret", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      const receipt = await context.receipt();
      expect(receipt).toBeDefined();
      await context.service.configure(
        context.endpoint.id,
        { action: "pause" },
        "owner-user",
      );
      expect((await context.callback()).status).toBe(200);
      expect(await context.ingress()).toBeUndefined();
      await context.service.configure(
        context.endpoint.id,
        { action: "reconnect" },
        "owner-user",
      );
      expect((await context.callback()).status).toBe(200);
      expect(await context.ingress()).toBeUndefined();
      expect(await context.receipt()).toEqual(receipt);
      expect(context.wakeup).not.toHaveBeenCalled();
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("never re-arms a failed local GitHub receipt when an automatic redelivery races the original callback", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
      await context.callback();
      const ingress = await context.ingress();
      context.providerRuntime.webhookHook = undefined;
      context.providerRuntime.webhookResponse = new Response(
        "invalid provider content",
        { status: 400 },
      );
      await context.service.processPendingGitHubWebhookIngress(1, ingress!.id);
      const failed = await context.ingress();
      expect(failed).toMatchObject({
        status: "failed",
        result: { attempts: 1, retryable: false },
      });
      context.providerRuntime.webhookResponse = new Response(null, {
        status: 202,
      });
      await context.callback();
      expect(await context.ingress()).toEqual(failed);
      await context.makeScanDue();
      await context.service.processFailedGitHubWebhookDeliveries(
        5,
        context.endpoint.id,
      );
      expect(context.posts).toHaveLength(1);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("never stores a GitHub webhook body before its signature is authenticated", async () => {
    const fixture = await seedCompany();
    const { endpoint, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const delivery = `github-invalid-${randomUUID()}`;
    const marker = `must-not-persist-${randomUUID()}`;
    const signed = signedGitHubWebhookRequest({
      delivery,
      event: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 2468 },
        repository: {
          id: 97531,
          full_name: "paperclipai/paperclip",
          name: "paperclip",
          owner: { id: 1357, login: "paperclipai" },
        },
        issue: { number: 91 },
        comment: { id: 9191, body: marker },
        sender: { id: 42, login: "octocat" },
      },
      webhookSecret,
    });
    const headers = new Headers(signed.headers);
    headers.set("x-hub-signature-256", "sha256=invalid");
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      new Request(signed, { headers }),
    );

    expect(response.status).toBe(401);
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              `github_webhook_ingress:${delivery}`,
            ),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      db.execute(
        sql`select id from chat_actions where endpoint_id = ${endpoint.id} and payload::text like ${`%${marker}%`}`,
      ),
    ).resolves.toHaveLength(0);
    await service.shutdown();
  });

  it("records one content-free GitHub receipt for a disabled repository without admitting work", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret, wakeup } =
      await configuredGitHubEndpoint(fixture);
    await db
      .update(chatEndpoints)
      .set({ status: "active" })
      .where(eq(chatEndpoints.id, endpoint.id));
    const resources = await service.listResources(endpoint.id);
    await service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: false },
    ]);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookRequest = null;
    const delivery = `github-disabled-${randomUUID()}`;
    const marker = `private-disabled-body-${randomUUID()}`;
    const makeRequest = () =>
      signedGitHubWebhookRequest({
        delivery,
        event: "issue_comment",
        payload: {
          action: "created",
          installation: { id: 2468 },
          repository: {
            id: 97531,
            full_name: "paperclipai/paperclip",
            name: "paperclip",
            owner: { id: 1357, login: "paperclipai" },
          },
          issue: { number: 91, body: marker },
          comment: { id: 9191, body: marker },
          sender: { id: 42, login: "private-disabled-author" },
        },
        webhookSecret,
      });
    const invalid = makeRequest();
    invalid.headers.set("x-hub-signature-256", "sha256=invalid");
    expect(
      (await service.handleWebhook(endpoint.publicId, "github", invalid))
        .status,
    ).toBe(401);
    await expect(
      readChatDeliveriesByEndpointId(endpoint.id),
    ).resolves.toEqual([]);

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        service.handleWebhook(endpoint.publicId, "github", makeRequest()),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const rows = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "filtered",
      eventKind: "message",
      conversationId: null,
      principalId: null,
      redactedError: "Destination is not enabled in Paperclip",
      normalizedEvent: {
        kind: "message",
        filtering: {
          contentRetained: false,
          reason: "destination_not_enabled",
          resourceId: resources[0]!.id,
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain(marker);
    expect(JSON.stringify(rows)).not.toContain("private-disabled-author");
    expect(Object.keys(rows[0]!.normalizedEvent).sort()).toEqual([
      "filtering",
      "kind",
      "providerEventId",
    ]);
    expect(providerRuntime.webhookRequest).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
    await expect(service.listConversations(endpoint.id)).resolves.toEqual([]);
    await expect(service.listActivity(endpoint.id)).resolves.toContainEqual(
      expect.objectContaining({
        id: rows[0]!.id,
        status: "filtered",
        summary: "message ignored",
        detail: "Destination is not enabled in Paperclip",
        replayable: false,
      }),
    );
    await expect(
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(
              chatActions.providerActionId,
              `github_webhook_ingress:${delivery}`,
            ),
          ),
        ),
    ).resolves.toEqual([]);

    await service.replaceResources(endpoint.id, [
      { id: resources[0]!.id, enabled: true },
    ]);
    await service.processPendingDeliveries();
    expect(
      wakeup.mock.calls.some(
        ([, options]) =>
          options?.durableChatRequest?.companyId === fixture.companyId,
      ),
    ).toBe(false);
    expect(providerRuntime.webhookRequest).toBeNull();
    await service.shutdown();
  });

  it("does not retain signed GitHub events outside the configured App event set", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookRequest = null;
    const delivery = `github-unsupported-${randomUUID()}`;
    const marker = `unsupported-body-${randomUUID()}`;
    const response = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "issues",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          issue: { body: marker },
        },
        webhookSecret,
      }),
    );

    expect(response.status).toBe(200);
    expect(providerRuntime.webhookRequest).toBeNull();
    await expect(
      db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.kind, "github_webhook_ingress"),
            sql`${chatActions.payload}::text like ${`%${marker}%`}`,
          ),
        ),
    ).resolves.toEqual([]);
    await service.shutdown();
  });

  it("drains accepted GitHub webhooks from commit wakes and durable retry deadlines", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } = await configuredGitHubEndpoint(fixture, {
      deferWebhookProcessing: true, scheduleDeferredWork: () => undefined,
    });
    const providerRuntime = runtime.endpoints.get(endpoint.id)!;
    let attempts = 0;
    providerRuntime.webhookHook = async () => {
      providerRuntime.webhookResponse = new Response("result", { status: ++attempts === 1 ? 503 : 202 });
    };
    const delivery = randomUUID();
    const send = () => service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
      delivery, event: "installation_repositories", payload: { action: "added", installation: { id: 2468 } }, webhookSecret,
    }));
    const onError = vi.fn();
    let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const receipt = () => db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.providerActionId, `github_webhook_ingress:${delivery}`))).then(rows => rows[0]);
    try {
      await registerChatActionWork(coordinator, service, () => true).ready;
      expect((await send()).status).toBe(202);
      await expect.poll(async () => (await receipt())?.status, { timeout: 10_000 }).toBe("processed");
      expect(attempts).toBe(2);
      expect((await receipt())?.result).toMatchObject({ attempts: 2, httpStatus: 202 });
      // A duplicate callback wakes the lane but cannot repeat a settled effect.
      await send();
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
      expect(attempts).toBe(2);
      await coordinator.stop();
      // Work committed while no worker exists is recovered by the next startup.
      const restartDelivery = randomUUID();
      await service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
        delivery: restartDelivery, event: "installation_repositories",
        payload: { action: "added", installation: { id: 2468 } }, webhookSecret,
      }));
      expect(attempts).toBe(2);
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      await registerChatActionWork(coordinator, service, () => true).ready;
      await expect.poll(() => attempts, { timeout: 10_000 }).toBe(3);
      expect(onError).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); }
  });

  it("safely re-arms an exact terminal GitHub delivery after an operator redelivery", async () => {
    const fixture = await seedCompany();
    const { endpoint, runtime, service, webhookSecret } =
      await configuredGitHubEndpoint(fixture);
    const providerRuntime = runtime.endpoints.get(endpoint.id);
    if (!providerRuntime) throw new Error("Expected GitHub provider runtime");
    providerRuntime.webhookResponse = new Response("bad payload", {
      status: 400,
    });
    const webhookHook = vi.fn(async () => undefined);
    providerRuntime.webhookHook = webhookHook;
    const delivery = `github-terminal-${randomUUID()}`;
    const makeRequest = () =>
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: { action: "added", installation: { id: 2468 } },
        webhookSecret,
      });

    const first = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(first.status).toBe(400);
    const terminal = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      )
      .then((rows) => rows[0]);
    expect(terminal).toMatchObject({
      status: "failed",
      result: expect.objectContaining({
        attempts: 1,
        httpStatus: 400,
        retryable: false,
      }),
      payload: expect.objectContaining({ redacted: true }),
    });
    expect(webhookHook).toHaveBeenCalledTimes(1);
    await expect(service.listActivity(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminal!.id,
          kind: "action",
          actionType: "github_webhook_ingress",
          status: "failed",
          summary: "GitHub webhook could not be processed",
          detail: expect.stringContaining(delivery),
          replayable: false,
        }),
      ]),
    );

    const conflictingDuplicate = await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: {
          action: "removed",
          installation: { id: 2468 },
          marker: "different authenticated body",
        },
        webhookSecret,
      }),
    );
    expect(conflictingDuplicate.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(1);
    await expect(
      readChatActionsById(terminal!.id)
        .then((rows) => rows[0]),
    ).resolves.toMatchObject({
      status: "failed",
      result: expect.objectContaining({
        attempts: 1,
        httpStatus: 400,
        retryable: false,
      }),
      payload: expect.objectContaining({ redacted: true }),
    });

    providerRuntime.webhookResponse = new Response("accepted", { status: 202 });
    const recovered = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(recovered.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(2);
    await expect(
      readChatActionsById(terminal!.id)
        .then((rows) => rows[0]),
    ).resolves.toMatchObject({
      status: "processed",
      result: expect.objectContaining({ attempts: 2, httpStatus: 202 }),
      payload: expect.objectContaining({ redacted: true }),
    });

    const processedDuplicate = await service.handleWebhook(
      endpoint.publicId,
      "github",
      makeRequest(),
    );
    expect(processedDuplicate.status).toBe(202);
    expect(webhookHook).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("cancels staged GitHub ingress when same-secret pause and resume wins at the replay barrier", async () => {
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = await githubPreIngressRecoveryFixture(
      "issue_comment",
      async () => {
        if (armed) {
          entered();
          await barrier;
        }
      },
    );
    let worker:
      | ReturnType<typeof context.service.processPendingGitHubWebhookIngress>
      | undefined;
    const sdkDispatch = vi.fn();
    try {
      const [record] = await readChatEndpointsById(context.endpoint.id);
      await db
        .update(chatEndpoints)
        .set({ setup: { ...record!.setup, step: "complete" } })
        .where(eq(chatEndpoints.id, context.endpoint.id));
      const refs = () =>
        db
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(eq(toolConnections.id, record!.connectionId))
          .then((rows) => rows[0]!.refs);
      const originalRefs = await refs();
      const botUsername = (await context.service.get(context.endpoint.id))
        .botUsername!;
      const wireRuntime = async () => {
        const runtime = context.runtime.endpoints.get(context.endpoint.id)!;
        const callbacks = context.runtime.configurations.get(
          context.endpoint.id,
        )!.callbacks;
        attachFakeGitHubIssueCommentWebhook({
          botUsername,
          callbacks,
          endpointId: context.endpoint.id,
          runtime,
        });
        const dispatch = runtime.webhookHook!;
        runtime.webhookHook = async (request) => {
          sdkDispatch();
          await dispatch(request);
        };
      };
      context.runtime.initializeHook = wireRuntime;
      await wireRuntime();
      armed = true;
      expect((await context.callback()).status).toBe(202);
      const staged = await context.ingress();
      expect(staged).toMatchObject({ status: "received" });
      worker = context.service.processPendingGitHubWebhookIngress(
        1,
        staged!.id,
      );
      await reached;
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
      expect(await refs()).toEqual(originalRefs);
      expect(await context.service.get(context.endpoint.id)).toMatchObject({
        status: "active",
      });
      release();
      await worker;
      expect(await context.ingress()).toMatchObject({
        status: "cancelled",
        payload: { redacted: true },
        result: { code: "github_webhook_ingress_runtime_superseded" },
      });
      expect((await context.ingress())!.payload).not.toHaveProperty("body");
      expect(await chatHistoryActionBlocks(db, (await context.ingress())!.id)).toBe(false);
      expect(sdkDispatch).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, context.endpoint.id)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.companyId, context.fixture.companyId)),
      ).toEqual([]);
      expect(context.wakeup).not.toHaveBeenCalled();
    } finally {
      release();
      await worker?.catch(() => undefined);
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("cancels staged GitHub ingress when a minimal recovery tombstone arrives before processing", async () => {
    const context = await githubPreIngressRecoveryFixture();
    try {
      expect((await context.callback()).status).toBe(202);
      const staged = await context.ingress();
      const window = (await context.checkpoint()).value as Record<
        string,
        unknown
      >;
      await db.insert(chatActions).values({
        companyId: context.fixture.companyId,
        endpointId: context.endpoint.id,
        kind: "github_webhook_recovery",
        providerActionId: `github_webhook_recovery:${context.guid}`,
        status: "cancelled",
        payload: {
          ...window,
          original: { id: context.deliveryId, guid: context.guid },
        },
        result: { attempts: 0, code: "source_changed_or_unavailable" },
      });
      context.requests.length = 0;
      await context.service.processPendingGitHubWebhookIngress(1, staged!.id);
      const cancelled = await context.ingress();
      expect(cancelled).toMatchObject({
        status: "cancelled",
        payload: { redacted: true },
        result: { code: "github_webhook_recovery_source_changed" },
      });
      expect(cancelled!.payload).not.toHaveProperty("body");
      expect(await chatHistoryActionBlocks(db, cancelled!.id)).toBe(false);
      expect(cancelled!.result?.retryable).not.toBe(true);
      expect(context.requests).toEqual([]);
      expect(
        await db
          .select({ id: chatDeliveries.id })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, context.endpoint.id)),
      ).toEqual([]);
      expect(context.wakeup).not.toHaveBeenCalled();
      expect(
        await context.service.processPendingGitHubWebhookIngress(1, staged!.id),
      ).toBe(0);
    } finally {
      await retirePublicationFixture(context.service, context.endpoint.id);
    }
  });

  it("cancels and redacts GitHub ingress when rotation wins before replay authentication", async () => {
    const fixture = await seedCompany();
    const configured = await configuredGitHubEndpoint(fixture);
    let releaseReplay!: () => void;
    let markReplayReady!: () => void;
    const replayReady = new Promise<void>((resolve) => {
      markReplayReady = resolve;
    });
    const replayRelease = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const receiver = createService(new FakeChatSdkRuntime(), undefined, {
      githubWebhookReplayBarrier: async () => {
        markReplayReady();
        await replayRelease;
      },
    }).service;
    const delivery = `github-stale-generation-${randomUUID()}`;
    const marker = `stale-body-${randomUUID()}`;
    const pendingResponse = receiver.handleWebhook(
      configured.endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery,
        event: "installation_repositories",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          marker,
        },
        webhookSecret: configured.webhookSecret,
      }),
    );
    await replayReady;
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, configured.endpoint.id),
          eq(
            chatActions.providerActionId,
            `github_webhook_ingress:${delivery}`,
          ),
        ),
      )
      .then((rows) => rows[0]!);

    await configured.service.generateSetupSecret(
      configured.endpoint.id,
      "owner-user",
    );
    releaseReplay();
    await expect(pendingResponse).resolves.toMatchObject({ status: 202 });
    const cancelled = await readChatActionsById(action.id)
      .then((rows) => rows[0]);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      result: expect.objectContaining({
        code: "github_webhook_ingress_runtime_superseded",
      }),
      payload: expect.objectContaining({ redacted: true }),
    });
    expect(cancelled?.payload).not.toHaveProperty("body");
    await receiver.shutdown();
    await configured.service.shutdown();
  });

  it("preserves the GitHub resource, task, and conversation across repository rename and transfer", async () => {
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture);
    const { callbacks, endpoint, service, webhookSecret } = context;
    const originalResource = (await service.listResources(endpoint.id))[0]!;
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "PaperclipAI/Paperclip",
        id: "github:PaperclipAI/Paperclip:issue:77",
        name: "PaperclipAI/Paperclip",
      }).thread,
      message: makeMessage({
        id: "github-rename-root",
        text: "@maya keep this task through repository moves",
        mentioned: true,
      }),
      trigger: "mention",
    });
    const originalConversation = await readChatConversationsByEndpointId(endpoint.id)
      .then((rows) => rows[0]!);

    const renamedRepository = {
      id: 97531,
      full_name: "paperclipai/paperclip-renamed",
      html_url: "https://github.com/paperclipai/paperclip-renamed",
      owner: { id: 1357, login: "paperclipai" },
      private: false,
    };
    context.setRepositories([renamedRepository]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-renamed-inventory",
        event: "installation_repositories",
        payload: {
          action: "added",
          installation: { id: 2468 },
          repositories_added: [renamedRepository],
          repositories_removed: [],
        },
        webhookSecret,
      }),
    );
    await expect(service.listResources(endpoint.id)).resolves.toEqual([
      expect.objectContaining({
        id: originalResource.id,
        providerResourceId: "paperclipai/paperclip-renamed",
        enabled: true,
        metadata: expect.objectContaining({ providerRepositoryId: "97531" }),
      }),
    ]);

    const transferredRepository = {
      ...renamedRepository,
      full_name: "new-owner/paperclip-renamed",
      html_url: "https://github.com/new-owner/paperclip-renamed",
      owner: { id: 24680, login: "new-owner" },
    };
    // installation_repositories is a canonical inventory-refresh signal. Keep
    // the provider fixture consistent with the transfer carried by the event.
    context.setRepositories([transferredRepository]);
    await service.handleWebhook(
      endpoint.publicId,
      "github",
      signedGitHubWebhookRequest({
        delivery: "github-repository-transferred-webhook",
        event: "installation_repositories",
        payload: {
          action: "opened",
          installation: { id: 2468 },
          repository: transferredRepository,
        },
        webhookSecret,
      }),
    );

    const [migratedConversation] = await readChatConversationsByEndpointId(endpoint.id);
    expect(migratedConversation).toMatchObject({
      id: originalConversation.id,
      issueId: originalConversation.issueId,
      resourceId: originalResource.id,
      externalConversationId: "new-owner/paperclip-renamed",
      externalThreadId: "github:new-owner/paperclip-renamed:issue:77",
      providerUrl:
        "https://github.com/new-owner/paperclip-renamed/issues/77#issuecomment-github-rename-root",
    });

    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "github",
      thread: makeThread({
        channelId: "new-owner/paperclip-renamed",
        id: "github:new-owner/paperclip-renamed:issue:77",
        name: "new-owner/paperclip-renamed",
      }).thread,
      message: makeMessage({
        id: "github-transfer-followup",
        text: "a follow-up after the transfer",
      }),
      trigger: "subscribed_message",
    });

    await expect(
      readChatConversationsByEndpointId(endpoint.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: originalConversation.id,
        issueId: originalConversation.issueId,
      }),
    ]);
    await expect(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, fixture.companyId)),
    ).resolves.toHaveLength(1);
  });
});
