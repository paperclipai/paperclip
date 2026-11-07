import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { chatActions, chatDeliveries, chatEndpoints, createDb, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { createChatConversationDeliveryQueue } from "../services/chat-channels/inbound/conversation-queue.js";
import { pendingInboundWakeupCondition } from "../services/chat-channels/inbound/delivery-ledger.js";
import { captureInboundQuery, pendingIds, queueOptions, runQuery, seedInboundDiscovery } from "./helpers/inbound-discovery-fixture.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("inbound-discovery-test-"); db = createDb(database.connectionString); });
afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

describe("inbound queue discovery", () => {
  it("keeps scoped pending ownership without multiplying deliveries for duplicate or null actions", async () => {
    const f = await seedInboundDiscovery(db);
    const other = await seedInboundDiscovery(db, 0);
    const unowned = await f.delivery({ state: "processed" });
    const duplicate = await f.delivery({ state: "processed" });
    await f.action(duplicate.id); await f.action(duplicate.id);
    await f.action(null);
    await f.action(unowned.id, { endpointId: await f.anotherEndpoint() });
    await f.action(unowned.id, { kind: "other" });
    await f.action(unowned.id, { status: "processed" });
    const oracle = sql`exists (select 1 from chat_actions a where a.delivery_id = chat_deliveries.id and a.endpoint_id = chat_deliveries.endpoint_id and a.company_id = chat_deliveries.company_id and a.kind = 'inbound_wakeup' and a.status in ('issued', 'processing'))`;
    const booleans = await db.select({ pending: pendingInboundWakeupCondition(), oracle }).from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId));
    expect(booleans.every(row => typeof row.pending === "boolean" && row.pending === row.oracle)).toBe(true);
    expect(await pendingIds(db, pendingInboundWakeupCondition(), f.companyId)).toEqual(await pendingIds(db, oracle, f.companyId));
    expect((await pendingIds(db, pendingInboundWakeupCondition(), f.companyId)).map(row => row.id).sort()).toEqual([f.pending.id, duplicate.id].sort());
  });

  it("preserves scoped ready-head probes with unrelated malformed retry data", async () => {
    const f = await seedInboundDiscovery(db);
    const other = await seedInboundDiscovery(db, 0);
    const unrelated = await f.delivery({ state: "filtered" });
    const oracle = sql`exists (select 1 from chat_actions a where a.delivery_id = chat_deliveries.id and a.endpoint_id = chat_deliveries.endpoint_id and a.company_id = chat_deliveries.company_id and a.kind = 'inbound_wakeup' and a.status in ('issued', 'processing') and ((a.status = 'issued' and (a.result->>'retryAt' is null or (a.result->>'retryAt')::timestamptz <= now())) or (a.status = 'processing' and a.updated_at <= ${new Date(Date.now() - 60_000).toISOString()}::timestamptz)))`;
    for (const input of [
      { companyId: f.companyId, endpointId: f.endpointId, deliveryId: unrelated.id },
      { companyId: other.companyId, endpointId: other.endpointId, deliveryId: other.pending.id },
      { companyId: f.companyId, endpointId: f.endpointId, deliveryId: null },
    ]) {
      const [action] = await db.insert(chatActions).values({ ...input, kind: "inbound_wakeup", providerActionId: randomUUID(), status: "issued", result: { retryAt: "invalid timestamp" } }).returning();
      try {
        expect(await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(and(eq(chatDeliveries.id, f.pending.id), oracle))).toEqual([]);
        expect(await db.select({ id: chatDeliveries.id }).from(chatDeliveries).where(and(eq(chatDeliveries.id, f.pending.id), pendingInboundWakeupCondition(true)))).toEqual([]);
      } finally { await db.delete(chatActions).where(eq(chatActions.id, action!.id)); }
    }
  });

  it("keeps a future wake at the conversation head and reactions independent", async () => {
    const f = await seedInboundDiscovery(db);
    const queue = createChatConversationDeliveryQueue(db, queueOptions());
    await db.update(chatEndpoints).set({ status: "paused" });
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await queue.nextInboundDeliveryAt()).toBe(Date.parse("2099-01-01T12:00:00.000Z"));
    await f.delivery({ eventKind: "reaction_added", state: "retry", nextAttemptAt: new Date("2090-01-01T00:00:00Z") });
    expect(await queue.nextInboundDeliveryAt()).toBe(Date.parse("2090-01-01T00:00:00Z"));
    await db.update(chatEndpoints).set({ status: "attention" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await queue.nextInboundDeliveryAt()).toBeNull();
    await f.delivery({ eventKind: "installation", state: "retry", nextAttemptAt: new Date("2095-01-01T00:00:00Z"), normalizedEvent: {
      lifecycle: { provider: "slack", providerEventId: randomUUID(), kind: "endpoint", availability: "available", reason: "Recovered" } } });
    expect(await queue.nextInboundDeliveryAt()).toBe(Date.parse("2095-01-01T00:00:00Z"));
    await db.update(chatEndpoints).set({ provider: "agentmail", publicationMode: "explicit", externalExecutionPolicy: "agent" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await queue.nextInboundDeliveryAt()).toBeNull();
  });

  it("preserves ready wake retry and processing deadlines and complete real selection rows", async () => {
    const f = await seedInboundDiscovery(db, 30, 4096);
    const ready = await f.delivery({ state: "processed", normalizedEvent: { conversation: { externalThreadId: "slack:ready" }, message: { text: "complete payload", providerMessageSequence: "not-numeric", providerMessageId: "12", providerUpdateId: "4" } } });
    await f.action(ready.id, { result: { retryAt: "2020-01-01T00:00:00Z" } });
    const stale = await f.delivery({ state: "processed" });
    await f.action(stale.id, { status: "processing", updatedAt: new Date("2020-01-01T00:00:00Z") });
    const live = await f.delivery({ state: "processed" });
    await f.action(live.id, { status: "processing", updatedAt: new Date("2099-01-01T00:00:00Z") });
    const query = await captureInboundQuery(db, f, "ready");
    const rows = await runQuery(db, query);
    const ids = rows.map(row => row[0]);
    expect(ids).toContain(ready.id); expect(ids).toContain(stale.id);
    expect(ids).not.toContain(live.id); expect(ids).not.toContain(f.pending.id);
    const returned = rows.find(row => row[0] === ready.id)!;
    const normalizedEventIndex = Object.keys(getTableColumns(chatDeliveries)).indexOf("normalizedEvent");
    expect(returned[normalizedEventIndex]).toEqual(ready.normalizedEvent);
  });

  it("keeps provider sequence and final receipt ties for the actual head query", async () => {
    const f = await seedInboundDiscovery(db);
    await db.update(chatActions).set({ status: "processed" }).where(eq(chatActions.companyId, f.companyId));
    await db.update(chatDeliveries).set({ state: "filtered" }).where(eq(chatDeliveries.companyId, f.companyId));
    const later = await f.delivery({ normalizedEvent: { conversation: { externalThreadId: f.threadId }, message: { providerSentAt: "2026-01-01T12:00:00Z", providerMessageSequence: "10" } } });
    const first = await f.delivery({ normalizedEvent: { conversation: { externalThreadId: f.threadId }, message: { providerSentAt: "2026-01-01T12:00:00Z", providerMessageSequence: "2" } } });
    const rows = await runQuery(db, await captureInboundQuery(db, f, "head"));
    expect(rows).toHaveLength(1); expect(rows[0]?.[0]).toBe(first.id); expect(rows[0]?.[0]).not.toBe(later.id);
    await db.update(chatDeliveries).set({ nextAttemptAt: new Date("2099-01-01T12:00:00Z"), state: "retry" }).where(eq(chatDeliveries.id, first.id));
    expect((await runQuery(db, await captureInboundQuery(db, f, "head")))[0]?.[0]).toBe(first.id);
  });
});
