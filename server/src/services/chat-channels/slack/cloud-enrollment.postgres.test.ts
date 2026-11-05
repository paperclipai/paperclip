import { guardSlackFixtureNetwork, stubSlackFixtureTransport } from "../../../__tests__/helpers/slack-cloud/transport.js";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { expect, it, vi } from "vitest";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, applyPendingMigrations, authUsers, chatConversations, chatDeliveries, chatExternalPrincipals, chatIdentityLinks, chatEndpointResources, chatEndpoints, chatMessageLinks, chatSlackRegistrations, heartbeatRunEvents, heartbeatRuns, companies, companyMemberships, companySecrets, companySkills, costEvents, financeEvents, closeCheckpointDb, closeFileStorageDb, closeLivenessDb, createDb, issueComments, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../../lib/dedicated-test-database-url.js";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../../paperclip-cloud-connector.js";
import { chatChannelService } from "../../chat-channels.js";
import { ChatRuntime } from "../../chat-runtime.js";
import { heartbeatService } from "../../heartbeat.js";
import { githubConnectionEventService } from "../../github-connection-events.js";
import { secretService } from "../../secrets.js";
import type { ChatSdkMessageCallbackEvent } from "../../chat-sdk-runtime.js";
import { createChatSdkEndpointRuntime } from "../../chat-sdk-runtime.js";
import { createSlackCloudEnrollment, stageSlackCloudEnrollmentIntent } from "./cloud-enrollment.js";
import { createSlackCloudEventIngress, dispatchSlackCloudEvent } from "./cloud-ingress.js";
import type { InternalSetupState } from "../runtime-types.js";

const appUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_TEST_DATABASE_URL");
const cloudUrl = resolveExternalTestDatabaseUrl("SLACK_EVENT_TEST_DATABASE_URL");
const cloudDist = process.env.SLACK_TEST_CLOUD_DIST;

it.skipIf(!appUrl || !cloudUrl || !cloudDist)("signed Slack enrollment and actual event owner preserve one domain reply through lost ACK and removal retries", async () => {
  const network = guardSlackFixtureNetwork({ requirePreload: true });
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(cloudDist!, file)).href);
  const [{ PostgresCloudHarnessRegistry }, { PostgresConnectorStore }, { ConnectorBroker }, { InMemoryProviderSecretStore },
    { providerRegistryFromEnvironment }, { CloudStackProvisioner }, { FakeCloudStackProvider }, { Pool }] = await Promise.all([
    load("registry/postgres.js"), load("connections/postgres.js"), load("connections/broker.js"), load("providers/neon.js"),
    load("connections/providers.js"), load("provisioner/provisioner.js"), load("providers/fake.js"),
    import(/* @vite-ignore */ pathToFileURL(path.resolve(cloudDist!, "../node_modules/pg/lib/index.js")).href),
  ]);
  await applyPendingMigrations(appUrl!);
  const db = createDb(appUrl!, { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  const pool = new Pool({ connectionString: cloudUrl!, max: 2 });

  const registry = Reflect.construct(PostgresCloudHarnessRegistry, [pool]) as {
    applyMigrations(folder: string, timeout: number): Promise<void>;
    hydrate(): Promise<void>;
    close(): Promise<void>;
  };
  try {
    await registry.applyMigrations(path.resolve(cloudDist!, "../migrations"), 30_000);
    await registry.hydrate();
  }
  catch (error) { await db.$client.end({ timeout: 1 }); await registry.close(); throw error; }
  const store = new PostgresConnectorStore(pool), secrets = new InMemoryProviderSecretStore();
  const id = randomUUID(), companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID();
  const actorId = `slack-owner-${id}`;
  const instanceId = `instance-${id}`, stackId = `slack-${id}`, publicId = "a".repeat(43), signingSecret = "0123456789abcdef0123456789abcdef";
  const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519"), now = new Date();
  let broker: InstanceType<typeof ConnectorBroker>;
  let enrollmentRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/v1/connector/slack-events") enrollmentRequests++;
    if (brokerUnavailable) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "fixture_broker_unavailable" })); return; }
    if (loseEnrollmentResponse && req.url === "/v1/connector/slack-events") {
      loseEnrollmentResponse = false;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    void broker.handle(req, res, new URL(req.url!, base)).catch((error: unknown) => {
    if (!res.headersSent) res.writeHead(500); res.end(String(error));
  }); });
  let base = "";
  let brokerUnavailable = false, loseEnrollmentResponse = false;
  let unregister: (() => void) | undefined;
  let runtime: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
  const deliveryIds: string[] = [];
  let normalService: ReturnType<typeof chatChannelService> | undefined;
  let secretDirectory: string | undefined;
  let normalHeartbeat: ReturnType<typeof heartbeatService> | undefined;
  let releaseEnrollmentLease: (() => void) | undefined;
  let heldEnrollmentLease: Promise<void> | undefined;
  try {
    await new CloudStackProvisioner({ provider: new FakeCloudStackProvider(), registry }).provisionDevelopmentStack({
      idempotencyKey: id, accountGroup: { id: `account-${id}`, slug: stackId, displayName: "Slack fixture" },
      owner: { id: actorId, email: `${id}@example.test` },
      stack: { stackId, accountGroupId: `account-${id}`, stackSlug: stackId, displayName: "Slack fixture", kind: "demo", primaryHost: `${stackId}.example.test`, region: "us-east-1" },
      versionPlan: { appVersion: "fixture", schemaVersion: "fixture", rolloutTrack: "stable" },
      sleepPolicy: { desiredState: "awake" }, primaryCompany: { paperclipCompanyId: companyId, displayName: "Fixture", defaultBudgetCents: 0 },
    });
    await store.putCloudStackInstance({ id: instanceId, kind: "cloud_stack", companyStackId: stackId, environment: "test",
      signPublicKey: signing.publicKey.export({ format: "jwk" }).x!, sealPublicKey: sealing.publicKey.export({ format: "jwk" }).x!,
      origins: ["https://tenant.example"], activeOrigin: "https://tenant.example", label: "Fixture", status: "active", createdAt: now, updatedAt: now });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    base = `http://127.0.0.1:${address.port}`;
    const wake = vi.fn(async () => {});
    broker = new ConnectorBroker({ publicOrigin: base, environment: "test", store,
      providers: providerRegistryFromEnvironment({}, "test"), secrets: { resolve: async () => undefined },
      authenticate: async () => ({ globalUserId: actorId }), canApproveInstance: async (principal: { globalUserId: string }) => principal.globalUserId === actorId,
      slackEvents: { secrets, secretRefPrefix: "secret:///test/slack" },
      eventWakeEnrollmentEnabled: true, eventWakeDeliveryEnabled: true, wakeCloudStack: wake });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", instanceId);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", signing.privateKey.export({ format: "jwk" }).d!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", sealing.privateKey.export({ format: "jwk" }).d!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", base);
    await db.insert(companies).values({ id: companyId, name: "Slack", issuePrefix: `S${id.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: actorId, name: "Slack owner", email: `${id}@owner.example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId, status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Slack", adapterType: "process", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, intervalSec: 0 } } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: id,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId,
      publicId, provider: "slack", status: "active", providerAccountId: "TTEST", setup: { runtimeGeneration: 1 } as InternalSetupState });
    await db.insert(chatSlackRegistrations).values({ companyId, endpointId, requestId: randomUUID(), status: "configured",
      manifest: {}, manifestHash: "fixture", callbackUri: "https://tenant.example/callback", appId: "ATEST", createdByUserId: actorId });
    const withLease = chatCredentialMutationLease(db);
    const resolveCredentials = vi.fn(async () => ({ signingSecret }));
    const produce = createSlackCloudEnrollment(db, { resolveCredentials,
      runtimeGeneration: setup => Number(setup.runtimeGeneration ?? 0) });
    const endpoint = async () => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]!;
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, actorId));
    await withLease(await endpoint(), lease => produce(endpointId, actorId, lease));
    const saved = (await endpoint()).setup as InternalSetupState;
    expect(saved.slackCloudEvents?.runtimeGeneration).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(signingSecret);
    const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvPaired", team_id: "TTEST", api_app_id: "ATEST",
      event: { type: "app_mention", text: "<@UBOT> hello", user: "UOPERATOR", channel: "CTEST", ts: "1788.500", event_ts: "1788.500" } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = { rawBody, timestamp, signature: `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}` };
    const current = await broker.slackEvents.current(instanceId, publicId);
    await expect(broker.slackEvents.receive(current, request)).rejects.toThrow("SLACK_DURABLE_WAKE_UNAVAILABLE");
    const connector = createPaperclipCloudConnector({ config: paperclipCloudConnectorConfigFromEnv()! });
    expect(await connector.leaseEvents({ subject: actorId, companyId, eventWakeVersion: 1 })).toBeNull();
    expect(await broker.slackEvents.receive(current, request)).toEqual({ status: 200, duplicate: false });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    const leased = await connector.leaseEvents({ subject: actorId, companyId, eventWakeVersion: 1 });
    expect(leased?.failedEventIds).toBeUndefined(); expect(leased?.events).toHaveLength(1);
    const event = leased!.events[0]!; deliveryIds.push(event.id);
    if (event.provider !== "slack") throw new Error("Unexpected event owner");
    await expect(dispatchSlackCloudEvent(db, event)).rejects.toThrow("not ready");
    const onMessage = vi.fn(async (_event: ChatSdkMessageCallbackEvent) => {});
    runtime = createChatSdkEndpointRuntime({ companyId, endpointId, logger: "silent", callbacks: { onMessage },
      persistence: { read: async () => null, compareAndSet: async () => true, deleteIfVersion: async () => true },
      providerConfig: { provider: "slack", userName: "paperclip-agent", credentials: { apiUrl: "http://127.0.0.1:1/api/", botToken: "xoxb-fixture", botUserId: "UBOT", signingSecret } } });
    await runtime.initialize();
    const transport = stubSlackFixtureTransport(runtime.getProviderAdapter());
    unregister = createSlackCloudEventIngress(db, { withCredentialMutationLease: withLease, resolveCredentials,
      runtimeGeneration: value => Number((value.setup as InternalSetupState).runtimeGeneration ?? 0),
      handleWebhook: async (_publicId, _provider, req, generation) => {
        expect(generation).toBe(1);

        await withLease(await endpoint(), async lease => { await lease.assertOwned(); });
        return runtime!.handleWebhook(req);
      } });
    await dispatchSlackCloudEvent(db, event);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ author: expect.objectContaining({ userId: "UOPERATOR", userName: "Operator" }) }) }));
    expect(transport).toHaveBeenCalled();
    await transport.assertNoErrors();
    expect(await connector.acknowledgeEvents({ subject: actorId, companyId, leaseId: leased!.leaseId, deliveryIds: [event.id] })).toBe(1);
    expect(await connector.leaseEvents({ subject: actorId, companyId, eventWakeVersion: 1 })).toBeNull();
    await db.update(chatEndpoints).set({ setup: { ...saved, runtimeGeneration: 2 } as InternalSetupState }).where(eq(chatEndpoints.id, endpointId));
    await dispatchSlackCloudEvent(db, event);
    expect(onMessage).toHaveBeenCalledOnce();
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, actorId));
    await withLease(await endpoint(), lease => produce(endpointId, actorId, lease));
    const replacement = ((await endpoint()).setup as InternalSetupState).slackCloudEvents!;
    expect(replacement.runtimeGeneration).toBe(2); expect(replacement.bindingId).not.toBe(saved.slackCloudEvents!.bindingId);
    const firstMessage = onMessage.mock.calls[0]![0];
    const [task] = await db.insert(issues).values({ companyId, title: "Existing Slack conversation", status: "in_progress",
      assigneeAgentId: agentId, createdByUserId: actorId, identifier: `S${id.slice(0, 7)}-1`, issueNumber: 1 }).returning();
    const [resource] = await db.insert(chatEndpointResources).values({ companyId, endpointId, type: "channel",
      providerResourceId: firstMessage.thread.channelId, label: "Slack fixture", availability: "available", enabled: true }).returning();
    await db.insert(chatConversations).values({ companyId, endpointId, issueId: task!.id, resourceId: resource!.id,
      externalConversationId: firstMessage.thread.channelId, externalThreadId: firstMessage.thread.id,
      externalLabel: "Slack fixture", isDirectMessage: firstMessage.thread.isDM });
    secretDirectory = await mkdtemp(path.join(os.tmpdir(), "slack-owner-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(secretDirectory, "master.key"));
    const markerPath = path.join(secretDirectory, "normal-process-marker.json");
    const markerText = `slack-domain-once-${id}`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, cwd: secretDirectory,
      args: ["--require", fileURLToPath(new URL("../../../__tests__/helpers/slack-cloud/prewire.cjs", import.meta.url)), "-e", `if(process.env.SLACK_GATE_GUARD_PID!==String(process.pid))throw Error("child prewire guard missing");require("node:fs").writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({pid:process.pid,runId:process.env.PAPERCLIP_RUN_ID,marker:${JSON.stringify(markerText)}}),{flag:"ax"});console.log(${JSON.stringify(markerText)});`],
      timeoutSec: 10, graceSec: 1 } }).where(eq(agents.id, agentId));
    const vault = secretService(db), refs: ToolCredentialSecretRef[] = [];
    for (const [key, value] of Object.entries({ botToken: "xoxb-fixture", signingSecret })) {
      const secret = await vault.create(companyId, { name: `slack-${key}-${id}`, provider: "local_encrypted", value }, { userId: actorId });
      await vault.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connectionId, configPath: `credentials.${key}` });
      refs.push({ secretId: secret.id, versionSelector: "latest", configPath: `credentials.${key}`, required: true, projectionClass: "unclassified" });
    }
    await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, connectionId));
    const [linkedPrincipal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "TTEST",
      externalId: "UOPERATOR", kind: "user", displayName: "Operator" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: linkedPrincipal!.id, paperclipUserId: actorId,
      status: "linked", confirmedAt: now });
    const canonicalCallback = "https://tenant.example/api/chat-webhooks/" + publicId + "/slack";
    await db.update(chatEndpoints).set({ botExternalId: "UBOT", sponsorUserId: actorId, allowGroupChats: true,
      setup: { ...((await endpoint()).setup as InternalSetupState), step: "complete", webhookVerifiedAt: now.toISOString(),
        slackCallbackSurfaces: { events: { url: canonicalCallback, observedAt: now.toISOString() } } } as InternalSetupState }).where(eq(chatEndpoints.id, endpointId));
    const callbackEvidence = structuredClone(((await endpoint()).setup as InternalSetupState).slackCallbackSurfaces);
    const actualRuntime = new ChatRuntime(), sdkCallbacks: ChatSdkMessageCallbackEvent[] = [];
    const transports: ReturnType<typeof stubSlackFixtureTransport>[] = [];
    const replaceEndpoint = actualRuntime.replaceEndpoint.bind(actualRuntime);
    vi.spyOn(actualRuntime, "replaceEndpoint").mockImplementation(async input => {
      if (input.providerConfig.provider !== "slack") throw new Error("Unexpected fixture provider");
      const value = await replaceEndpoint({ ...input, providerConfig: { ...input.providerConfig,
        credentials: { ...input.providerConfig.credentials, apiUrl: "http://127.0.0.1:1/api/" } },
        callbacks: { ...input.callbacks, onMessage: async message => { sdkCallbacks.push(message); await input.callbacks.onMessage(message); } } });
      transports.push(stubSlackFixtureTransport(value.getProviderAdapter()));
      return value;
    });
    normalHeartbeat = heartbeatService(db);
    const receiptFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!["https://slack.com/api/reactions.add", "https://slack.com/api/reactions.remove"].includes(url)) throw new Error(`Unexpected normal Slack owner request ${url}`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ channel: "CTEST", name: "eyes" });
      return Response.json({ ok: true });
    };
    const deferred: (() => void | Promise<void>)[] = [];
    normalService = chatChannelService(db, { runtime: actualRuntime, publicBaseUrl: "https://tenant.example",
      deferWebhookProcessing: true, scheduleDeferredWork: work => { deferred.push(work); }, heartbeat: normalHeartbeat, fetch: receiptFetch });
    const ownerMessageTs = (Date.now() / 1000).toFixed(6);
    const ownerRawBody = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "EvActualOwner", team_id: "TTEST", api_app_id: "ATEST",
      event: { type: "app_mention", text: "<@UBOT> one durable reply", user: "UOPERATOR", channel: "CTEST", ts: ownerMessageTs, event_ts: ownerMessageTs, thread_ts: "1788.500" } }));
    const ownerTimestamp = String(Math.floor(Date.now() / 1000));
    const ownerRequest = { rawBody: ownerRawBody, timestamp: ownerTimestamp,
      signature: `v0=${createHmac("sha256", signingSecret).update(`v0:${ownerTimestamp}:`).update(ownerRawBody).digest("hex")}` };
    await broker.slackEvents.receive(await broker.slackEvents.current(instanceId, publicId), ownerRequest);
    let lostAck = true;
    const captured: NonNullable<Awaited<ReturnType<typeof connector.leaseEvents>>>["events"] = [];
    const ownerConnector = { ...connector, leaseEvents: async (input: Parameters<typeof connector.leaseEvents>[0]) => {
      const batch = await connector.leaseEvents(input); if (batch) captured.push(...batch.events); return batch;
    }, acknowledgeEvents: async (input: Parameters<typeof connector.acknowledgeEvents>[0]) => {
      if (lostAck) { lostAck = false; throw new Error("fixture ACK request lost before broker settlement"); }
      return connector.acknowledgeEvents(input);
    } };
    const busyEndpointId = randomUUID(), busyConnectionId = randomUUID();
    await db.insert(toolConnections).values({ id: busyConnectionId, companyId, applicationId, name: "Retirement waiting for credential mutation", uid: busyEndpointId,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: false, status: "disabled" });
    await db.insert(chatEndpoints).values({ id: busyEndpointId, companyId, connectionId: busyConnectionId, assignedAgentId: agentId,
      publicId: "f".repeat(43), provider: "slack", status: "archived", setup: { runtimeGeneration: 1 } as InternalSetupState });
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, busyEndpointId, actorId));
    const [busyEndpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, busyEndpointId));
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
    const releasePromise = new Promise<void>(resolve => { releaseEnrollmentLease = resolve; });
    heldEnrollmentLease = withLease(busyEndpoint!, async lease => { await lease.assertOwned(); acquired(); await releasePromise; });
    await acquiredPromise;
    const eventOwner = githubConnectionEventService(db, { connector: ownerConnector });
    await expect(eventOwner.pollOnce({ forDelivery: true })).rejects.toThrow("ACK request lost");
    expect(captured).toHaveLength(1); const actualReceiptId = captured[0]!.id; deliveryIds.push(actualReceiptId);
    const beforeRedelivery = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, endpointId));
    expect(beforeRedelivery).toHaveLength(1);
    const [retainedBusy] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, busyEndpointId));
    expect((retainedBusy!.setup as InternalSetupState).slackCloudIntent).toMatchObject({ active: false, attempts: 0 });
    expect(eventOwner.nextPollAt()).not.toBeNull();
    expect(eventOwner.nextPollAt()!).toBeGreaterThan(Date.now());
    expect(eventOwner.nextPollAt()!).toBeLessThanOrEqual(Date.now() + 5_000);
    releaseEnrollmentLease!(); await heldEnrollmentLease;

    const expired = await pool.query("UPDATE cloud_harness.connector_webhook_delivery_targets SET lease_expires_at=$3 WHERE connector_instance_id=$1 AND delivery_id=$2 AND status='leased' RETURNING delivery_id",
      [instanceId, actualReceiptId, new Date(Date.now() - 1)]);
    expect(expired.rowCount).toBe(1);
    expect((await eventOwner.pollOnce({ forDelivery: true })).processed).toBe(1);
    expect(captured.map(value => value.id)).toEqual([actualReceiptId, actualReceiptId]);
    const [settledBusy] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, busyEndpointId));
    expect((settledBusy!.setup as InternalSetupState).slackCloudIntent).toBeUndefined();
    expect((settledBusy!.setup as InternalSetupState).slackCloudRetiredGeneration).toBe(1);

    expect(captured[1]!.createdAt).toBe(captured[0]!.createdAt); expect(captured[1]!.payload).toEqual(captured[0]!.payload);
    expect(sdkCallbacks).toHaveLength(2); expect(sdkCallbacks[0]!.message.id).toBe(sdkCallbacks[1]!.message.id);
    expect(sdkCallbacks[0]!.thread.id).toBe(sdkCallbacks[1]!.thread.id);
    const afterRedelivery = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, endpointId));
    expect(afterRedelivery).toHaveLength(1); expect(afterRedelivery[0]!.providerEventId).toBe(beforeRedelivery[0]!.providerEventId);
    expect(deferred.length).toBeGreaterThan(0);
    await deferred.shift()!();
    await normalService.processQueuedDeliveries();
    const links = await db.select().from(chatMessageLinks).where(and(eq(chatMessageLinks.endpointId, endpointId), eq(chatMessageLinks.direction, "inbound")));
    expect(links).toHaveLength(1); expect(links[0]!.deliveryId).toBe(afterRedelivery[0]!.id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, task!.id));
    expect(comments.filter(value => value.id === links[0]!.commentId)).toHaveLength(1);
    expect(comments.find(value => value.id === links[0]!.commentId)?.body).toContain("one durable reply");
    const wakeReceipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeReceipts).toHaveLength(1);
    await normalHeartbeat.drainActiveRunExecutions();
    const completedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(completedRuns).toHaveLength(1);
    expect(completedRuns[0]).toMatchObject({ status: "succeeded", exitCode: 0, wakeupRequestId: wakeReceipts[0]!.id });
    expect(completedRuns[0]!.startedAt).not.toBeNull();
    expect(completedRuns[0]!.finishedAt).not.toBeNull();
    expect(completedRuns[0]!.stdoutExcerpt).toContain(markerText);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pid: number; runId: string; marker: string };
    expect(marker).toMatchObject({ runId: completedRuns[0]!.id, marker: markerText });
    expect(marker.pid).not.toBe(process.pid);
    expect(((await endpoint()).setup as InternalSetupState).slackCallbackSurfaces).toEqual(callbackEvidence);
    const signingRef = refs.find(ref => ref.configPath === "credentials.signingSecret")!;
    await vault.update(signingRef.secretId, { status: "disabled" });
    try {
      await expect(dispatchSlackCloudEvent(db, captured[1]!)).rejects.toMatchObject({
        code: "signing_credential_unavailable", disposition: "attention",
      });
      expect(sdkCallbacks).toHaveLength(2);
    } finally { await vault.update(signingRef.secretId, { status: "active" }); }

    expect(await connector.leaseEvents({ subject: actorId, companyId, eventWakeVersion: 1 })).toBeNull();
    for (const transport of transports) await transport.assertNoErrors();
    await normalService.shutdown(); normalService = undefined;
    let rejectAfterIntent = false;
    const beforeRollbackRequests = enrollmentRequests;
    const stopSignals = subscribeDatabaseWork(db, DELIVERY_QUEUES.connectionEvents, event => { if (event === "intent") rejectAfterIntent = true; });
    normalService = chatChannelService(db, { heartbeat: normalHeartbeat, fetch: receiptFetch, publicBaseUrl: "https://tenant.example",
      scheduleDeferredWork: work => { deferred.push(work); }, renewCredentialMutationLease: async () => !rejectAfterIntent });
    try {
      await expect(normalService.configure(endpointId, { action: "pause" }, actorId)).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
      expect((await endpoint()).status).toBe("active");
      expect(((await endpoint()).setup as InternalSetupState).runtimeGeneration).toBe(2);
      expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toBeUndefined();
      expect(enrollmentRequests).toBe(beforeRollbackRequests);
    } finally { stopSignals(); await normalService.shutdown(); normalService = undefined; }
    normalService = chatChannelService(db, { heartbeat: normalHeartbeat, fetch: receiptFetch, publicBaseUrl: "https://tenant.example",
      scheduleDeferredWork: work => { deferred.push(work); } });
    await db.transaction(async tx => {
      await tx.update(chatEndpoints).set({ setup: { ...((await endpoint()).setup as InternalSetupState), runtimeGeneration: 3 } as InternalSetupState }).where(eq(chatEndpoints.id, endpointId));
      await stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, actorId);
    });
    loseEnrollmentResponse = true;
    await withLease(await endpoint(), lease => produce(endpointId, actorId, lease));
    expect((await broker.slackEvents.current(instanceId, publicId)).runtimeGeneration).toBe(3);
    expect(((await endpoint()).setup as InternalSetupState).slackCloudEvents!.runtimeGeneration).toBe(2);
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ active: true, runtimeGeneration: 3, failureCode: "broker_unavailable" });
    await withLease(await endpoint(), async lease => {
      let transactionChecks = 0;
      await produce(endpointId, actorId, { assertOwned: async transaction => {
        await lease.assertOwned(transaction);
        if (transaction && ++transactionChecks === 2) throw new Error("fixture final enrollment guard lost");
      } });
    });
    expect(((await endpoint()).setup as InternalSetupState).slackCloudEvents!.runtimeGeneration).toBe(2);
    const casProducer = createSlackCloudEnrollment(db, { runtimeGeneration: setup => Number(setup.runtimeGeneration), resolveCredentials: async () => {
      await db.update(chatEndpoints).set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', '4'::jsonb)` }).where(eq(chatEndpoints.id, endpointId));
      return { signingSecret };
    } });
    await expect(withLease(await endpoint(), lease => casProducer(endpointId, actorId, lease))).rejects.toThrow("changed");
    expect(((await endpoint()).setup as InternalSetupState).slackCloudEvents!.runtimeGeneration).toBe(2);
    brokerUnavailable = true;
    expect((await normalService.configure(endpointId, { action: "pause" }, actorId)).status).toBe("paused");
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ active: false, runtimeGeneration: 5, attempts: 0 });
    await expect(eventOwner.pollOnce({ forDelivery: true })).rejects.toThrow("status=503");
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ failureCode: "broker_unavailable", attempts: 1 });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "");
    expect((await normalService.configure(endpointId, { action: "remove" }, actorId)).status).toBe("archived");
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ active: false, runtimeGeneration: 6, subject: actorId, attempts: 0 });
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ active: false, runtimeGeneration: 6, failureCode: "connector_configuration_unavailable", nextAttemptAt: null });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0]!.credentialSecretRefs).toEqual([]);
    expect((await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId)))[0]!.status).toBe("removed");
    await normalService.shutdown(); normalService = undefined;
    brokerUnavailable = false;
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", base);
    normalService = chatChannelService(db, { heartbeat: normalHeartbeat, fetch: receiptFetch, publicBaseUrl: "https://tenant.example",
      scheduleDeferredWork: work => { deferred.push(work); } });
    const reconstructedOwner = githubConnectionEventService(db, { connector });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", `replacement-${instanceId}`);
    await reconstructedOwner.pollOnce({ forDelivery: true });
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toMatchObject({ instanceId, failureCode: "connector_configuration_unavailable", nextAttemptAt: null });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", instanceId);
    await reconstructedOwner.pollOnce({ forDelivery: true });
    expect(reconstructedOwner.nextPollAt()).toBeNull();
    expect(((await endpoint()).setup as InternalSetupState).slackCloudIntent).toBeUndefined();
    expect(((await endpoint()).setup as InternalSetupState).slackCloudRetiredGeneration).toBe(6);
    expect(await broker.slackEvents.current(instanceId, publicId)).toBeUndefined();
    expect((await store.listWebhookBindings(instanceId)).find((value: { receivesEvents?: boolean }) => value.receivesEvents === false).providerMetadata.retirement.runtimeGeneration).toBe(6);
    await expect(broker.slackEvents.enroll(await store.getInstance(instanceId), actorId, { companyId, endpointId, publicId, connectionId,
      runtimeGeneration: 3, teamId: "TTEST", appId: "ATEST", signingSecret })).rejects.toThrow("GENERATION_CHANGED");

    const pendingIds = [randomUUID(), randomUUID()];
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "");
    for (const [index, pendingId] of pendingIds.entries()) {
      const pendingConnectionId = randomUUID();
      await db.insert(toolConnections).values({ id: pendingConnectionId, companyId, applicationId, name: "Retired Slack", uid: pendingId,
        transport: "chat_sdk", connectionPurpose: "channel", enabled: false, status: "disabled" });
      await db.insert(chatEndpoints).values({ id: pendingId, companyId, connectionId: pendingConnectionId, assignedAgentId: agentId,
        publicId: (index === 0 ? "d" : "e").repeat(43), provider: "slack", status: "archived", providerAccountId: "TTEST",
        setup: { runtimeGeneration: 1, slackCloudInstanceId: instanceId, slackCloudSubject: actorId } as InternalSetupState });
      await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, pendingId, actorId));
    }
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", base);
    await reconstructedOwner.pollOnce({ forDelivery: true });
    const remaining = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, companyId),
      sql`${chatEndpoints.setup}->'slackCloudIntent' is not null`));
    expect(remaining).toHaveLength(1);
    expect(pendingIds).toContain(remaining[0]!.id);
    expect(reconstructedOwner.nextPollAt()).not.toBeNull();
    expect(reconstructedOwner.nextPollAt()!).toBeLessThanOrEqual(Date.now());
    await reconstructedOwner.pollOnce({ forDelivery: true });
    expect(await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, companyId),
      sql`${chatEndpoints.setup}->'slackCloudIntent' is not null`))).toHaveLength(0);
    expect(reconstructedOwner.nextPollAt()).toBeNull();

  } catch (error) {
    console.error("Slack paired fixture body failure", error);
    throw error;
  } finally {
    releaseEnrollmentLease?.(); await heldEnrollmentLease;
    await normalHeartbeat?.drainActiveRunExecutions();
    await normalService?.shutdown();
    unregister?.(); await runtime?.shutdown();
    if (server.listening) { server.close(); await once(server, "close"); }
    vi.unstubAllEnvs();
    try {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(financeEvents).where(eq(financeEvents.companyId, companyId));
      await db.delete(costEvents).where(eq(costEvents.companyId, companyId));
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
      await db.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId));
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
      await db.delete(companySecrets).where(eq(companySecrets.companyId, companyId));
      await db.delete(companySkills).where(eq(companySkills.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
      await db.delete(authUsers).where(eq(authUsers.id, actorId));
      await pool.query("DELETE FROM cloud_harness.connector_instances WHERE id=$1", [instanceId]);
      await pool.query("DELETE FROM cloud_harness.connector_webhook_deliveries WHERE id=ANY($1::text[])", [deliveryIds]);
    } finally { await closeCheckpointDb(db, 1); await closeFileStorageDb(db, 1); await closeLivenessDb(db, 1);
      await db.$client.end({ timeout: 1 }); await registry.close();
      if (secretDirectory) await rm(secretDirectory, { recursive: true, force: true });
      try { network.assertQuiet(); } finally { network.restore(); }
    }
  }
}, 60_000);
