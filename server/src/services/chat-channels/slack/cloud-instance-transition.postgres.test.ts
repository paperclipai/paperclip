import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { SLACK_CHAT_BOT_SCOPES, type ToolCredentialSecretRef } from "@paperclipai/shared";
import { activityLog, agents, applyPendingMigrations, authUsers, chatEndpoints, chatSlackRegistrations, closeCheckpointDb, closeFileStorageDb, closeLivenessDb, companies, companyMemberships, companySecrets, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../../lib/dedicated-test-database-url.js";
import { heartbeatService } from "../../heartbeat.js";
import { chatChannelService } from "../../chat-channels.js";
import { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { githubConnectionEventService } from "../../github-connection-events.js";
import { registerGitHubConnectionEventWork } from "../../github-connection-work.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../../paperclip-cloud-connector.js";
import { secretService } from "../../secrets.js";
import type { InternalSetupState } from "../runtime-types.js";
import { guardSlackFixtureNetwork } from "./cloud-test-transport.js";

const appUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_TEST_DATABASE_URL");
const cloudUrl = resolveExternalTestDatabaseUrl("SLACK_EVENT_TEST_DATABASE_URL");
const cloudDist = process.env.SLACK_TEST_CLOUD_DIST;

it.skipIf(!appUrl || !cloudUrl || !cloudDist)("normal notifications enroll the first consumer and authorized reconfigure replaces only positively retired instance custody", async () => {
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
    applyMigrations(folder: string, timeout: number): Promise<void>; hydrate(): Promise<void>; close(): Promise<void>;
  };
  try { await registry.applyMigrations(path.resolve(cloudDist!, "../migrations"), 30_000); await registry.hydrate(); }
  catch (error) { await db.$client.end({ timeout: 1 }); await registry.close(); throw error; }
  const store = new PostgresConnectorStore(pool), secrets = new InMemoryProviderSecretStore();
  const id = randomUUID(), companyId = randomUUID(), endpointId = randomUUID(), connectionId = randomUUID(), applicationId = randomUUID(), agentId = randomUUID();
  const actor = `owner-${id}`, instanceA = `a-${id}`, instanceB = `b-${id}`, publicId = "h".repeat(43);
  const stackIds = [instanceA, instanceB], signingSecret = "0123456789abcdef0123456789abcdef";
  const keys = stackIds.map(() => ({ sign: generateKeyPairSync("ed25519"), seal: generateKeyPairSync("x25519") }));
  let broker: InstanceType<typeof ConnectorBroker>, base = "", loseEnrollmentResponse = false;
  const requests: { path: string; issuer?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url! });
    if (loseEnrollmentResponse && req.url === "/v1/connector/slack-events") {
      loseEnrollmentResponse = false;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    void broker.handle(req, res, new URL(req.url!, base)).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500); res.end(String(error));
    });
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "slack-transition-"));
  let service: ReturnType<typeof chatChannelService> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerGitHubConnectionEventWork> | undefined;
  const errors: unknown[] = [];
  const endpoint = async () => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]!;
  const setup = async () => (await endpoint()).setup as InternalSetupState;
  const configureIdentity = (index: number) => {
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", stackIds[index]!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", keys[index]!.sign.privateKey.export({ format: "jwk" }).d!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", keys[index]!.seal.privateKey.export({ format: "jwk" }).d!);
  };
  try {
    for (const [index, stackId] of stackIds.entries()) {
      await new CloudStackProvisioner({ provider: new FakeCloudStackProvider(), registry }).provisionDevelopmentStack({
        idempotencyKey: stackId, accountGroup: { id: `account-${stackId}`, slug: stackId, displayName: "Transition" },
        owner: { id: actor, email: `${id}@example.test` },
        stack: { stackId, accountGroupId: `account-${stackId}`, stackSlug: stackId, displayName: "Transition", kind: "demo", primaryHost: `${stackId}.example.test`, region: "us-east-1" },
        versionPlan: { appVersion: "fixture", schemaVersion: "fixture", rolloutTrack: "stable" },
        sleepPolicy: { desiredState: "awake" }, primaryCompany: { paperclipCompanyId: index === 0 ? companyId : randomUUID(), displayName: "Transition", defaultBudgetCents: 0 },
      });
      await store.putCloudStackInstance({ id: stackId, kind: "cloud_stack", companyStackId: stackId, ownerUserId: actor, environment: "test",
        signPublicKey: keys[index]!.sign.publicKey.export({ format: "jwk" }).x!, sealPublicKey: keys[index]!.seal.publicKey.export({ format: "jwk" }).x!,
        origins: ["https://tenant.example"], activeOrigin: "https://tenant.example", label: "Transition", status: "active", createdAt: new Date(), updatedAt: new Date() });
    }
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    base = `http://127.0.0.1:${address.port}`;
    broker = new ConnectorBroker({ publicOrigin: base, environment: "test", store,
      providers: providerRegistryFromEnvironment({}, "test"), secrets: { resolve: async () => undefined },
      authenticate: async () => ({ globalUserId: actor }), slackEvents: { secrets, secretRefPrefix: "secret:///test/transition" },
      eventWakeEnrollmentEnabled: true, eventWakeDeliveryEnabled: true, wakeCloudStack: async () => {} });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", base); vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(directory, "master.key")); configureIdentity(0);
    await db.insert(companies).values({ id: companyId, name: "Transition", issuePrefix: `T${id.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: actor, name: "Owner", email: `${id}@owner.example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actor, status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Transition", adapterType: "process", status: "idle" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Transition", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Transition", uid: id,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: false, status: "disabled" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId,
      provider: "slack", status: "paused", providerAccountId: "TTEST", botExternalId: "UBOT", setup: { runtimeGeneration: 0, step: "complete" } as InternalSetupState });
    await db.insert(chatSlackRegistrations).values({ companyId, endpointId, requestId: randomUUID(), status: "configured", appId: "ATEST",
      manifest: {}, manifestHash: "fixture", callbackUri: "https://tenant.example/callback", createdByUserId: actor });
    const vault = secretService(db), refs: ToolCredentialSecretRef[] = [];
    for (const [key, value] of Object.entries({ botToken: "xoxb-fixture", signingSecret })) {
      const secret = await vault.create(companyId, { name: `${key}-${id}`, provider: "local_encrypted", value }, { userId: actor });
      await vault.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connectionId, configPath: `credentials.${key}` });
      refs.push({ secretId: secret.id, versionSelector: "latest", configPath: `credentials.${key}`, required: true, projectionClass: "unclassified" });
    }
    await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, connectionId));
    const fetchImpl: typeof fetch = async input => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.href === "https://slack.com/api/auth.test") return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT", user: "fixture" }, { headers: { "x-oauth-scopes": SLACK_CHAT_BOT_SCOPES.join(",") } });
      if (url.origin === "https://slack.com" && url.pathname === "/api/conversations.list") return Response.json({ ok: true, channels: [], response_metadata: {} });
      throw new Error(`Unexpected transition provider request ${url}`);
    };
    heartbeat = heartbeatService(db);
    service = chatChannelService(db, { heartbeat, fetch: fetchImpl, publicBaseUrl: "https://tenant.example" });
    const events = githubConnectionEventService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    worker = registerGitHubConnectionEventWork(db, coordinator, events, () => true); await worker.ready;
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    const leaseCount = () => requests.filter(value => value.path === "/v1/connector/events/lease").length;
    expect(leaseCount()).toBe(0);
    await service.configure(endpointId, { action: "resume" }, actor);
    await vi.waitFor(async () => expect((await setup()).slackCloudEvents?.runtimeGeneration).toBe(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(leaseCount()).toBeGreaterThan(0), { timeout: 10_000 });
    expect((await store.getInstance(instanceA)).eventWakeVersion).toBe(1);
    expect((await setup()).slackCloudInstanceId).toBe(instanceA);
    await service.configure(endpointId, { action: "pause" }, actor);
    await vi.waitFor(async () => expect((await setup()).slackCloudRetiredGeneration).toBe(2), { timeout: 10_000 });
    expect(await broker.slackEvents.current(instanceA, publicId)).toBeUndefined();
    expect((await store.listWebhookBindings(instanceA)).every((binding: { receivesEvents: boolean }) => !binding.receivesEvents)).toBe(true);
    const retired = await setup(); configureIdentity(1);
    const foreign = createPaperclipCloudConnector({ config: paperclipCloudConnectorConfigFromEnv()! });
    await expect(foreign.slackEventEnrollment({ subject: `foreign-${actor}`, companyId, enrollment: {
      active: true, companyId, endpointId, publicId, connectionId, runtimeGeneration: 3, teamId: "TTEST", appId: "ATEST", signingSecret,
    } })).rejects.toMatchObject({ status: 403 });
    expect(await broker.slackEvents.current(instanceB, publicId)).toBeUndefined();
    expect((await setup()).slackCloudIntent).toBeUndefined();
    expect((await setup()).slackCloudInstanceId).toBe(instanceA);
    expect((await setup()).slackCloudSubject).toBe(actor);
    await service.configure(endpointId, { action: "resume" }, actor);
    const pending = await setup();
    expect(pending.slackCloudIntent).toMatchObject({ instanceId: instanceB, runtimeGeneration: 3, subject: actor });
    expect(pending.slackCloudInstanceId).toBe(instanceA);
    expect(pending.slackCloudEvents).toEqual(retired.slackCloudEvents);
    await vi.waitFor(async () => expect((await setup()).slackCloudInstanceId).toBe(instanceB), { timeout: 10_000 });
    expect((await setup()).slackCloudIntent).toBeUndefined();
    expect((await setup()).slackCloudRetiredGeneration).toBeUndefined();
    expect((await broker.slackEvents.current(instanceB, publicId)).runtimeGeneration).toBe(3);
    expect(await broker.slackEvents.current(instanceA, publicId)).toBeUndefined();
    await service.configure(endpointId, { action: "pause" }, actor);
    await vi.waitFor(async () => expect((await setup()).slackCloudRetiredGeneration).toBe(4), { timeout: 10_000 });
    loseEnrollmentResponse = true;
    await service.configure(endpointId, { action: "resume" }, actor);
    await vi.waitFor(async () => expect((await setup()).slackCloudIntent).toMatchObject({ instanceId: instanceB,
      runtimeGeneration: 5, failureCode: "broker_unavailable" }), { timeout: 10_000 });
    expect((await broker.slackEvents.current(instanceB, publicId)).runtimeGeneration).toBe(5);
    expect((await setup()).slackCloudEvents?.runtimeGeneration).toBe(3);
    const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", event_id: `EvLostReplacement-${id}`, team_id: "TTEST", api_app_id: "ATEST",
      event: { type: "app_mention", text: "removed before admission", user: "UOPERATOR", channel: "CTEST", ts: "1788.600" } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    await broker.slackEvents.receive(await broker.slackEvents.current(instanceB, publicId), { rawBody, timestamp,
      signature: `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}` });
    await service.configure(endpointId, { action: "remove" }, actor);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0]!.credentialSecretRefs).toEqual([]);
    await vi.waitFor(async () => expect((await setup()).slackCloudRetiredGeneration).toBe(6), { timeout: 10_000 });
    expect((await setup()).slackCloudIntent).toBeUndefined();
    expect((await setup()).slackCloudInstanceId).toBe(instanceB);
    expect(await broker.slackEvents.current(instanceB, publicId)).toBeUndefined();
    expect((await pool.query("SELECT delivery_id FROM cloud_harness.connector_webhook_delivery_targets WHERE connector_instance_id=$1", [instanceB])).rows).toEqual([]);
    await expect(broker.slackEvents.enroll(await store.getInstance(instanceB), actor, { companyId, endpointId, publicId, connectionId,
      runtimeGeneration: 5, teamId: "TTEST", appId: "ATEST", signingSecret })).rejects.toThrow("GENERATION_CHANGED");
    expect(errors).toEqual([]);
  } catch (error) { console.error("Slack instance transition body failure", error); throw error; }
  finally {
    await worker?.stop(); await coordinator?.stop(); await service?.shutdown(); await heartbeat?.drainActiveRunExecutions();
    if (server.listening) { server.close(); await once(server, "close"); }
    vi.unstubAllEnvs();
    try {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
      await db.delete(companySecrets).where(eq(companySecrets.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
      await db.delete(authUsers).where(eq(authUsers.id, actor));
      await pool.query("DELETE FROM cloud_harness.connector_instances WHERE id=ANY($1::text[])", [stackIds]);
    } finally {
      await closeCheckpointDb(db, 1); await closeFileStorageDb(db, 1); await closeLivenessDb(db, 1);
      await db.$client.end({ timeout: 1 }); await registry.close(); await rm(directory, { recursive: true, force: true });
      try { network.assertQuiet(); } finally { network.restore(); }
    }
  }
}, 60_000);
