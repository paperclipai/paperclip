import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions, toolApplications, toolConnections, toolPolicies } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const actor = { actorType: "user" as const, actorId: "owner" };
const link = "https://mcp.fixture.test/mcp";

describePostgres("connectGalleryApp writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-gallery-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function seedLinkConnection(status: "active" | "draft") {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    await db.update(toolApplications).set({ metadata: { source: "link" } }).where(eq(toolApplications.companyId, f.companyId));
    await db.update(toolConnections).set({ authKind: "none", status, enabled: status === "active", config: { url: link }, transportConfig: { url: link } })
      .where(eq(toolConnections.id, f.connection.id));
    const [intent] = await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, serviceSlug: `connection:${f.connection.id}` } })
      .where(eq(issueThreadInteractions.id, f.intent.id)).returning();
    return { ...f, intent: intent! };
  }
  type Seed = Awaited<ReturnType<typeof seedLinkConnection>>;
  function reconnectFailingAtCatalogRefresh(client: typeof db, f: Seed, onRefresh: () => Promise<void>) {
    let checks = 0;
    const reauthorize = async () => { if (++checks > 2) { await onRefresh(); throw new Error("authority revoked"); } };
    return toolAccessService(client, { deploymentMode: "local_trusted", deploymentExposure: "private",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({ id: body.id, jsonrpc: "2.0", result: body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {} } : { tools: [{ name: "sentry-read", inputSchema: { type: "object" } }] } });
      },
    }).connectGalleryApp(f.companyId, { link, authMode: "none", grantKind: "user", reconnectConnectionId: f.connection.id },
      { ...actor, managementContext: { reauthorize } as never });
  }

  it("retires an exact access request through the failure-path identity restore before any maintenance tick", async () => {
    const f = await seedLinkConnection("active");
    await db.delete(issueThreadInteractions);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(reconnectFailingAtCatalogRefresh(db, f, async () => {
      await delivery!.settle(baseline + 1);
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.status).toBe("draft");
      await db.insert(issueThreadInteractions).values(f.intent);
      delivery!.wake();
      await delivery!.settle(baseline + 2);
      expect((await card()).status).toBe("pending");
    })).rejects.toThrow("authority revoked");
    await delivery.settle(baseline + 3);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
    const beforeRepeat = delivery.sweeps;
    await expect(reconnectFailingAtCatalogRefresh(db, f, async () => undefined)).rejects.toThrow("authority revoked");
    await delivery.settle(beforeRepeat + 1);
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it.each(["commit", "rollback"] as const)("publishes the savepoint notifications only when the caller transaction ends (%s)", async (outcome) => {
    const f = await seedLinkConnection("draft");
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    const result = db.transaction(async (tx) => {
      await tx.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, f.connection.id));
      await expect(reconnectFailingAtCatalogRefresh(tx as unknown as typeof db, f, async () => undefined)).rejects.toThrow("authority revoked");
      expect((await tx.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.status).toBe("active");
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(delivery!.sweeps).toBe(baseline);
      if (outcome === "rollback") throw new Error("rollback");
    });
    if (outcome === "rollback") await expect(result).rejects.toThrow("rollback");
    else await result;
    await delivery.settle(baseline + 1);
    if (outcome === "commit") {
      expect((await card()).status).toBe("expired");
      expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
      expect(delivery.wakeup).toHaveBeenCalledOnce();
      return;
    }
    expect((await card()).status).toBe("pending");
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.status).toBe("draft");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });

  it("leaves a raw connection restore without a notification to the worker until something wakes it", async () => {
    const f = await seedLinkConnection("draft");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
  });

  it("does not retire during admission drain and retires after reopening", async () => {
    const f = await seedLinkConnection("active");
    let open = true;
    await db.delete(issueThreadInteractions);
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    const baseline = delivery.sweeps;
    await expect(reconnectFailingAtCatalogRefresh(db, f, async () => {
      await delivery!.settle(baseline + 1);
      open = false;
      await db.insert(issueThreadInteractions).values(f.intent);
    })).rejects.toThrow("authority revoked");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline + 1);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 2);
    expect((await card()).status).toBe("expired");
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  async function holdSweepBeforeRead() {
    const blocker = createDb(temp.connectionString);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const done = new Promise<void>(resolve => { release = resolve; });
    const held = blocker.transaction(async (tx) => {
      await tx.execute(sql`lock table issue_thread_interactions in access exclusive mode`);
      locked();
      await done;
    }).finally(() => blocker.$client.end({ timeout: 1 }));
    await ready;
    const started = delivery!.sweeps;
    delivery!.wake();
    while (delivery!.sweeps === started) await new Promise(resolve => setTimeout(resolve, 10));
    return async () => { release(); await held; };
  }

  it("retires once when the restore commits while a started sweep is held before its read", async () => {
    const f = await seedLinkConnection("active");
    await db.delete(issueThreadInteractions);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    let releaseSweep!: () => Promise<void>;
    await expect(reconnectFailingAtCatalogRefresh(db, f, async () => {
      await delivery!.settle(baseline + 1);
      await db.insert(issueThreadInteractions).values(f.intent);
      releaseSweep = await holdSweepBeforeRead();
    })).rejects.toThrow("authority revoked");
    await releaseSweep();
    await delivery.settle(baseline + 3);
    expect((await card()).status).toBe("expired");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it("keeps the card pending when access widens and then narrows while a started sweep is held", async () => {
    const f = await seedLinkConnection("draft");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const releaseSweep = await holdSweepBeforeRead();
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await expect(reconnectFailingAtCatalogRefresh(db, f, async () => {
      await releaseSweep();
      await delivery!.settle(baseline + 2);
      expect((await card()).status).toBe("pending");
      expect(delivery!.wakeup).not.toHaveBeenCalled();
    })).rejects.toThrow("authority revoked");
  });
});
