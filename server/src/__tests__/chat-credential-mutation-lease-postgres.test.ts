import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatEndpointLeases, chatEndpoints, companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { chatCredentialMutationLease } from "../services/chat-credential-mutation-lease.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("chat credential mutation lease locking", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-credential-lease-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Lease test", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const companyId = company.id;
    const [agent] = await db.insert(agents).values({ companyId, name: "Lease worker", role: "engineer", adapterType: "process" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Lease application", type: "custom" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Lease connection", uid: randomUUID(), transport: "rest_api" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID() }).returning();
    return endpoint;
  }

  it("lets a conflicting insert finish while the owner's transaction remains open", async () => {
    const endpoint = await fixture();
    const withLease = chatCredentialMutationLease(db);
    await withLease(endpoint, async lease => {
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        const inserted = await db.transaction(async waiter => {
          await waiter.execute(sql`set local lock_timeout = '200ms'`);
          return waiter.insert(chatEndpointLeases).values({ companyId: endpoint.companyId, endpointId: endpoint.id, leaseKey: "credentials", token: randomUUID(), expiresAt: new Date() }).onConflictDoNothing().returning();
        });
        expect(inserted).toHaveLength(0);
      });
    });
  });

  it("prevents reclaim of an expired lease until the ownership transaction commits", async () => {
    const endpoint = await fixture();
    await chatCredentialMutationLease(db)(endpoint, async lease => {
      await db.update(chatEndpointLeases).set({ expiresAt: new Date(0) }).where(eq(chatEndpointLeases.endpointId, endpoint.id));
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await expect(db.transaction(async waiter => {
          await waiter.execute(sql`set local lock_timeout = '200ms'`);
          return waiter.update(chatEndpointLeases).set({ token: randomUUID() }).where(and(eq(chatEndpointLeases.endpointId, endpoint.id), lte(chatEndpointLeases.expiresAt, new Date()))).returning();
        })).rejects.toMatchObject({ cause: { code: "55P03" } });
      });
    });
  });

  it("rejects a transactional ownership check after another token takes the row", async () => {
    const endpoint = await fixture();
    await expect(chatCredentialMutationLease(db)(endpoint, async lease => {
      await db.update(chatEndpointLeases).set({ token: randomUUID() }).where(eq(chatEndpointLeases.endpointId, endpoint.id));
      await db.transaction(tx => lease.assertOwned(tx));
    })).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
  });

  it("starts a second holder only after the first releases its lease", async () => {
    const endpoint = await fixture();
    const withLease = chatCredentialMutationLease(db);
    const release = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    let secondStarted = false;
    const first = withLease(endpoint, async lease => {
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        acquired.resolve();
        await release.promise;
      });
    });
    await acquired.promise;
    const second = withLease(endpoint, async () => { secondStarted = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(secondStarted).toBe(false);
    } finally {
      release.resolve();
      await first;
      await second;
    }
    expect(secondStarted).toBe(true);
  });

  it("renews the lease when ownership is checked outside a transaction", async () => {
    const endpoint = await fixture();
    await chatCredentialMutationLease(db)(endpoint, async lease => {
      await db.update(chatEndpointLeases).set({ expiresAt: new Date(0) }).where(eq(chatEndpointLeases.endpointId, endpoint.id));
      await lease.assertOwned();
      const [renewed] = await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, endpoint.id));
      expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
