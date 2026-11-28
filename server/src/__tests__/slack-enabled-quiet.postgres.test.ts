import { registerBudgetEnforcementWork } from "../services/budget-enforcement-worker.js";
import { deliverBudgetResumeContinuations } from "../services/budget-resume-continuation.js";
import { registerChatDeliveryWork } from "../services/chat-delivery-work.js";
import { registerChatActionWork } from "../services/chat-action-work.js";
import { isIdleTaskDrainActive, idleWorkSnapshot } from "../services/task-admission.js";
import { actorMiddleware } from "../middleware/auth.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { parseSlackFormAckWork, assertSlackFormReceiptHistory } from "../services/chat-channels/slack/form-ack-work.js";
import { verifySlackFormFinalizedReceipt } from "../services/chat-channels/slack/receipt-authority.js";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, applyPendingMigrations, authUsers,
  chatActions, chatConversations, chatEndpoints, chatExternalPrincipals, chatPublications, chatSlackRegistrations,
  closeCheckpointDb, closeFileStorageDb, closeLivenessDb, companies, companyMemberships, companySecrets, companySkills,
  costEvents, createDb, financeEvents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { guardSlackFixtureNetwork } from "./helpers/slack-cloud/transport.js";
import { ChatRuntime } from "../services/chat-runtime.js";
import { CAPABILITIES } from "../services/chat-channels/provider-catalog.js";
import { chatChannelService } from "../services/chat-channels.js";
import { reconcilePersistedRuntimeServicesOnStartup } from "../services/workspace-runtime.js";
import { markIdleStartupComplete } from "../services/idle-local-work.js";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { heartbeatService } from "../services/heartbeat.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerGitHubConnectionEventWork } from "../services/github-connection-work.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { connectionEventWakeRoutes } from "../routes/connection-event-wake.js";
import { currentSlackFormOwnerBinding, slackFormSetupRecord } from "../services/chat-channels/slack/cloud-forms.js";

type PlatformView = { id: string; hash: string; external_id: string; app_id: string; callback_id: string; private_metadata: string;
  blocks: { type: string; block_id?: string; element?: { action_id: string; type: string } }[]; state: { values: Record<string, Record<string, unknown>> } };
type HostState = {
  usefulReplies?: { id: string; threadTs: string; runId: string }[];
  bindingCount?: number; coverageEntries?: number; responseStatus?: number; normalRouteReached?: boolean; tamperedStatus?: number; headerBytes?: number;
  calls: { method: string; at: number; body?: unknown }[]; views: PlatformView[]; failures: string[];
  wakerStarts: number; droppedHints: number; lostTerminalReplies: number; lostAckReplies: number;
  idleProjection?: { backgroundWork: "none" | "present" | "unknown"; checks: { reason: string; state: string }[]; capabilityPresent: boolean };
  instance: { eventWakeVersion?: number }; targets: { delivery_id: string; lease_id: string | null; lease_expires_at: string | null }[];
  bindings: { id: string; profile?: string; metadata?: Record<string, unknown> }[];
};
type Fixture = {
  companyId: string; endpointId: string; connectionId: string; applicationId: string; agentId: string; actorId: string;
  instanceId: string; publicId: string; teamId: string; appId: string; botId: string; userId: string; channelId: string; threadTs: string;
  botToken: string; signingSecret: string; controlNonce: string; signPrivate: string; sealPrivate: string; controlJwks: unknown; origin: string; tenantOrigin: string;
};
const appUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_TEST_DATABASE_URL");
const stateFile = process.env.SLACK_FORM_JOURNEY_STATE_FILE;
const shortGate = process.env.SLACK_FORM_SHORT_GATE;
if (appUrl && stateFile && shortGate !== "callback") throw new Error("One closed enabled-quiet callback qualification required");

it.skipIf(!appUrl || !stateFile)("enabled Slack finishes ordinary useful tasks and becomes composed quiet before and after fresh signed work", async () => {
  const network = guardSlackFixtureNetwork({ requirePreload: true });
  let db: ReturnType<typeof createDb> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  let service: ReturnType<typeof chatChannelService> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerGitHubConnectionEventWork> | undefined;
  let budgetWorker: ReturnType<typeof registerBudgetEnforcementWork> | undefined;
  let fixture: Fixture | undefined, directory: string | undefined, primary: unknown;
  const errors: unknown[] = [], ownerErrors: unknown[] = [], observations: unknown[] = [];
  const app = express();
  const server = createServer(app);
  const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  try {
    fixture = JSON.parse(await readFile(stateFile!, "utf8")) as Fixture;
    const f = fixture;
    expect(new URL(f.origin).hostname).toBe("127.0.0.1");
    expect(new URL(appUrl!).pathname).toMatch(/^\/sleep2_slack_form_[a-z0-9_]+_app_test$/);
    const control = async (name: string, body?: unknown): Promise<HostState> => {
      const response = await fetch(`${f.origin}/__fixture/${name}`, { method: body === undefined ? "GET" : "POST",
        headers: { "x-fixture-control": f.controlNonce, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.status).toBe(200);
      return await response.json() as HostState;
    };
    const signed = (value: unknown, form = false) => {
      const body = form ? new URLSearchParams({ payload: JSON.stringify(value) }).toString() : JSON.stringify(value);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return { body, headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${createHmac("sha256", f.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` } };
    };
    const post = async (request: ReturnType<typeof signed>, origin = f.origin) => {
      const started = Date.now();
      const response = await fetch(`${origin}/api/chat-webhooks/${f.publicId}/slack`, { method: "POST", ...request });
      const text = await response.text();
      return { status: response.status, text, elapsed: Date.now() - started };
    };
    await applyPendingMigrations(appUrl!);
    db = createDb(appUrl!, { maxConnections: 2, maxLifetimeSeconds: 0 });
    const database = db;
    const reconstruction = await reconcilePersistedRuntimeServicesOnStartup(database);
    expect(reconstruction).toEqual({ reconciled: 0, adopted: 0, stopped: 0, backfilled: 0, restarted: 0, restartFailed: 0, exposureReservationDrift: [] });
    directory = await mkdtemp(path.join(os.tmpdir(), "form-journey-"));
    for (const [key, value] of Object.entries({
      PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: f.origin, PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "test", PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: f.instanceId,
      PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: f.signPrivate, PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: f.sealPrivate,
      PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify(f.controlJwks), PAPERCLIP_CLOUD_STACK_ID: f.instanceId,
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(directory, "master.key"),
      PAPERCLIP_AGENT_JWT_SECRET: `${randomUUID()}${randomUUID()}`, PAPERCLIP_API_URL: f.tenantOrigin,
    })) vi.stubEnv(key, value);
    const now = new Date();
    await db.insert(companies).values({ id: f.companyId, name: "Form boundary journey", issuePrefix: `F${f.companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: f.actorId, name: "Form operator", email: `${f.actorId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: f.actorId, status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: f.agentId, companyId: f.companyId, name: "Scoped useful process", adapterType: "codex_local", status: "idle",
      adapterConfig: { engine: "cli", command: fileURLToPath(new URL("./helpers/slack-cloud/controlled-codex-cli.cjs", import.meta.url)), cwd: directory,
        env: { SLACK_FORM_FIXTURE_PEER_ORIGIN: f.tenantOrigin, CODEX_HOME: path.join(directory, "owned-controlled-cli-home"),
          OPENAI_API_KEY: "controlled-command-no-real-provider-authority" }, timeoutSec: 10, graceSec: 1 },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, intervalSec: 0 } } });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId, status: "active", membershipRole: "member" });
    await db.insert(toolApplications).values({ id: f.applicationId, companyId: f.companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: f.connectionId, companyId: f.companyId, applicationId: f.applicationId, name: "Slack form", uid: f.endpointId,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: f.endpointId, companyId: f.companyId, connectionId: f.connectionId, assignedAgentId: f.agentId, publicId: f.publicId,
      provider: "slack", status: "draft", sponsorUserId: f.actorId, allowGroupChats: true, allowUnlinkedPeople: false,
      capabilities: CAPABILITIES.slack, setup: { step: "provider_setup" } });
    await db.insert(chatSlackRegistrations).values({ companyId: f.companyId, endpointId: f.endpointId, requestId: randomUUID(), status: "configured", appId: f.appId,
      manifest: {}, manifestHash: "fixture", callbackUri: `https://tenant.example/api/chat-webhooks/${f.publicId}/slack`, createdByUserId: f.actorId });
    const runtime = new ChatRuntime(), replace = runtime.replaceEndpoint.bind(runtime);
    vi.spyOn(runtime, "replaceEndpoint").mockImplementation(input => {
      if (input.providerConfig.provider !== "slack") throw new Error("Unexpected form fixture provider");
      return replace({ ...input, providerConfig: { ...input.providerConfig, credentials: { ...input.providerConfig.credentials, apiUrl: `${f.origin}/fixture/slack/` } } });
    });
    const providerFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://slack.com" || !url.pathname.startsWith("/api/")) throw new Error("Unexpected provider leaf request");
      return fetch(`${f.origin}/fixture/slack/${url.pathname.slice(5)}`, init);
    };
    heartbeat = heartbeatService(db);
    service = chatChannelService(db, { runtime, heartbeat, fetch: providerFetch, publicBaseUrl: "https://tenant.example" });
    const channels = service;
    app.use(idleAdmissionMiddleware);
    app.use(actorMiddleware(database, { deploymentMode: "authenticated" }));
    app.use(cloudControlMiddleware()); app.use(connectionEventWakeRoutes(db));
    app.use("/api/instance/task-drain", express.json());
    app.use("/api", instanceSettingsRoutes(database));
    app.use("/api/issues", express.json());
    app.use("/api", issueRoutes(database, createStorageService(createLocalDiskStorageProvider(path.join(directory, "storage")))));
    app.use("/api", agentRoutes(database, { deploymentMode: "authenticated" }));
    app.post(`/api/chat-webhooks/${f.publicId}/slack`, express.raw({ type: () => true, limit: "1mb" }), async (req, res, next) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string" && name !== "host") headers.set(name, value);
        const response = await channels.handleWebhook(f.publicId, "slack", new Request(`https://tenant.example${req.path}`, { method: "POST", headers, body: new Uint8Array(req.body) }));
        res.status(response.status); response.headers.forEach((value, name) => res.setHeader(name, value)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { next(error); }
    });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { ownerErrors.push(error); res.status(500).end("fixture handler failed"); });
    expect(new URL(f.tenantOrigin).hostname).toBe("127.0.0.1");
    trackIdleRequestHandlers(app);
    server.listen(Number(new URL(f.tenantOrigin).port), "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing tenant fixture address");
    const tenantOrigin = `http://127.0.0.1:${address.port}`;
    expect(tenantOrigin).toBe(f.tenantOrigin);
    await control("tenant", { origin: tenantOrigin });
    const startOwner = async () => {
      // Same queue owners and idle-drain gate as normal app.ts composition.
      // This fixture has no optional CloudWarmStandby owner (normal default).
      const canDispatch = () => !isIdleTaskDrainActive();
      coordinator = createDeliveryWorkCoordinator({ owner: database, canRun: canDispatch, canReconcile: () => true,
        onError: error => ownerErrors.push(error) });
      const deliveries = registerChatDeliveryWork(coordinator, channels, canDispatch);
      const actions = registerChatActionWork(coordinator, channels, canDispatch);
      const ownedHeartbeat = heartbeat;
      if (!ownedHeartbeat) throw new Error("Missing normal heartbeat budget authority");
      budgetWorker = registerBudgetEnforcementWork(database, coordinator, {
        cancelWorkForScope: ownedHeartbeat.cancelBudgetScopeWork,
        deliverResumeContinuations: () => deliverBudgetResumeContinuations(database, {
          prepareChatRetry: channels.prepareFailedChatRunRetry,
          resumeTaskRetry: (companyId, requestId) => ownedHeartbeat.resumeTaskRetry(companyId, requestId),
        }),
      });
      worker = registerGitHubConnectionEventWork(database, coordinator, githubConnectionEventService(database), canDispatch);
      await Promise.all([deliveries.ready, actions.ready, worker.ready, budgetWorker.ready]);
    };
    const stopOwner = async () => { await worker?.stop(); await budgetWorker?.stop(); await coordinator?.stop(); worker = undefined; budgetWorker = undefined; coordinator = undefined; };
    await startOwner();
    markIdleStartupComplete({ scheduledBackups: false });
    await service.configure(f.endpointId, { action: "configure", credentials: { botToken: f.botToken, signingSecret: f.signingSecret } }, f.actorId);
    expect((await post(signed({ type: "url_verification", team_id: f.teamId, api_app_id: f.appId, challenge: "form-journey-challenge" }), tenantOrigin)).status).toBe(200);
    await service.configure(f.endpointId, { action: "verify" }, f.actorId);
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: f.teamId, externalId: f.userId, kind: "user", displayName: "Operator" }).returning();
    expect(principal).toBeDefined();
    const link = await service.createLinkIntent(f.endpointId, principal!.id, 1800);
    const token = new URL(link.confirmationUrl).searchParams.get("token"); if (!token) throw new Error("Missing normal identity link token");
    await service.confirmIdentityLink(token, f.actorId);
    expect((await service.test(f.endpointId, { optionalSlackTestForUser: f.actorId })).status).toBe("active");
    const endpoint = async () => (await database.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId)))[0]!;
    await vi.waitFor(async () => {
      expect(currentSlackFormOwnerBinding(slackFormSetupRecord((await endpoint()).setup))).not.toBeNull();
      expect((await control("state")).instance.eventWakeVersion).toBe(1);
    }, { timeout: 15_000 });
    const startupProjection = (await control("idle-projection", {})).idleProjection;
    expect(startupProjection).toBeDefined();
    console.info(JSON.stringify({ diagnostic: "slack_form_idle_startup", ...startupProjection }));
    expect(startupProjection?.checks.filter(value => value.reason.startsWith("local.") && value.state === "unknown")).toEqual([]);
    const bootstrap = signed({ type: "event_callback", event_id: `EvForm${randomUUID().replaceAll("-", "")}`, team_id: f.teamId, api_app_id: f.appId,
      event: { type: "app_mention", text: `<@${f.botId}> help me choose`, user: f.userId, channel: f.channelId, ts: f.threadTs, event_ts: f.threadTs } });
    expect((await post(bootstrap)).status).toBe(200);
    const conversation = async () => (await database.select().from(chatConversations).where(eq(chatConversations.endpointId, f.endpointId)))[0];
    await vi.waitFor(async () => expect(await conversation()).toBeDefined(), { timeout: 15_000 });
    const current = (await conversation())!;
    const enabledIdentity = async () => {
      const [endpoint] = await database.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, f.companyId), eq(chatEndpoints.id, f.endpointId)));
      const [connection] = await database.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.id, f.connectionId)));
      expect(endpoint?.status).toBe("active"); expect(connection?.enabled).toBe(true);
      return { endpointId: endpoint!.id, connectionId: connection!.id, capabilities: endpoint!.capabilities, setup: endpoint!.setup };
    };
    const configured = await enabledIdentity();
    const usefulRuns = async (count: number) => {
      const runs = await database.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
      expect(runs).toHaveLength(count);
      const receipts = [];
      for (const run of runs) {
        expect(run.status).toBe("succeeded"); expect(run.exitCode).toBe(0);
        const issueId = run.contextSnapshot?.issueId;
        if (typeof issueId !== "string") throw new Error("Missing admitted actual task identity");
        const [task] = await database.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.id, issueId)));
        expect(task?.status).toBe("done"); expect(task?.checkoutRunId).toBeNull(); expect(task?.executionRunId).toBeNull();
        const replies = await database.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.createdByRunId, run.id), eq(issueComments.authorAgentId, f.agentId)));
        expect(replies).toHaveLength(1); expect(replies[0]?.body).toBe(`Scoped Slack useful reply for run ${run.id}`);
        const publications = await database.select().from(chatPublications).where(and(eq(chatPublications.companyId, f.companyId), eq(chatPublications.endpointId, f.endpointId), eq(chatPublications.commentId, replies[0]!.id)));
        expect(publications).toHaveLength(1); expect(publications[0]?.state).toBe("published"); expect(publications[0]?.providerMessageId).toBeTruthy();
        const platform = await control("state");
        expect(platform.usefulReplies?.filter(reply => reply.runId === run.id && reply.id === publications[0]!.providerMessageId)).toHaveLength(1);
        receipts.push({ runId: run.id, issueId, commentId: replies[0]!.id, publicationId: publications[0]!.id, providerMessageId: publications[0]!.providerMessageId });
      }
      expect(new Set(receipts.map(value => value.issueId)).size).toBe(count);
      return receipts.sort((left, right) => left.runId.localeCompare(right.runId));
    };
    type WireSnapshot = { pid: number; observedAt: number; pgConnectAttempts: number; pgConnects: number; pgCloses: number;
      pgWriteCalls: number; outboundRequests: number; nonPgConnectAttempts: number; livePgSockets: number };
    const wire = Reflect.get(process, Symbol.for("paperclip.slack.fixture.prewire")) as {
      pid: number; wireSnapshot(): WireSnapshot; waitForPgSocketsClosed(timeoutMs: number): Promise<void>;
      beginWireWindow(): WireSnapshot; endWireWindow(): { before: WireSnapshot; after: WireSnapshot; peakPgSockets: number;
        pgWriteCalls: number; pgConnectAttempts: number; pgConnects: number; pgCloses: number; outboundRequests: number; nonPgConnectAttempts: number };
    };
    expect(wire?.pid).toBe(process.pid);
    const observeQuiet = async (label: string, count: number) => {
      const settlementDeadline = Date.now() + 95_000;
      let ordinaryQueryWitness: { before: WireSnapshot; after: WireSnapshot } | undefined;
      let lastInspection: { observedAt: number; projection: HostState["idleProjection"]; coordinatorNextWakeAt: number | null; localWork: ReturnType<typeof idleWorkSnapshot>; ownerErrorCount: number } | undefined;
      let reportedSignature: string | undefined, diagnosticTransitions = 0;
      try {
      await vi.waitFor(async () => {
        const queryBefore = wire.wireSnapshot();
        await usefulRuns(count); // Existing ordinary reads are the counter liveness control; no extra query.
        const queryAfter = wire.wireSnapshot();
        expect(queryAfter.pgWriteCalls).toBeGreaterThan(queryBefore.pgWriteCalls);
        ordinaryQueryWitness ??= { before: queryBefore, after: queryAfter };
        const projection = (await control("idle-projection", {})).idleProjection;
        // Retain only values already returned by this required normal read.
        // Passive snapshots below do not query, drain, schedule or change authority.
        lastInspection = { observedAt: Date.now(), projection, coordinatorNextWakeAt: coordinator?.nextWakeAt() ?? null,
          localWork: idleWorkSnapshot(), ownerErrorCount: ownerErrors.length };
        const signature = JSON.stringify(projection);
        if (signature !== reportedSignature && diagnosticTransitions < 16) {
          reportedSignature = signature; diagnosticTransitions += 1;
          try { console.info(JSON.stringify({ diagnostic: "slack_enabled_quiet_owner_observation", label,
            sequence: diagnosticTransitions, ...lastInspection, noAdditionalRead: true })); } catch { /* Observation cannot change assertion. */ }
        }
        expect(projection).toBeDefined(); expect(projection?.backgroundWork).toBe("none");
      }, { timeout: Math.max(1, settlementDeadline - Date.now()), interval: 250 });
      } catch (error) {
        // Log before finally deletes fixture rows, without extra SQL/HTTP.
        // The original error remains primary even if evidence output fails.
        try { console.info(JSON.stringify({ diagnostic: "slack_enabled_quiet_wait_failure", label,
          lastInspection, observedAt: Date.now(), noAdditionalRead: true })); } catch { /* Preserve original failure. */ }
        throw error;
      }
      const before = { observedAt: Date.now(), receipts: await usefulRuns(count), config: await enabledIdentity(), state: await control("state"), projection: (await control("idle-projection", {})).idleProjection };
      expect(before.state.targets).toHaveLength(0); expect(before.state.failures).toEqual([]); expect(before.config).toEqual(configured);
      expect(before.projection?.backgroundWork).toBe("none");
      // All existing before-snapshot reads above are complete. Wait only on
      // actual close events, inside the SAME original 95s settlement budget.
      console.info(JSON.stringify({ diagnostic: "slack_enabled_used_pg_close_before", label,
        observedAt: Date.now(), settlementDeadline, ordinaryQueryWitness, wire: wire.wireSnapshot(), noAdditionalRead: true }));
      try { await wire.waitForPgSocketsClosed(settlementDeadline - Date.now()); }
      catch (error) {
        try { console.info(JSON.stringify({ diagnostic: "slack_enabled_used_pg_close_failure", label,
          observedAt: Date.now(), settlementDeadline, wire: wire.wireSnapshot(), noAdditionalRead: true })); } catch { /* Preserve original failure. */ }
        throw error;
      }
      expect(wire.wireSnapshot().livePgSockets).toBe(0);
      const wireBefore = wire.beginWireWindow();
      await sleep(30_000); // Original observation duration; no SQL/control reads in this window.
      const wireWindow = wire.endWireWindow(); // Immediately after sleep, BEFORE any after-snapshot query.
      console.info(JSON.stringify({ diagnostic: "slack_enabled_quiet_wire_window", label, ordinaryQueryWitness, wireBefore, wireWindow }));
      expect(wireWindow.pgWriteCalls).toBe(0); expect(wireWindow.pgConnectAttempts).toBe(0);
      expect(wireWindow.pgConnects).toBe(0); expect(wireWindow.pgCloses).toBe(0);
      expect(wireWindow.peakPgSockets).toBe(0); expect(wireWindow.after.livePgSockets).toBe(0);
      expect(wireWindow.outboundRequests).toBe(0); expect(wireWindow.nonPgConnectAttempts).toBe(0);
      const after = { observedAt: Date.now(), receipts: await usefulRuns(count), config: await enabledIdentity(), state: await control("state"), projection: (await control("idle-projection", {})).idleProjection };
      expect(after.projection?.backgroundWork).toBe("none"); expect(after.receipts).toEqual(before.receipts); expect(after.config).toEqual(configured);
      expect(after.state.targets).toHaveLength(0); expect(after.state.failures).toEqual([]);
      expect(after.state.usefulReplies).toEqual(before.state.usefulReplies);
      expect(after.state.calls).toHaveLength(before.state.calls.length);
      console.info(JSON.stringify({ diagnostic: "slack_enabled_quiet_window", label, startedAt: before.observedAt, endedAt: after.observedAt,
        runCount: count, usefulReplies: after.state.usefulReplies?.length, targets: after.state.targets.length,
        configurationRetained: true, before: before.projection, after: after.projection, noPhysicalOrSqlZeroClaim: true }));
    };
    await observeQuiet("initial-useful-task", 1);
    const secondThread = (Number(f.threadTs) + 1).toFixed(6);
    const fresh = signed({ type: "event_callback", event_id: `EvFresh${randomUUID().replaceAll("-", "")}`, team_id: f.teamId, api_app_id: f.appId,
      event: { type: "app_mention", text: `<@${f.botId}> complete a fresh useful task`, user: f.userId, channel: f.channelId, ts: secondThread, event_ts: secondThread } });
    const admitted = await post(fresh); expect(admitted.status).toBe(200); expect(admitted.elapsed).toBeLessThan(3000);
    const duplicate = await post(fresh); expect(duplicate.status).toBe(200); expect(duplicate.elapsed).toBeLessThan(3000);
    await observeQuiet("fresh-useful-reactivation-and-duplicate", 2);
    await usefulRuns(2); expect(await enabledIdentity()).toEqual(configured);
    expect(ownerErrors).toEqual([]);
  } catch (error) { primary = error; }
  finally {
    for (const close of [async () => worker?.stop(), async () => budgetWorker?.stop(), async () => coordinator?.stop(), async () => service?.shutdown(), async () => heartbeat?.drainActiveRunExecutions(),
      async () => { if (server.listening) { server.close(); server.closeAllConnections(); await once(server, "close"); } }]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (db && fixture) {
      const f = fixture;
      try {
        await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, f.companyId));
        await db.delete(financeEvents).where(eq(financeEvents.companyId, f.companyId));
        await db.delete(costEvents).where(eq(costEvents.companyId, f.companyId));
        await db.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
        await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, f.companyId));
        await db.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, f.companyId));
        await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, f.companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        await db.delete(issueComments).where(eq(issueComments.companyId, f.companyId));
        await db.delete(issues).where(eq(issues.companyId, f.companyId));
        await db.delete(agents).where(eq(agents.companyId, f.companyId));
        await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
        await db.delete(companySecrets).where(eq(companySecrets.companyId, f.companyId));
        await db.delete(companySkills).where(eq(companySkills.companyId, f.companyId));
        await db.delete(companies).where(eq(companies.id, f.companyId)); await db.delete(authUsers).where(eq(authUsers.id, f.actorId));
      } catch (error) { errors.push(error); }
      for (const close of [closeCheckpointDb, closeFileStorageDb, closeLivenessDb]) { try { await close(db, 1); } catch (error) { errors.push(error); } }
      try { await db.$client.end({ timeout: 1 }); } catch (error) { errors.push(error); }
    }
    try { network.assertQuiet(); } catch (error) { errors.push(error); }
    network.restore(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (directory) { try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
  }
  if (primary && errors.length) throw new AggregateError([primary, ...errors], "Slack form journey body and cleanup failed");
  if (primary) throw primary;
  if (errors.length) throw new AggregateError(errors, "Slack form journey cleanup failed");
}, 360_000);
