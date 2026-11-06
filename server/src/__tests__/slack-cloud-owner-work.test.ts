import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_CHAT_BOT_SCOPES } from "@paperclipai/shared";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, applyPendingMigrations, authUsers,
  chatDeliveries, chatEndpoints, chatExternalPrincipals, companySecretBindings, chatIdentityLinks, chatSlackRegistrations, companies, companyMemberships,
  companySecrets, companySkills, costEvents, financeEvents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, toolApplications, toolConnections,
  closeCheckpointDb, closeFileStorageDb, closeLivenessDb, createDb } from "@paperclipai/db";
import { databaseWorkPending, reconcileDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createSlackCloudConnectorFixture } from "./helpers/slack-cloud-connector-fixture.js";
import { chatChannelService } from "../services/chat-channels.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { ChatRuntime } from "../services/chat-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { chatCredentialMutationLease } from "../services/chat-credential-mutation-lease.js";
import { createSlackCloudEnrollment, registerSlackCloudEnrollmentOwner, reconcilePendingSlackCloudEnrollments } from "../services/chat-channels/slack/cloud-enrollment.js";
import { conflict } from "../errors.js";
import { guardSlackFixtureNetwork, stubSlackFixtureTransport } from "./helpers/slack-cloud/transport.js";
import type { InternalSetupState } from "../services/chat-channels/runtime-types.js";
import type { ChatSdkMessageCallbackEvent } from "../services/chat-sdk-runtime.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_OWNER_TEST_DATABASE_URL");
if (process.env.SLACK_GATE_EXPECT_PRELOAD === "1" && !external) throw new Error("Guarded local Slack owner tests require their exact external test database");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Slack Cloud default owner and SQL fences", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let service: ReturnType<typeof chatChannelService>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let cloud: ReturnType<typeof createSlackCloudConnectorFixture>;
  let network: ReturnType<typeof guardSlackFixtureNetwork>;
  let directory: string;
  let companyId: string, actorId: string, agentId: string, applicationId: string;
  let runtime: ChatRuntime;
  let providerFetch: typeof fetch;
  const callbacks: ChatSdkMessageCallbackEvent[] = [];
  const transports: ReturnType<typeof stubSlackFixtureTransport>[] = [];
  const releases: (() => void)[] = [];
  const heldLeases: Promise<unknown>[] = [];
  const deferred: (() => void | Promise<void>)[] = [];
  const secret = "0123456789abcdef0123456789abcdef";
  const row = async (id: string) => (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, id)))[0]!;
  const setup = async (id: string) => (await row(id)).setup as InternalSetupState;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("slack-cloud-owner-");
    const url = external ?? temporary!.connectionString;
    await applyPendingMigrations(url);
    db = createDb(url, { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  beforeEach(async () => {
    callbacks.length = 0; transports.length = 0; releases.length = 0; heldLeases.length = 0; deferred.length = 0;
    network = guardSlackFixtureNetwork({ requirePreload: process.env.SLACK_GATE_EXPECT_PRELOAD === "1" });
    directory = await mkdtemp(path.join(os.tmpdir(), "slack-owner-default-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(directory, "master.key"));
    companyId = randomUUID(); actorId = `slack-owner-${randomUUID()}`; agentId = randomUUID(); applicationId = randomUUID();
    cloud = createSlackCloudConnectorFixture(`instance-${randomUUID()}`, companyId, actorId); cloud.install();
    vi.spyOn(globalThis, "fetch").mockImplementation(cloud.request);
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Slack default owner", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: actorId, name: "Slack owner", email: `${actorId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId, status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Slack fixture", adapterType: "process", status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: false, intervalSec: 0 } } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    runtime = makeRuntime();
    const slackFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://slack.com") throw new Error(`Unexpected Slack fixture origin ${url.origin}`);
      if (url.pathname === "/api/auth.test") {
        expect(init?.method).toBe("POST");
        const token = new Headers(init?.headers).get("authorization") ?? "";
        const suffix = token.slice(token.lastIndexOf("-") + 1);
        return Response.json({ ok: true, team_id: `T${suffix}`, team: "Fixture", user_id: `U${suffix}`, user: "fixture" },
          { headers: { "x-oauth-scopes": SLACK_CHAT_BOT_SCOPES.join(",") } });
      }
      if (url.pathname === "/api/conversations.list") return Response.json({ ok: true,
        channels: [{ id: "CTEST", name: "fixture", is_member: true }], response_metadata: { next_cursor: "" } });
      if (["/api/reactions.add", "/api/reactions.remove"].includes(url.pathname)) return Response.json({ ok: true });
      throw new Error(`Unexpected Slack fixture method ${url.pathname}`);
    };
    providerFetch = slackFetch;
    heartbeat = heartbeatService(db);
    service = chatChannelService(db, { runtime, heartbeat, fetch: slackFetch, publicBaseUrl: "https://tenant.example",
      deferWebhookProcessing: true, scheduleDeferredWork: work => { deferred.push(work); } });
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const release of releases) release();
    for (const work of heldLeases) { try { await work; } catch (error) { errors.push(error); } }
    try { await service?.shutdown(); } catch (error) { errors.push(error); }
    try { await heartbeat?.drainActiveRunExecutions(); } catch (error) { errors.push(error); }
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
    } catch (error) { errors.push(error); }
    try { network.assertQuiet(); } catch (error) { errors.push(error); }
    network.restore(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Slack owner fixture cleanup failed; original body failure is reported separately by Vitest");
  });
  afterAll(async () => {
    const closed = await Promise.allSettled([closeCheckpointDb(db, 1), closeFileStorageDb(db, 1), closeLivenessDb(db, 1)]);
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
    const errors = closed.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Slack owner auxiliary shutdown failed");
  });
  function makeRuntime() {
    const runtime = new ChatRuntime();
    const replace = runtime.replaceEndpoint.bind(runtime);
    vi.spyOn(runtime, "replaceEndpoint").mockImplementation(async input => {
      if (input.providerConfig.provider !== "slack") throw new Error("Unexpected fixture provider");
      const value = await replace({ ...input, providerConfig: { ...input.providerConfig,
        credentials: { ...input.providerConfig.credentials, apiUrl: "http://127.0.0.1:1/api/" } },
        callbacks: { ...input.callbacks, onMessage: async event => { callbacks.push(event); await input.callbacks.onMessage(event); } } });
      transports.push(stubSlackFixtureTransport(value.getProviderAdapter())); return value;
    });
    return runtime;
  }
  async function createEndpoint(suffix: string) {
    const endpointId = randomUUID(), connectionId = randomUUID(), publicId = randomUUID().replaceAll("-", "").padEnd(43, "a");
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: `Slack ${suffix}`, uid: endpointId,
      transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId,
      provider: "slack", status: "draft", sponsorUserId: actorId, allowGroupChats: true, setup: { step: "provider_setup" } });
    await db.insert(chatSlackRegistrations).values({ companyId, endpointId, requestId: randomUUID(), status: "configured", appId: `A${suffix}`,
      manifest: {}, manifestHash: "fixture", callbackUri: `https://tenant.example/api/chat-webhooks/${publicId}/slack`, createdByUserId: actorId });
    await service.configure(endpointId, { action: "configure", credentials: { botToken: `xoxb-fixture-${suffix}`, signingSecret: secret } }, actorId);
    expect((await setup(endpointId)).slackCloudIntent).toMatchObject({ companyId, endpointId, connectionId,
      instanceId: cloud.config.instanceId, subject: actorId, active: true });
    return endpointId;
  }
  async function confirm(endpointId: string) {
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    await owner.pollOnce({ forDelivery: true });
    expect((await setup(endpointId)).slackCloudIntent).toBeUndefined();
    expect((await setup(endpointId)).slackCloudEvents).toBeDefined();
    return owner;
  }
  async function activate(endpointId: string) {
    const endpoint = await row(endpointId);
    const accountId = endpoint.providerAccountId;
    if (!accountId) throw new Error("Normal Slack configure did not confirm its workspace");
    const payload = JSON.stringify({ type: "url_verification", team_id: accountId, api_app_id: `A${accountId.slice(1)}`, challenge: "fixture-challenge" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await service.handleWebhook(endpoint.publicId, "slack", new Request(`https://tenant.example/api/chat-webhooks/${endpoint.publicId}/slack`, {
      method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex")}` }, body: payload }));
    expect(response.status).toBe(200); await response.body?.cancel();
    await service.configure(endpointId, { action: "verify" }, actorId);
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: accountId,
      externalId: "UOPERATOR", kind: "user", displayName: "Operator" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal!.id, paperclipUserId: actorId, status: "linked", confirmedAt: new Date() });
    expect((await service.test(endpointId, { optionalSlackTestForUser: actorId })).status).toBe("active");
  }
  async function holdCredentials(endpointId: string) {
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const release = new Promise<void>(resolve => { releases.push(resolve); });
    heldLeases.push(chatCredentialMutationLease(db)(await row(endpointId), async lease => { await lease.assertOwned(); acquired(); await release; }));
    await ready;
  }

  it("normal configure stages SQL intent, worker unseals into registered SDK and old generations cannot reenter", async () => {
    const endpointId = await createEndpoint("BOT");
    await confirm(endpointId); await activate(endpointId); await confirm(endpointId);
    const endpoint = await row(endpointId), saved = await setup(endpointId), enrolled = saved.slackCloudEvents!;
    const callbackEvidence = structuredClone(saved.slackCallbackSurfaces);
    const delivered = cloud.enqueue({ companyId, endpointId, publicId: endpoint.publicId, connectionId: endpoint.connectionId,
      runtimeGeneration: saved.runtimeGeneration, teamId: enrolled.teamId, appId: enrolled.appId, bindingId: enrolled.bindingId }, secret, "EvDefaultOwner");
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    expect((await owner.pollOnce({ forDelivery: true })).processed).toBe(1);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.message.author.userId).toBe("UOPERATOR");
    expect(cloud.acknowledged).toEqual([delivered.id]);
    expect((await setup(endpointId)).slackCallbackSurfaces).toEqual(callbackEvidence);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, endpointId))).toHaveLength(1);
    for (const transport of transports) await transport.assertNoErrors();
    await service.configure(endpointId, { action: "pause" }, actorId);
    const oldRequest = new Request("https://tenant.example/old-receipt", { method: "POST", body: new Uint8Array(delivered.body),
      headers: { "content-type": "application/json", "x-slack-request-timestamp": delivered.packet.timestamp, "x-slack-signature": delivered.packet.signature } });
    const rejected = await service.handleWebhook(endpoint.publicId, "slack", oldRequest, { slackCloudGeneration: Number(saved.runtimeGeneration) });
    expect(await rejected.text()).toBe("superseded");
    expect(callbacks).toHaveLength(1);
    await owner.pollOnce({ forDelivery: true });
    expect((await setup(endpointId)).slackCloudIntent).toBeUndefined();
    expect((await setup(endpointId)).slackCloudRetiredGeneration).toBeGreaterThan(Number(saved.runtimeGeneration));
  }, 60_000);

  it("two due registrations settle B while A still owns a busy credential lease", async () => {
    const a = await createEndpoint("BUSY"); await confirm(a); await activate(a); await confirm(a);
    const b = await createEndpoint("READY"); await confirm(b); await activate(b); await confirm(b);
    await service.configure(a, { action: "pause" }, actorId);
    const before = structuredClone((await setup(a)).slackCloudIntent!);
    await service.configure(b, { action: "pause" }, actorId);
    await holdCredentials(a);
    const start = cloud.calls.length;
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    await owner.pollOnce({ forDelivery: true });
    await owner.pollOnce({ forDelivery: true });
    expect((await setup(b)).slackCloudIntent).toBeUndefined();
    expect((await setup(b)).slackCloudRetiredGeneration).toBeDefined();
    const retained = (await setup(a)).slackCloudIntent!;
    expect(retained).toMatchObject({ ...before, attempts: 1, failureCode: "credential_lease_busy", nextAttemptAt: expect.any(String) });
    expect(Date.parse(retained.nextAttemptAt!)).toBeGreaterThan(Date.now());
    expect(cloud.calls.slice(start).filter(call => call.enrollment?.endpointId === a)).toEqual([]);
    expect(owner.nextPollAt()).not.toBeNull();
    const dueAt = Date.parse(retained.nextAttemptAt!);
    expect(owner.nextPollAt(), "B settlement must retain A’s persisted enrollment deadline").toBe(dueAt);
    releases.splice(0).forEach(release => release()); await Promise.all(heldLeases);
    for (let remaining = dueAt - Date.now(); remaining > 0; remaining = dueAt - Date.now()) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
    await owner.pollOnce();
    expect((await setup(a)).slackCloudIntent).toBeUndefined();
    expect((await setup(a)).slackCloudRetiredGeneration).toBeDefined();
  }, 60_000);

  it("normal configuration rollback leaves no registration debt or retirement request", async () => {
    const endpointId = await createEndpoint("ROLLBACK"); await confirm(endpointId); await activate(endpointId); await confirm(endpointId);
    const before = await row(endpointId), requests = cloud.calls.length;
    await service.shutdown(); runtime = makeRuntime();
    let rejectAfterIntent = false;
    const stop = subscribeDatabaseWork(db, DELIVERY_QUEUES.connectionEvents, event => { if (event === "intent") rejectAfterIntent = true; });
    service = chatChannelService(db, { runtime, heartbeat, fetch: providerFetch, publicBaseUrl: "https://tenant.example",
      deferWebhookProcessing: true, scheduleDeferredWork: work => { deferred.push(work); }, renewCredentialMutationLease: async () => !rejectAfterIntent });
    try {
      await expect(service.configure(endpointId, { action: "pause" }, actorId)).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
      expect((await row(endpointId)).status).toBe(before.status);
      expect(await setup(endpointId)).toEqual(before.setup);
      expect(cloud.calls).toHaveLength(requests);
    } finally { stop(); }
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    await owner.pollOnce({ forDelivery: true });
    expect(cloud.calls.filter(call => call.enrollment?.active === false)).toEqual([]);
  }, 60_000);

  it.each(["intent", "generation"] as const)("real SQL refuses an enrollment response after newer %s custody wins", async change => {
    const endpointId = await createEndpoint(`CAS${change}`);
    const original = (await setup(endpointId)).slackCloudIntent!;
    const successor = { ...original, id: randomUUID(), runtimeGeneration: original.runtimeGeneration + (change === "generation" ? 1 : 0) };
    cloud.beforeReceipt(async () => {
      await db.update(chatEndpoints).set({ setup: sql`jsonb_set(jsonb_set(${chatEndpoints.setup}, '{slackCloudIntent}', ${JSON.stringify(successor)}::jsonb), '{runtimeGeneration}', ${JSON.stringify(successor.runtimeGeneration)}::jsonb)` })
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId)));
    });
    const producer = createSlackCloudEnrollment(db, { resolveCredentials: async () => ({ signingSecret: secret }),
      runtimeGeneration: value => Number(value.runtimeGeneration), connector: cloud.connector });
    await expect(chatCredentialMutationLease(db)(await row(endpointId), lease => producer(endpointId, undefined, lease))).rejects.toThrow("changed");
    expect((await setup(endpointId)).slackCloudIntent).toEqual(successor);
    expect((await setup(endpointId)).slackCloudEvents).toBeUndefined();
  }, 60_000);

  it("malformed sealed Slack receipt is acknowledged once instead of retained as an owner outage", async () => {
    const endpointId = await createEndpoint("INVALID"); await confirm(endpointId);
    const endpoint = await row(endpointId), saved = await setup(endpointId), enrolled = saved.slackCloudEvents!;
    const malformed = cloud.enqueue({ companyId, endpointId: "bad", publicId: endpoint.publicId, connectionId: endpoint.connectionId,
      runtimeGeneration: saved.runtimeGeneration, teamId: enrolled.teamId, appId: enrolled.appId, bindingId: enrolled.bindingId }, secret, "EvMalformed");
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    const result = await owner.pollOnce({ forDelivery: true });
    expect(result.ignored).toBe(1); expect(result.failed).toBe(0);
    expect(cloud.acknowledged).toEqual([malformed.id]);
    expect(callbacks).toEqual([]);
  }, 60_000);

  it.each(["intent", "generation", "malformed-generation"] as const)(
    "busy retry CAS preserves a concurrent %s winner and rethrows the exact owner error", async change => {
      const endpointId = await createEndpoint(`BUSYCAS${change}`);
      const before = await setup(endpointId), original = before.slackCloudIntent!;
      const successor = change === "intent" ? { ...original, id: randomUUID() } : original;
      const generation: unknown = change === "malformed-generation" ? { invalid: true }
        : Number(before.runtimeGeneration) + (change === "generation" ? 1 : 0);
      const busy = conflict("Synthetic owner credential lane is busy", { code: "chat_endpoint_credentials_busy" });
      const requests = cloud.calls.length;
      const pendingBefore = databaseWorkPending(db, DELIVERY_QUEUES.connectionEvents), inheritedSignals: string[] = [];
      const stopInherited = subscribeDatabaseWork(db, DELIVERY_QUEUES.connectionEvents, event => { inheritedSignals.push(event); });
      try {
        console.info(JSON.stringify({ slackRetrySignalProbe: "subscription", endpointId, pendingBefore, immediateSignals: [...inheritedSignals] }));
        expect(inheritedSignals).toEqual(pendingBefore ? ["intent"] : []);
        await reconcileDatabaseWork(db, DELIVERY_QUEUES.connectionEvents);
        const pendingAfter = databaseWorkPending(db, DELIVERY_QUEUES.connectionEvents);
        console.info(JSON.stringify({ slackRetrySignalProbe: "reconciled", endpointId, pendingBefore, pendingAfter, inheritedSignals: [...inheritedSignals] }));
        expect(pendingAfter).toBe(false);
      } finally { stopInherited(); }
      const signals: string[] = [];
      const stopSignals = subscribeDatabaseWork(db, DELIVERY_QUEUES.connectionEvents, event => { signals.push(event); });
      const unregister = registerSlackCloudEnrollmentOwner(db, async id => {
        expect(id).toBe(endpointId);
        await db.update(chatEndpoints).set({ setup: sql`jsonb_set(jsonb_set(${chatEndpoints.setup}, '{slackCloudIntent}', ${JSON.stringify(successor)}::jsonb), '{runtimeGeneration}', ${JSON.stringify(generation)}::jsonb)` })
          .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId)));
        throw busy;
      });
      try {
        await expect(reconcilePendingSlackCloudEnrollments(db, new Date())).rejects.toBe(busy);
        const after = await setup(endpointId);
        expect(after.slackCloudIntent).toEqual(successor);
        expect(after.runtimeGeneration).toEqual(generation);
        expect(after.slackCloudEvents).toBeUndefined();
        expect(cloud.calls).toHaveLength(requests);
        expect(signals).toEqual([]);
      } finally { unregister(); stopSignals(); }
    }, 60_000);

  it.each(["unknown-error", "unrelated-conflict"] as const)(
    "the %s owner failure propagates without a busy retry rewrite", async kind => {
      const endpointId = await createEndpoint(`UNKNOWN${kind}`), before = await setup(endpointId);
      const original = kind === "unknown-error" ? new Error("Synthetic unknown owner failure")
        : conflict("Synthetic different authority failure", { code: "chat_endpoint_runtime_superseded" });
      const requests = cloud.calls.length;
      const unregister = registerSlackCloudEnrollmentOwner(db, async id => { expect(id).toBe(endpointId); throw original; });
      try {
        await expect(reconcilePendingSlackCloudEnrollments(db, new Date())).rejects.toBe(original);
        expect(await setup(endpointId)).toEqual(before);
        expect(cloud.calls).toHaveLength(requests);
      } finally { unregister(); }
    }, 60_000);

  it("an injected retry transaction failure preserves the original busy error and persistence cause", async () => {
    const endpointId = await createEndpoint("RETRYWRITE"), before = await setup(endpointId);
    const busy = conflict("Synthetic owner credential lane is busy", { code: "chat_endpoint_credentials_busy" });
    const writeError = new Error("Synthetic retry transaction unavailable"), requests = cloud.calls.length;
    const unregister = registerSlackCloudEnrollmentOwner(db, async id => { expect(id).toBe(endpointId); throw busy; });
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(writeError);
    try {
      const error = await reconcilePendingSlackCloudEnrollments(db, new Date()).then(() => undefined, error => error);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected retry failure to retain both causes", { cause: error });
      expect(error.errors).toHaveLength(2);
      expect(error.errors[0]).toBe(busy);
      expect(error.errors[1]).toBe(writeError);
      expect(transaction).toHaveBeenCalledOnce();
      expect(await setup(endpointId)).toEqual(before);
      expect(cloud.calls).toHaveLength(requests);
    } finally { transaction.mockRestore(); unregister(); }
  }, 60_000);

  it("public tool removal retains Slack retirement custody through broker outage and ordinary owner recovery", async () => {
    const endpointId = await createEndpoint("TOOLREMOVE"); await confirm(endpointId); await activate(endpointId); await confirm(endpointId);
    const originalEndpoint = await row(endpointId), originalSetup = await setup(endpointId);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, originalEndpoint.connectionId));
    const signingRef = connection!.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret");
    if (!signingRef) throw new Error("Normal Slack configure did not persist its signing credential binding");
    const credentialOwner = { consumerType: "tool_connection" as const, consumerId: connection!.id,
      configPath: "credentials.signingSecret", actorType: "system" as const };
    await expect(secretService(db).resolveSecretValue(companyId, signingRef.secretId, "latest", credentialOwner)).resolves.toBe(secret);
    cloud.setUnavailable(true);
    const requests = vi.mocked(cloud.request).mock.calls.length;
    const tools = toolAccessService(db);
    const removed = await tools.archiveConnection(connection!.id, companyId, { actorType: "user", actorId });
    expect(removed.connection).toMatchObject({ id: connection!.id, status: "archived", enabled: false });
    const archived = await row(endpointId);
    expect(archived.status).toBe("archived");
    const [revoked] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id));
    expect(revoked!.credentialSecretRefs).toEqual([]);
    expect(revoked!.credentialRefs).toEqual([]);
    expect(await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId),
      eq(companySecretBindings.targetType, "tool_connection"), eq(companySecretBindings.targetId, connection!.id)))).toEqual([]);
    await expect(secretService(db).resolveSecretValue(companyId, signingRef.secretId, "latest", credentialOwner)).rejects.toThrow();
    expect(vi.mocked(cloud.request).mock.calls).toHaveLength(requests);
    const intent = (await setup(endpointId)).slackCloudIntent;
    expect(intent).toMatchObject({ version: 1, active: false, companyId, endpointId, connectionId: connection!.id,
      publicId: originalEndpoint.publicId, runtimeGeneration: Number(originalSetup.runtimeGeneration),
      subject: originalSetup.slackCloudSubject, instanceId: originalSetup.slackCloudInstanceId, attempts: 0 });
    expect(JSON.stringify(intent)).not.toContain(secret);
    await tools.archiveConnection(connection!.id, companyId, { actorType: "user", actorId });
    expect((await setup(endpointId)).slackCloudIntent).toEqual(intent);
    const owner = githubConnectionEventService(db, { connector: cloud.connector });
    await expect(owner.pollOnce({ forDelivery: true })).rejects.toMatchObject({ status: 503 });
    const retry = (await setup(endpointId)).slackCloudIntent!;
    expect(retry).toMatchObject({ ...intent, attempts: 1, failureCode: "broker_unavailable", nextAttemptAt: expect.any(String) });
    const retryAt = Date.parse(retry.nextAttemptAt!);
    expect(retryAt).toBeGreaterThan(Date.now());
    cloud.setUnavailable(false); cloud.install();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now())));
    await owner.pollOnce();
    expect((await setup(endpointId)).slackCloudIntent).toBeUndefined();
    expect((await setup(endpointId)).slackCloudRetiredGeneration).toBe(Number(originalSetup.runtimeGeneration));
    expect(cloud.calls.filter(call => call.operation === "slack-events" && call.enrollment?.active === false
      && call.enrollment.endpointId === endpointId)).toHaveLength(1);
    expect(callbacks).toEqual([]);
  }, 60_000);

  it("public tool removal rolls back both archive writes without dropping current Slack custody or credentials", async () => {
    const endpointId = await createEndpoint("TOOLROLLBACK"); await confirm(endpointId); await activate(endpointId); await confirm(endpointId);
    const before = await row(endpointId);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, before.connectionId));
    const failure = new Error("Synthetic removal transaction rollback"), requests = vi.mocked(cloud.request).mock.calls.length;
    const realTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async work => realTransaction(async tx => {
      await work(tx);
      const [archivedEndpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
      const [archivedConnection] = await tx.select().from(toolConnections).where(eq(toolConnections.id, connection!.id));
      expect(archivedEndpoint!.status).toBe("archived");
      expect(archivedConnection).toMatchObject({ status: "archived", enabled: false });
      throw failure;
    }));
    try {
      await expect(toolAccessService(db).archiveConnection(connection!.id, companyId, { actorType: "user", actorId })).rejects.toBe(failure);
      expect(await row(endpointId)).toMatchObject({ status: before.status, setup: before.setup });
      const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id));
      expect(after).toMatchObject({ status: connection!.status, enabled: connection!.enabled,
        credentialSecretRefs: connection!.credentialSecretRefs, credentialRefs: connection!.credentialRefs });
      expect(vi.mocked(cloud.request).mock.calls).toHaveLength(requests);
    } finally { transaction.mockRestore(); }
  }, 60_000);

  it("public tool removal refuses a foreign company before Slack archival or retirement staging", async () => {
    const endpointId = await createEndpoint("TOOLFOREIGN"); await confirm(endpointId);
    const before = await row(endpointId), requests = vi.mocked(cloud.request).mock.calls.length;
    await expect(toolAccessService(db).archiveConnection(before.connectionId, randomUUID(), { actorType: "user", actorId })).rejects.toMatchObject({ status: 404 });
    expect(await row(endpointId)).toEqual(before);
    expect(vi.mocked(cloud.request).mock.calls).toHaveLength(requests);
  }, 60_000);
});
