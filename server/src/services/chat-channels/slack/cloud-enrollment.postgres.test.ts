import { guardSlackFixtureNetwork, stubSlackFixtureTransport } from "./cloud-test-transport.js";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, chatEndpoints, chatSlackRegistrations, companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../../lib/dedicated-test-database-url.js";
import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../../paperclip-cloud-connector.js";
import { createChatSdkEndpointRuntime } from "../../chat-sdk-runtime.js";
import { createSlackCloudEnrollment, stageSlackCloudEnrollmentIntent } from "./cloud-enrollment.js";
import { createSlackCloudEventIngress, dispatchSlackCloudEvent } from "./cloud-ingress.js";
import type { InternalSetupState } from "../runtime-types.js";

const appUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_TEST_DATABASE_URL");
const cloudUrl = resolveExternalTestDatabaseUrl("SLACK_EVENT_TEST_DATABASE_URL");
const cloudDist = process.env.SLACK_TEST_CLOUD_DIST;

it.skipIf(!appUrl || !cloudUrl || !cloudDist)("ordinary Slack enrollment producer and reconstructed SDK owner drain the sealed PostgreSQL event lane", async () => {
  const network = guardSlackFixtureNetwork();
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
  const instanceId = `instance-${id}`, stackId = `slack-${id}`, publicId = "a".repeat(43), signingSecret = "0123456789abcdef0123456789abcdef";
  const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519"), now = new Date();
  let broker: InstanceType<typeof ConnectorBroker>;
  const server = createServer((req, res) => { void broker.handle(req, res, new URL(req.url!, base)).catch((error: unknown) => {
    if (!res.headersSent) res.writeHead(500); res.end(String(error));
  }); });
  let base = "";
  let unregister: (() => void) | undefined;
  let runtime: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
  const deliveryIds: string[] = [];
  try {
    await new CloudStackProvisioner({ provider: new FakeCloudStackProvider(), registry }).provisionDevelopmentStack({
      idempotencyKey: id, accountGroup: { id: `account-${id}`, slug: stackId, displayName: "Slack fixture" },
      owner: { id: `user-${id}`, email: `${id}@example.test` },
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
      authenticate: async () => ({ globalUserId: "actor" }), canApproveInstance: async () => true,
      slackEvents: { secrets, secretRefPrefix: "secret:///test/slack" },
      eventWakeEnrollmentEnabled: true, eventWakeDeliveryEnabled: true, wakeCloudStack: wake });
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", instanceId);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", signing.privateKey.export({ format: "jwk" }).d!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", sealing.privateKey.export({ format: "jwk" }).d!);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", base);
    await db.insert(companies).values({ id: companyId, name: "Slack", issuePrefix: `S${id.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Slack", adapterType: "codex_local" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: id,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId,
      publicId, provider: "slack", status: "active", providerAccountId: "TTEST", setup: { runtimeGeneration: 1 } as InternalSetupState });
    await db.insert(chatSlackRegistrations).values({ companyId, endpointId, requestId: randomUUID(), status: "configured",
      manifest: {}, manifestHash: "fixture", callbackUri: "https://tenant.example/callback", appId: "ATEST", createdByUserId: "actor" });
    const withLease = chatCredentialMutationLease(db);
    const resolveCredentials = vi.fn(async () => ({ signingSecret }));
    const produce = createSlackCloudEnrollment(db, { resolveCredentials,
      runtimeGeneration: setup => Number(setup.runtimeGeneration ?? 0) });
    const endpoint = async () => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]!;
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, "actor"));
    await withLease(await endpoint(), lease => produce(endpointId, "actor", lease));
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
    expect(await connector.leaseEvents({ subject: "actor", companyId, eventWakeVersion: 1 })).toBeNull();
    expect(await broker.slackEvents.receive(current, request)).toEqual({ status: 200, duplicate: false });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    const leased = await connector.leaseEvents({ subject: "actor", companyId, eventWakeVersion: 1 });
    expect(leased?.failedEventIds).toBeUndefined(); expect(leased?.events).toHaveLength(1);
    const event = leased!.events[0]!; deliveryIds.push(event.id);
    if (event.provider !== "slack") throw new Error("Unexpected event owner");
    await expect(dispatchSlackCloudEvent(db, event)).rejects.toThrow("not ready");
    const onMessage = vi.fn(async () => {});
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
    expect(await connector.acknowledgeEvents({ subject: "actor", companyId, leaseId: leased!.leaseId, deliveryIds: [event.id] })).toBe(1);
    expect(await connector.leaseEvents({ subject: "actor", companyId, eventWakeVersion: 1 })).toBeNull();
    await db.update(chatEndpoints).set({ setup: { ...saved, runtimeGeneration: 2 } as InternalSetupState }).where(eq(chatEndpoints.id, endpointId));
    await dispatchSlackCloudEvent(db, event);
    expect(onMessage).toHaveBeenCalledOnce();
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, "actor"));
    await withLease(await endpoint(), lease => produce(endpointId, "actor", lease));
    const replacement = ((await endpoint()).setup as InternalSetupState).slackCloudEvents!;
    expect(replacement.runtimeGeneration).toBe(2); expect(replacement.bindingId).not.toBe(saved.slackCloudEvents!.bindingId);
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, endpointId));
    await db.transaction(tx => stageSlackCloudEnrollmentIntent(tx as unknown as typeof db, endpointId, "actor"));
    await withLease(await endpoint(), lease => produce(endpointId, "actor", lease));
    expect(await broker.slackEvents.current(instanceId, publicId)).toBeUndefined();
  } finally {
    unregister?.(); await runtime?.shutdown();
    if (server.listening) { server.close(); await once(server, "close"); }
    vi.unstubAllEnvs();
    try {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
      await pool.query("DELETE FROM cloud_harness.connector_instances WHERE id=$1", [instanceId]);
      await pool.query("DELETE FROM cloud_harness.connector_webhook_deliveries WHERE id=ANY($1::text[])", [deliveryIds]);
    } finally { await db.$client.end({ timeout: 1 }); await registry.close();
      try { network.assertQuiet(); } finally { network.restore(); }
    }
  }
}, 60_000);
