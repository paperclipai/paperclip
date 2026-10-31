import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, issueThreadInteractions, toolApplications, toolConnections, toolPolicies } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
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
  // Setup and the health check pass; setup then fails when catalog refresh re-checks the caller's authority, before any refresh write.
  function reconnect(client: typeof db, f: Seed, onRefresh: () => Promise<void>) {
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
    await expect(reconnect(db, f, async () => {
      // The revive write left the connection in draft and notified; a card raised now is not yet satisfiable.
      await delivery!.settle(baseline + 1);
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.status).toBe("draft");
      await db.insert(issueThreadInteractions).values(f.intent);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await card()).status).toBe("pending");
    })).rejects.toThrow("authority revoked");
    // At least one more sweep: the restore transaction's own notification.
    await delivery.settle(baseline + 2);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
    const beforeRepeat = delivery.sweeps;
    await expect(reconnect(db, f, async () => undefined)).rejects.toThrow("authority revoked");
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
      await expect(reconnect(tx as unknown as typeof db, f, async () => undefined)).rejects.toThrow("authority revoked");
      expect((await tx.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]!.status).toBe("active");
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
});
