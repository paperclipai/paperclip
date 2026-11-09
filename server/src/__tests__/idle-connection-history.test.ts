import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, chatEndpoints, chatSlackRegistrations, companies, connectionEventDeliveries, connectionGrants, connectionIntentDeliveries,
  createDb, environmentLeases, environments, heartbeatRuns, issues, issueThreadInteractions, toolApplications, toolConnections,
} from "@paperclipai/db";
import { beginIdleTrackedWork } from "../services/task-admission.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const now = Date.UTC(2020, 0, 1); const ownerId = randomUUID();
const owned = (): IdleSleepDrainStatus => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const none = { version: 1, backgroundWork: "none" }; const present = { version: 1, backgroundWork: "present" };
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping connection-history database tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("idle connection and local lease history", () => {
  let db: ReturnType<typeof createDb>; let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("idle-connection-history-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const read = () => readIdleSleepSafety(db, owned, () => now, ownerId, async () => "none", undefined, undefined, true, true);
  async function seed(status = "done") {
    const companyId = randomUUID(); const agentId = randomUUID(); const runId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connection history fixture", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idle owner", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fixture", status, assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", finishedAt: new Date(now) });
    return { companyId, agentId, runId, issueId };
  }
  async function delivery(f: Awaited<ReturnType<typeof seed>>, deliveredAt: Date | null = new Date(now)) {
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "connection_intent", status: "expired", resolvedAt: new Date(now), sourceRunId: f.runId,
      payload: { requestingAgentId: f.agentId }, result: { version: 1, outcome: "expired", connectionId: randomUUID() } }).returning();
    const [outbox] = await db.insert(connectionIntentDeliveries).values({ companyId: f.companyId, interactionId: card!.id, deliveredAt }).returning();
    return { card: card!, outbox: outbox! };
  }
  it("retains processed event history while allowing sleep", async () => {
    const f = await seed();
    const [event] = await db.insert(connectionEventDeliveries).values({ companyId: f.companyId, provider: "github", providerDeliveryId: randomUUID(), event: "push", status: "processed", processedAt: new Date(now) }).returning();
    expect(await read()).toEqual(none); expect(await db.select().from(connectionEventDeliveries)).toEqual([event]);
  });
  it.each(["received", "failed", "missing_receipt"])("retains %s event work", async state => {
    const f = await seed();
    await db.insert(connectionEventDeliveries).values({ companyId: f.companyId, provider: "github", providerDeliveryId: randomUUID(), event: "push", status: state === "missing_receipt" ? "processed" : state as "received" | "failed", processedAt: state === "missing_receipt" ? null : new Date(now) });
    expect(await read()).toEqual(present);
  });
  it("keeps downstream work awake after event application finishes", async () => {
    const f = await seed(); await db.insert(connectionEventDeliveries).values({ companyId: f.companyId, provider: "github", providerDeliveryId: randomUUID(), event: "push", status: "processed", processedAt: new Date(now) });
    await db.update(heartbeatRuns).set({ status: "queued", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(present);
  });
  it("permits a delivered no-op without deleting its outbox receipt", async () => {
    const d = await delivery(await seed()); expect(await read()).toEqual(none);
    expect(await db.select().from(connectionIntentDeliveries)).toEqual([d.outbox]);
  });
  it.each(["pending", "unfinished_wake", "queued_wake", "coalesced_unfinished"])("retains %s connection delivery work", async state => {
    const f = await seed(); const d = await delivery(f, state === "pending" ? null : new Date(now));
    if (state !== "pending") await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      idempotencyKey: `connection-intent:${d.card.id}:expired`, status: state === "queued_wake" ? "queued" : state === "coalesced_unfinished" ? "coalesced" : "completed",
      finishedAt: state === "coalesced_unfinished" ? new Date(now) : null });
    expect(await read()).toEqual(present);
  });
  it.each(["completed", "coalesced"])("permits a delivered connection after its exact %s wake finishes", async status => {
    const f = await seed(); const d = await delivery(f);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation", status, runId: f.runId,
      idempotencyKey: `connection-intent:${d.card.id}:expired`, finishedAt: new Date(now) });
    expect(await read()).toEqual(none);
  });
  it("parks an undelivered system retirement behind its still-pending response without marking delivery complete", async () => {
    const f = await seed("in_review"); const d = await delivery(f, null);
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending",
      effectiveResolverPolicy: "human_only", sourceRunId: f.runId, payload: {} }).returning();
    expect(await read()).toEqual(none);
    const worker = connectionIntentDeliveryService(db, { wakeup: async () => null });
    expect(await worker.hasPending()).toBe(false);
    expect(worker.nextRunAt()).toBeTypeOf("number");
    await worker.sweepPending();
    expect(await db.select().from(connectionIntentDeliveries)).toEqual([d.outbox]);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date(now) }).where(eq(issueThreadInteractions.id, question!.id));
    expect(await worker.hasPending()).toBe(true);
    expect(worker.nextRunAt()).toBeNull();
    expect(await read()).toEqual(present);
  });
  async function connection(f: Awaited<ReturnType<typeof seed>>, change: Partial<typeof toolConnections.$inferInsert> = {}) {
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Outbound tool fixture", type: "mcp_http" }).returning();
    const [c] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app!.id, uid: randomUUID(), name: "Saved remote tools",
      connectionPurpose: "tool", transport: "mcp_remote", status: "active", enabled: true, ...change }).returning(); return c!;
  }
  it("allows saved outbound MCP configuration while preserving active-call admission", async () => {
    const c = await connection(await seed()); expect(await read()).toEqual(none);
    const finish = beginIdleTrackedWork(); try { expect(await read()).toEqual({ version: 1, backgroundWork: "unknown" }); } finally { finish(); }
    expect(await db.select().from(toolConnections)).toEqual([c]);
  });
  it("retains inbound GitHub bindings until their own wake contract is supported", async () => {
    const f = await seed(); const c = await connection(f);
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: c.id, kind: "organization", providerTenant: { github: {
      userId: "fixture", login: "fixture", installationCount: 1, repositoryCount: 1, repositorySelection: "all", installationIds: ["fixture"], installationOwnerLogins: ["fixture"],
    } } }); expect(await read()).toEqual(present);
  });
  it.each(["tool", "channel", "ai"] as const)("permits an inert disabled %s draft", async purpose => {
    await connection(await seed(), { connectionPurpose: purpose, transport: purpose === "channel" ? "chat_sdk" : purpose === "ai" ? "runtime_auth" : "mcp_remote", status: "draft", enabled: false });
    expect(await read()).toEqual(none);
  });
  it.each(["local_stdio", "rest_api"] as const)("retains unsupported active %s integrations", async transport => {
    await connection(await seed(), { transport }); expect(await read()).toEqual(present);
  });
  async function slackDraft(command?: string) {
    const f = await seed(); const c = await connection(f, { connectionPurpose: "channel", transport: "chat_sdk", status: "draft", enabled: false });
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: c.id,
      assignedAgentId: f.agentId, publicId: randomUUID(), provider: "slack",
      setup: { step: "provider_setup", ...(command ? { command } : {}) } }).returning();
    return { ...f, connection: c, endpoint: endpoint! };
  }
  it.each([undefined, "/paperclip-fixture"])("permits an unconfigured disabled Slack draft without losing setup state (%s)", async command => {
    const f = await slackDraft(command); expect(await read()).toEqual(none);
    expect(await db.select().from(chatEndpoints)).toEqual([f.endpoint]);
  });
  it.each(["active", "provider_identity", "previous_activity", "connected_step", "health", "unsupported_provider", "enabled_connection", "setup_in_progress", "registration", "unknown_command_shape"])("retains draft integration with %s", async mode => {
    const f = await slackDraft();
    if (mode === "active") await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "provider_identity") await db.update(chatEndpoints).set({ botExternalId: "fixture-bot" }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "previous_activity") await db.update(chatEndpoints).set({ lastEventAt: new Date(now) }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "connected_step") await db.update(chatEndpoints).set({ setup: { step: "test" } }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "health") await db.update(chatEndpoints).set({ healthMessage: "Provider setup pending" }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "unsupported_provider") await db.update(chatEndpoints).set({ provider: "discord" }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "enabled_connection") await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connection.id));
    if (mode === "setup_in_progress") await db.update(chatEndpoints).set({ setup: { step: "provider_setup", slackSetupMethod: "managed" } }).where(eq(chatEndpoints.id, f.endpoint.id));
    if (mode === "registration") await db.insert(chatSlackRegistrations).values({ endpointId: f.endpoint.id, companyId: f.companyId,
      requestId: randomUUID(), status: "creating", manifest: {}, manifestHash: "fixture-hash", callbackUri: "https://example.test/callback", createdByUserId: "fixture-user" });
    if (mode === "unknown_command_shape") await db.update(chatEndpoints).set({ setup: sql`'{"step":"provider_setup","command":42}'::jsonb` }).where(eq(chatEndpoints.id, f.endpoint.id));
    expect(await read()).toEqual(present);
  });
  async function localLease() {
    const f = await seed(); const [environment] = await db.insert(environments).values({ name: "Local fixture", driver: "local" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment!.id, heartbeatRunId: f.runId,
      status: "failed", leasePolicy: "ephemeral", provider: "local", providerLeaseId: null, releasedAt: new Date(now), metadata: { driver: "local" } }).returning();
    return { ...f, lease: lease!, environment: environment! };
  }
  it("permits released local bookkeeping after the owning run finishes", async () => {
    const f = await localLease(); expect(await read()).toEqual(none);
    expect(await db.select().from(environmentLeases)).toEqual([f.lease]);
  });
  it.each(["provider_resource", "missing_release", "live_run", "unknown_driver", "pending_export", "retained"])("retains local lease work with %s evidence", async kind => {
    const f = await localLease();
    if (kind === "provider_resource") await db.update(environmentLeases).set({ providerLeaseId: "unexpected-resource" }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "missing_release") await db.update(environmentLeases).set({ releasedAt: null }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "live_run") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "unknown_driver") await db.update(environments).set({ driver: "ssh" }).where(eq(environments.id, f.environment.id));
    if (kind === "pending_export") await db.update(environmentLeases).set({ metadata: { driver: "local", nativeWorkspaceExportResume: {} } }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "retained") await db.update(environmentLeases).set({ leasePolicy: "retain_on_failure" }).where(eq(environmentLeases.id, f.lease.id));
    expect(await read()).toEqual(present);
  });
});
