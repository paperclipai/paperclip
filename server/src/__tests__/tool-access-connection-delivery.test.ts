import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionGrants, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions,
  toolApplications, toolConnections, toolPolicies, toolProfiles } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("tool access writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-tool-access-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const tools = (client: typeof db = db) => toolAccessService(client, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
  async function seedDisabledConnection() {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    await db.update(toolConnections).set({ enabled: false, config: { sourceTemplateKey: "sentry", url: "https://mcp.sentry.dev/mcp" } })
      .where(eq(toolConnections.id, f.connection.id));
    return f;
  }
  async function expectRetired(connectionId: string, wakes = true) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    if (wakes) expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }
  async function expectNoDurableEffect() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }

  it.each([
    ["updateConnection", async () => {
      const f = await seedDisabledConnection();
      return { f, produce: () => tools().updateConnection(f.connection.id, { enabled: true }) };
    }],
    ["updateApplication", async () => {
      const f = await seedPendingAccessRequest(db, "owner");
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
      await db.update(toolApplications).set({ status: "disabled" }).where(eq(toolApplications.companyId, f.companyId));
      const [app] = await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId));
      return { f, produce: () => tools().updateApplication(app!.id, { status: "active" }) };
    }],
    ["finishGalleryAppConnection", async () => {
      const f = await seedPendingAccessRequest(db, "owner");
      await db.update(toolConnections).set({ status: "draft", enabled: false }).where(eq(toolConnections.id, f.connection.id));
      return { f, produce: () => tools().finishGalleryAppConnection(f.companyId, f.connection.id, {
        enabledCatalogEntryIds: [f.tool.id], askFirstCatalogEntryIds: [], access: { agentIds: [f.agentId] } }) };
    }],
    ["reconnectGalleryApp", async () => {
      const f = await seedPendingAccessRequest(db, "owner");
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
      await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.connectionId, f.connection.id));
      const offline = toolAccessService(db, { remoteHttpRequest: async () => { throw new Error("offline"); } });
      return { f, produce: () => offline.reconnectGalleryApp(f.connection.id, f.companyId,
        { credentialValues: { "credentials.authorization": "new-key" } }, { actorType: "user", actorId: "owner" }).catch(() => undefined), wakes: false };
    }],
  ] as const)("retires an exact access request through %s before any maintenance tick", async (_name, arrange) => {
    const { f, produce, wakes } = { wakes: true, ...(await arrange()) };
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await produce();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id, wakes);
  });

  it("notifies on application and connection CRUD writes that cannot satisfy the card", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    for (const produce of [
      async () => { const [zapier] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: f.connection.applicationId, name: "Zapier", uid: "zapier", transport: "mcp_remote",
        status: "draft", config: { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", url: "https://mcp.zapier.com/mcp", mcpPreserveAccess: true } }).returning();
        await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: `app:${zapier!.id}`, name: "Zapier", defaultAction: "deny", status: "active" });
        await tools().finishGalleryAppConnection(f.companyId, zapier!.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" }); },
      async () => { const [chat] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: f.connection.applicationId, name: "Chat", uid: "chat",
        transport: "chat_sdk", connectionPurpose: "channel", config: {} }).returning(); await tools().updateConnection(chat!.id, { name: "Renamed chat" }); },
      () => tools().createApplication(f.companyId, { name: "Other", type: "mcp_http" }),
      async () => { const [app] = await db.select().from(toolApplications).where(eq(toolApplications.name, "Other")); await tools().deleteApplication(app!.id); },
      () => tools().createConnection(f.companyId, { name: "Second", applicationName: "Second app", transport: "mcp_remote", config: { url: "https://mcp.example.test/mcp" } }),
      () => tools().updateConnection(f.connection.id, { name: "Renamed Sentry" }),
      () => tools().updateApplication(f.connection.applicationId, { status: "disabled" }),
    ]) {
      const baseline = delivery.sweeps;
      await produce();
      await delivery.settle(baseline + 1);
    }
    await expectNoDurableEffect();
  });

  it("registers the notification before the connection write it guards", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    let release: (() => void) | undefined;
    const holder = db.transaction(async tx => { await tx.execute(sql`lock table tool_connections in exclusive mode`); await new Promise<void>(resolve => { release = resolve; }); });
    await expect.poll(() => release).toBeDefined();
    const baseline = delivery.sweeps;
    const updating = tools().updateConnection(f.connection.id, { enabled: true });
    try {
      await expect.poll(async () => (await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock'
        and query ilike '%update "tool_connections"%'`)).length, { timeout: 10_000 }).toBe(1);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
    } finally { release!(); await Promise.allSettled([holder, updating]); }
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("leaves a raw connection write without a notification to the worker until something wakes it", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("keeps the card pending with no durable effect when the connection write rolls back", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async (tx) => {
      await tools(tx as unknown as typeof db).updateConnection(f.connection.id, { enabled: true });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle(baseline + 1);
    await expectNoDurableEffect();
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.enabled).toBe(false);
  });

  it("publishes a savepoint notification only when the outer transaction commits", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(async (tx) => {
      await tools(tx as unknown as typeof db).updateConnection(f.connection.id, { enabled: true });
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(delivery!.sweeps).toBe(baseline);
    });
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("rechecks writes that commit while a sweep waits before its read", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    for (const enabled of [false, true]) {
      let release!: () => void, locked!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<void>(resolve => { locked = resolve; });
      const holder = db.transaction(async tx => { await tx.execute(sql`lock table issue_thread_interactions in access exclusive mode`); locked(); await gate; });
      await held;
      const baseline = delivery.sweeps;
      try {
        delivery.wake();
        await expect.poll(() => delivery!.sweeps).toBeGreaterThan(baseline);
        await tools().updateConnection(f.connection.id, { enabled: true });
        if (!enabled) await tools().updateConnection(f.connection.id, { enabled: false });
      } finally { release(); await holder; }
      await delivery.settle(baseline + 2);
      expect((await card()).status).toBe(enabled ? "expired" : "pending");
    }
    await expectRetired(f.connection.id);
  });

  it("retires once through duplicate back-to-back writes", async () => {
    const f = await seedDisabledConnection();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await Promise.all([tools().updateConnection(f.connection.id, { enabled: true }), tools().updateConnection(f.connection.id, { enabled: true })]);
    await tools().updateConnection(f.connection.id, { enabled: true });
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("waits for admission to reopen before retiring", async () => {
    const f = await seedDisabledConnection();
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    open = false;
    await tools().updateConnection(f.connection.id, { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await card()).status).toBe("pending");
    open = true;
    const baseline = delivery.sweeps;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });
});
