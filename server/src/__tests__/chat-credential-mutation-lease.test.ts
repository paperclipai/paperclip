import { randomUUID } from "node:crypto";
import { eq, lte, and, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatEndpointLeases, chatEndpoints, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { chatCredentialMutationLease } from "../services/chat-credential-mutation-lease.js";

describe("chat credential mutation lease transaction ownership", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("credential-lease-");
    db = createDb(temporary.connectionString);
    fixtures = createChatMilestoneFixtures(db);
  }, 120_000);
  afterEach(async () => { await fixtures.cleanup(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function endpoint() {
    const f = await fixtures.create();
    const [row] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    return row;
  }

  it("lets a waiter's conflicting insert return while the owner transaction is open", async () => {
    const row = await endpoint();
    await chatCredentialMutationLease(db)(row, lease => db.transaction(async tx => {
      await lease.assertOwned(tx);
      const inserted = await db.transaction(async waiter => {
        await waiter.execute(sql`set local lock_timeout = '200ms'`);
        return waiter.insert(chatEndpointLeases).values({ companyId: row.companyId, endpointId: row.id,
          leaseKey: "credentials", token: randomUUID(), expiresAt: new Date(Date.now() + 90_000),
        }).onConflictDoNothing().returning({ id: chatEndpointLeases.id });
      });
      expect(inserted).toEqual([]);
    }));
  });

  it("prevents reclaim of an expired lease until the ownership transaction commits", async () => {
    const row = await endpoint();
    await chatCredentialMutationLease(db)(row, async lease => {
      await db.update(chatEndpointLeases).set({ expiresAt: new Date(0) }).where(eq(chatEndpointLeases.endpointId, row.id));
      const reclaim = () => db.transaction(async waiter => {
        await waiter.execute(sql`set local lock_timeout = '200ms'`);
        return waiter.update(chatEndpointLeases).set({ token: randomUUID() }).where(and(
          eq(chatEndpointLeases.endpointId, row.id), lte(chatEndpointLeases.expiresAt, new Date()),
        )).returning({ id: chatEndpointLeases.id });
      });
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await expect(reclaim()).rejects.toMatchObject({ cause: { code: "55P03" } });
      });
      expect(await reclaim()).toHaveLength(1);
    }).catch(error => {
      expect(error).toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
    });
  });

  it("rejects transaction ownership after another token takes the row", async () => {
    const row = await endpoint();
    await expect(chatCredentialMutationLease(db)(row, async lease => {
      await db.update(chatEndpointLeases).set({ token: randomUUID() }).where(eq(chatEndpointLeases.endpointId, row.id));
      await db.transaction(tx => lease.assertOwned(tx));
    })).rejects.toMatchObject({ code: "CHAT_CREDENTIAL_LEASE_LOST" });
    await db.delete(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, row.id));
  });

  it("runs the next holder only after the current holder releases", async () => {
    const row = await endpoint();
    const withLease = chatCredentialMutationLease(db);
    const events: string[] = [];
    let next: Promise<void> | undefined;
    await withLease(row, lease => db.transaction(async tx => {
      await lease.assertOwned(tx);
      next = withLease(row, async () => { events.push("next"); });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events).toEqual([]);
      events.push("first");
    }));
    await next;
    expect(events).toEqual(["first", "next"]);
  });

  it("continues to renew ownership checks outside a transaction", async () => {
    const row = await endpoint();
    await chatCredentialMutationLease(db)(row, async lease => {
      for (const database of [undefined, db]) {
        await db.update(chatEndpointLeases).set({ expiresAt: new Date(0) }).where(eq(chatEndpointLeases.endpointId, row.id));
        const before = Date.now();
        await lease.assertOwned(database);
        const [renewed] = await db.select().from(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, row.id));
        expect(renewed.expiresAt.getTime()).toBeGreaterThan(before);
      }
    });
  });
});
