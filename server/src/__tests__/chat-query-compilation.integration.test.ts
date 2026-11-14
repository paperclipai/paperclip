import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, chatActions, chatEndpoints, issues, toolApplications, toolConnections,
  closeRegisteredClients,
  createDb, getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createChatQueryExecutor } from "../services/chat-query-executor.js";
import { chatChannelService } from "../services/chat-channels.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("chat query compilation with PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const fixtureCompanies = new Set<string>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-chat-query-reuse-");
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    const ids = [...fixtureCompanies];
    fixtureCompanies.clear();
    if (ids.length) {
      const db = createDb(database.connectionString);
      await db.delete(chatEndpoints).where(inArray(chatEndpoints.companyId, ids));
      await db.delete(issues).where(inArray(issues.companyId, ids));
      await db.delete(agents).where(inArray(agents.companyId, ids));
      await db.delete(toolConnections).where(inArray(toolConnections.companyId, ids));
      await db.delete(toolApplications).where(inArray(toolApplications.companyId, ids));
      await db.delete(companies).where(inArray(companies.id, ids));
    }
    await closeRegisteredClients(database.connectionString);
  });

  it.each([false, true])("executes fresh empty candidates while bounding compilation with reuse=%s", async (reuse) => {
    const db = createDb(database.connectionString);
    type Executable = { execute: (...args: unknown[]) => Promise<unknown> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    let executions = 0;
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args), execute = prepared.execute.bind(prepared);
      prepared.execute = (...parameters) => { executions += 1; return execute(...parameters); };
      return prepared;
    });
    const fetch = vi.fn(async () => { throw new Error("Empty candidates must not contact a provider"); });
    const service = chatChannelService(db, { idleOptimizations: reuse, heartbeat: { wakeup: vi.fn(async () => null) }, fetch });
    const scan = async () => {
      expect(await service.processPendingReceiptReactions()).toBe(0);
      expect(await service.processPendingTelegramActions()).toBe(0);
    };
    try {
      await scan();
      const compilations = observer.mock.calls.length, reads = executions;
      expect(reads).toBeGreaterThan(0);
      for (let tick = 0; tick < 4; tick += 1) await scan();
      expect(executions).toBe(reads * 5);
      expect(observer.mock.calls.length).toBe(compilations * (reuse ? 1 : 5));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      observer.mockRestore();
      await service.shutdown();
    }
  });

  it.each([false, true])("reads a newly committed Telegram candidate after an empty pass with reuse=%s", async (reuse) => {
    const db = createDb(database.connectionString), fixture = await endpointFixture(db, false);
    const service = chatChannelService(db, { idleOptimizations: reuse, heartbeat: { wakeup: vi.fn(async () => null) } });
    try {
      expect(await service.processPendingTelegramActions()).toBe(0);
      // An invalid payload is selected but never authorizes a provider call.
      await db.insert(chatActions).values({ ...fixture, kind: "telegram_maintenance", providerActionId: randomUUID(), payload: { operation: "invalid" }, status: "received" });
      expect(await service.processPendingTelegramActions()).toBe(1);
    } finally { await service.shutdown(); }
  });

  async function endpointFixture(db: ReturnType<typeof createDb>, archived: boolean) {
    const companyId = randomUUID();
    fixtureCompanies.add(companyId);
    const agentId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scan fixture", issuePrefix: "Q" + companyId.slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idle", role: "engineer" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Chat fixture", type: "chat" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "Chat fixture", uid: connectionId,
      transport: "chat_sdk", connectionPurpose: "channel", status: "active", enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
      assignedAgentId: agentId, status: archived ? "archived" : "active",
    });
    return { companyId, endpointId };
  }

  it.each([false, true])("sees due receipts and honors the record filter with reuse=%s", async (reuse) => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, false);
    const actionId = randomUUID();
    const otherId = randomUUID();
    const clock = Date.now();
    const providerFetch = vi.fn(async () => { throw new Error("Invalid fixture payload must not reach a provider"); });
    const service = chatChannelService(db, { idleOptimizations: reuse, heartbeat: { wakeup: vi.fn(async () => null) }, fetch: providerFetch });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    try {
      expect(await service.processPendingReceiptReactions(1, actionId)).toBe(0);
      await db.insert(chatActions).values([
        { id: actionId, ...fixture, kind: "receipt_reaction", providerActionId: actionId, status: "failed", result: { retryable: true, retryAt: new Date(clock + 1000).toISOString() } },
        { id: otherId, ...fixture, kind: "receipt_reaction", providerActionId: otherId, status: "received" },
      ]);
      expect(await service.processPendingReceiptReactions(1, actionId)).toBe(0);
      vi.setSystemTime(clock + 1001);
      expect(await service.processPendingReceiptReactions(1, actionId)).toBe(1);
      const [other] = await db.select().from(chatActions).where(eq(chatActions.id, otherId));
      expect(other.status).toBe("received");
      expect(await service.processPendingReceiptReactions(1)).toBe(1);
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await service.shutdown();
      await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, fixture.endpointId));
    }
  });

  it.each([false, true])("binds dates, arrays, limits and company IDs with driver prepare=%s", async (prepare) => {
    const db = createDb(database.connectionString, { prepare });
    const companyA = randomUUID();
    const companyB = randomUUID();
    fixtureCompanies.add(companyA);
    fixtureCompanies.add(companyB);
    await db.insert(companies).values([
      { id: companyA, name: "Query A", issuePrefix: "QA" + companyA.slice(0, 6) },
      { id: companyB, name: "Query B", issuePrefix: "QB" + companyB.slice(0, 6) },
    ]);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const otherId = randomUUID();
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    const futureDate = new Date("2026-02-01T00:00:00.000Z");
    await db.insert(agents).values([
      { id: firstId, companyId: companyA, name: "First", role: "engineer", createdAt: oldDate },
      { id: secondId, companyId: companyA, name: "Second", role: "engineer", createdAt: futureDate },
      { id: otherId, companyId: companyB, name: "Other", role: "engineer", createdAt: oldDate },
    ]);
    const executor = createChatQueryExecutor(true);
    const select = executor.query("chat_binding_regression", () => db
      .select({ id: agents.id, createdAt: agents.createdAt })
      .from(agents)
      .where(and(
        eq(agents.companyId, sql.placeholder("companyId")),
        lte(agents.createdAt, sql.placeholder("now")),
        sql`not (${agents.id} = any(${sql.placeholder("excludedIds")}::uuid[]))`,
      ))
      .orderBy(asc(agents.id))
      .limit(sql.placeholder("limit")));
    const parameters = { companyId: companyA, now: oldDate.toISOString(), excludedIds: [], limit: 10 };
    expect(await select(parameters)).toEqual([{ id: firstId, createdAt: oldDate }]);
    expect(await select({ ...parameters, excludedIds: [firstId] })).toEqual([]);
    expect(await select({ ...parameters, now: futureDate.toISOString(), excludedIds: [firstId, secondId] })).toEqual([]);
    expect(await select({ ...parameters, now: futureDate.toISOString(), limit: 1 })).toHaveLength(1);
    const [a, b] = await Promise.all([
      select({ ...parameters, now: futureDate.toISOString() }),
      select({ ...parameters, companyId: companyB }),
    ]);
    expect(a.map((row) => row.id).sort()).toEqual([firstId, secondId].sort());
    expect(b.map((row) => row.id)).toEqual([otherId]);
    const insertedId = randomUUID();
    await db.insert(agents).values({ id: insertedId, companyId: companyA, name: "Fresh", role: "engineer", createdAt: oldDate });
    expect((await select(parameters)).map((row) => row.id).sort()).toEqual([firstId, insertedId].sort());
    executor.clear();
    expect((await select(parameters)).map((row) => row.id).sort()).toEqual([firstId, insertedId].sort());
  });
});
