import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatPublications, issues, toolApplications, toolConnections,
  closeRegisteredClients,
  createDb, getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createChatQueryExecutor } from "../services/chat-query-executor.js";
import { chatChannelService } from "../services/chat-channels.js";
import { createChatRunPublicationProjector } from "../services/chat-run-publications.js";
import * as githubReviews from "../services/chat-github-reviews.js";
import * as githubChecks from "../services/chat-github-checks.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

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

  it.each([false, true])("uses fresh presence checks and bounded compilation when optimized=%s", async (reuse) => {
    const db = createDb(database.connectionString);
    type Executable = { execute: (...args: unknown[]) => Promise<unknown> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    let executionCount = 0;
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args);
      const execute = prepared.execute.bind(prepared);
      prepared.execute = (...parameters) => { executionCount += 1; return execute(...parameters); };
      return prepared;
    });
    const providerFetch = vi.fn(async () => { throw new Error("Idle scans must not contact a provider"); });
    const service = chatChannelService(db, {
      idleOptimizations: reuse,
      heartbeat: { wakeup: vi.fn(async () => null) },
      fetch: providerFetch,
    });
    const scan = async () => {
      await service.reconcileProviderRuntimes();
      await service.processPendingDeliveries();
      await service.processPendingReceiptReactions();
      await service.processPendingSlackFileUploadReceipts();
      await service.processPendingPublications();
      await service.enqueueRunMilestones();
    };
    try {
      await scan();
      const first = observer.mock.calls.length;
      const names = () => observer.mock.calls.map((args) => args[2]).filter((name) => typeof name === "string" && name.startsWith("chat_"));
      const compiled = names().length;
      const executionsPerPass = executionCount;
      if (reuse) {
        expect(new Set(names())).toEqual(new Set([
          "chat_provider_runtimes", "chat_delivery_work_presence", "chat_telegram_endpoints_all",
          "chat_telegram_maintenance", "chat_receipt_reactions_all", "chat_slack_file_receipts",
          "chat_publication_work_presence", "chat_projection_presence",
        ]));
        expect(executionsPerPass).toBe(8);
      } else {
        expect(executionsPerPass).toBeGreaterThan(8);
      }
      for (let tick = 0; tick < 4; tick += 1) await scan();
      if (reuse) {
        expect(names()).toHaveLength(compiled);
        expect(new Set(names()).size).toBe(compiled);
      } else {
        expect(names()).toHaveLength(0);
        expect(observer.mock.calls.length).toBe(first * 5);
      }
      expect(executionCount).toBe(executionsPerPass * 5);
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      observer.mockRestore();
    }
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

  it.each([false, true])("refreshes the nested wakeup cutoff after an empty scan with reuse=%s", async (reuse) => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, true);
    const deliveryId = randomUUID();
    const clock = Date.now();
    const service = chatChannelService(db, { idleOptimizations: reuse, heartbeat: { wakeup: vi.fn(async () => null) } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    try {
      expect(await service.processPendingDeliveries(1, deliveryId)).toBe(0);
      await db.insert(chatDeliveries).values({
        id: deliveryId, ...fixture, providerEventId: deliveryId, deduplicationKey: deliveryId,
        eventKind: "message", normalizedEvent: {}, state: "processed",
      });
      await db.insert(chatActions).values({
        ...fixture, deliveryId, kind: "inbound_wakeup", providerActionId: deliveryId,
        status: "processing", updatedAt: new Date(clock),
      });
      expect(await service.processPendingDeliveries(1, deliveryId)).toBe(0);
      vi.setSystemTime(clock + 60_001);
      expect(await service.processPendingDeliveries(1, deliveryId)).toBe(1);
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, deliveryId));
      expect(delivery.state).toBe("failed");
    } finally {
      vi.useRealTimers();
      await service.shutdown();
    }
  });

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

  it.each([false, true])("advances and wraps Telegram endpoint pages with reuse=%s", async (reuse) => {
    const db = createDb(database.connectionString);
    const fixtures = await Promise.all(Array.from({ length: 3 }, () => endpointFixture(db, false)));
    for (const fixture of fixtures) {
      await db.update(chatEndpoints).set({ provider: "telegram" }).where(eq(chatEndpoints.id, fixture.endpointId));
    }
    type ObservedQuery = { sql: string; params: unknown[] };
    type Executable = { execute: (...parameters: unknown[]) => Promise<unknown[]> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    const pages: string[][] = [];
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const query = args[0] as ObservedQuery;
      const prepared = original(...args);
      if (query.sql.includes('from "chat_endpoints" inner join "tool_connections"') && query.params.includes("telegram")) {
        const execute = prepared.execute.bind(prepared);
        prepared.execute = async (...parameters) => {
          const rows = await execute(...parameters);
          pages.push((rows as Array<{ endpoint: { id: string } }>).map((row) => row.endpoint.id));
          return rows;
        };
      }
      return prepared;
    });
    const providerFetch = vi.fn(async () => { throw new Error("Unconfigured Telegram fixtures must not contact a provider"); });
    const service = chatChannelService(db, { idleOptimizations: reuse, heartbeat: { wakeup: vi.fn(async () => null) }, fetch: providerFetch });
    try {
      for (let tick = 0; tick < 5; tick += 1) await service.processPendingDeliveries(1);
      const sorted = fixtures.map((fixture) => fixture.endpointId).sort();
      expect(pages).toEqual([[sorted[0]], [sorted[1]], [sorted[2]], [], [sorted[0]]]);
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      observer.mockRestore();
      for (const fixture of fixtures) {
        await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, fixture.endpointId));
      }
    }
  });

  it("propagates presence-probe failures instead of reporting an empty pass", async () => {
    const db = createDb(database.connectionString);
    const service = chatChannelService(db, { idleOptimizations: true, heartbeat: { wakeup: vi.fn(async () => null) } });
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => { execute: (...parameters: unknown[]) => Promise<unknown> } } }).session;
    const original = session.prepareQuery.bind(session);
    const failure = new Error("injected presence failure");
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args);
      if (["chat_delivery_work_presence", "chat_publication_work_presence", "chat_projection_presence"].includes(String(args[2]))) {
        prepared.execute = async () => { throw failure; };
      }
      return prepared;
    });
    try {
      await expect(service.processPendingDeliveries()).rejects.toBe(failure);
      await expect(service.processPendingPublications()).rejects.toBe(failure);
      await expect(service.enqueueRunMilestones()).rejects.toBe(failure);
    } finally {
      observer.mockRestore();
      await service.shutdown();
    }
  });

  it.each([false, true])("discovers work committed after an empty pass with optimized=%s", async (optimized) => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, true);
    const service = chatChannelService(db, { idleOptimizations: optimized, heartbeat: { wakeup: vi.fn(async () => null) } });
    try {
      expect(await service.processPendingDeliveries()).toBe(0);
      expect(await service.enqueueRunMilestones()).toBe(0);
      const deliveryId = randomUUID();
      await db.insert(chatDeliveries).values({ id: deliveryId, ...fixture, providerEventId: deliveryId, deduplicationKey: deliveryId, eventKind: "message", normalizedEvent: {}, state: "received" });
      expect(await service.processPendingDeliveries()).toBe(1);
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, deliveryId));
      expect(delivery.state).toBe("failed");
      const [issue] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Historical task", status: "done" }).returning();
      await db.insert(chatConversations).values({ ...fixture, issueId: issue.id, externalConversationId: randomUUID(), externalLabel: "Historical conversation", state: "completed" });
      // A historical conversation deliberately falls through to both real
      // projection selectors, despite there being no running agent or run.
      expect(await service.enqueueRunMilestones()).toBe(0);
    } finally {
      await service.shutdown();
    }
  });

  it.each([false, true])("reuses historical idle selectors without sharing projection parameters with optimized=%s", async (optimized) => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, true);
    const [issue] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Historical task", status: "done" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ ...fixture, issueId: issue.id, externalConversationId: randomUUID(), externalLabel: "History", state: "completed" }).returning();
    const deliveryId = randomUUID();
    await db.insert(chatDeliveries).values({ id: deliveryId, ...fixture, conversationId: conversation.id, providerEventId: deliveryId, deduplicationKey: deliveryId, eventKind: "message", normalizedEvent: {}, state: "processed" });
    await db.insert(chatActions).values({ ...fixture, conversationId: conversation.id, deliveryId, kind: "reaction_delivery", providerActionId: deliveryId, status: "processed" });
    type Executable = { execute: (...parameters: unknown[]) => Promise<unknown> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    const milestoneParameters: Array<Record<string, unknown>> = [];
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args);
      const execute = prepared.execute.bind(prepared);
      if (args[2] === "chat_run_milestones_first") {
        prepared.execute = (...parameters) => {
          milestoneParameters.push(parameters[0] as Record<string, unknown>);
          return execute(...parameters);
        };
      }
      return prepared;
    });
    const service = chatChannelService(db, { idleOptimizations: optimized, heartbeat: { wakeup: vi.fn(async () => null) } });
    const scan = async () => {
      await service.processPendingDeliveries();
      await service.processPendingPublications();
      await service.processPendingSlackSessionSyncs();
      await service.enqueueRunMilestones();
    };
    try {
      await scan();
      const first = observer.mock.calls.length;
      const compiled = observer.mock.calls.filter((args) => String(args[2]).startsWith("chat_")).length;
      expect(compiled).toBe(optimized ? first : 0);
      if (optimized) expect(compiled).toBeGreaterThan(15);
      await scan();
      expect(observer.mock.calls.length).toBe(optimized ? first : first * 2);
      const older = new Date("2026-01-01T00:00:00Z");
      const newer = new Date("2026-02-01T00:00:00Z");
      expect(await Promise.all([
        service.enqueueRunMilestones({ since: older, limit: 30, publicBaseUrl: "https://one.example" }),
        service.enqueueRunMilestones({ since: newer, limit: 40, publicBaseUrl: "https://two.example" }),
      ])).toEqual([0, 0]);
      if (optimized) {
        expect(milestoneParameters.slice(-2).map(({ since, pageSize }) => ({ since, pageSize })).sort((a, b) => String(a.since).localeCompare(String(b.since)))).toEqual([
          { since: older.toISOString(), pageSize: 30 },
          { since: newer.toISOString(), pageSize: 40 },
        ]);
        expect(observer.mock.calls.length).toBe(first);
      }
      // Removing the last conversation changes the next presence result. A
      // rebuilt projector also observes the database instead of retained state.
      await db.delete(chatActions).where(eq(chatActions.conversationId, conversation.id));
      await db.delete(chatConversations).where(eq(chatConversations.id, conversation.id));
      expect(await service.enqueueRunMilestones()).toBe(0);
      const restarted = createChatRunPublicationProjector(db, { idleOptimizations: optimized });
      expect(await restarted.enqueue()).toBe(0);
      restarted.clear();
    } finally {
      await service.shutdown();
      observer.mockRestore();
    }
  });

  it("finds a delivery inserted after a negative presence snapshot on the next pass", async () => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, true);
    const deliveryId = randomUUID();
    type Executable = { execute: (...parameters: unknown[]) => Promise<unknown> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    let inserted = false;
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args);
      const execute = prepared.execute.bind(prepared);
      if (args[2] === "chat_delivery_work_presence") {
        prepared.execute = async (...parameters) => {
          const result = await execute(...parameters);
          if (!inserted) {
            inserted = true;
            await db.insert(chatDeliveries).values({ id: deliveryId, ...fixture, providerEventId: deliveryId, deduplicationKey: deliveryId, eventKind: "message", normalizedEvent: {}, state: "received" });
          }
          return result;
        };
      }
      return prepared;
    });
    const service = chatChannelService(db, { idleOptimizations: true, heartbeat: { wakeup: vi.fn(async () => null) } });
    try {
      expect(await service.processPendingDeliveries()).toBe(0);
      expect(await service.processPendingDeliveries()).toBe(1);
    } finally {
      observer.mockRestore();
      await service.shutdown();
    }
  });

  it("recovers a stale publication inserted after a negative presence snapshot", async () => {
    const db = createDb(database.connectionString);
    const fixture = await endpointFixture(db, true);
    const [issue] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Interrupted publication", status: "done" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ ...fixture, issueId: issue.id, externalConversationId: randomUUID(), externalLabel: "Historical conversation", state: "completed" }).returning();
    const publicationId = randomUUID();
    type Executable = { execute: (...parameters: unknown[]) => Promise<unknown> };
    const session = (db as unknown as { session: { prepareQuery: (...args: unknown[]) => Executable } }).session;
    const original = session.prepareQuery.bind(session);
    let inserted = false;
    const observer = vi.spyOn(session, "prepareQuery").mockImplementation((...args) => {
      const prepared = original(...args);
      const execute = prepared.execute.bind(prepared);
      if (args[2] === "chat_publication_work_presence") {
        prepared.execute = async (...parameters) => {
          const result = await execute(...parameters);
          if (!inserted) {
            inserted = true;
            await db.insert(chatPublications).values({ id: publicationId, ...fixture, conversationId: conversation.id, issueId: issue.id, idempotencyKey: publicationId, payload: { text: "Interrupted result" }, state: "streaming", updatedAt: new Date(Date.now() - 120_000) });
          }
          return result;
        };
      }
      return prepared;
    });
    const service = chatChannelService(db, { idleOptimizations: true, heartbeat: { wakeup: vi.fn(async () => null) } });
    try {
      expect(await service.processPendingPublications()).toBe(0);
      expect((await db.select().from(chatPublications).where(eq(chatPublications.id, publicationId)))[0].state).toBe("streaming");
      expect(await service.processPendingPublications()).toBe(0);
      expect((await db.select().from(chatPublications).where(eq(chatPublications.id, publicationId)))[0].state).toBe("delivery_unknown");
    } finally {
      observer.mockRestore();
      await service.shutdown();
    }
  });

  it.each([false, true])("uses the selected GitHub maintenance lifetime with optimized=%s", async (optimized) => {
    const db = createDb(database.connectionString);
    const reviewPending = vi.fn(async () => {});
    const checkPending = vi.fn(async () => {});
    const realReviews = githubReviews.githubChatReviewService;
    const realChecks = githubChecks.githubReviewCheckService;
    const reviews = vi.spyOn(githubReviews, "githubChatReviewService").mockImplementation((...args) => ({ ...realReviews(...args), processPending: reviewPending }));
    const checks = vi.spyOn(githubChecks, "githubReviewCheckService").mockImplementation((...args) => ({ ...realChecks(...args), processPending: checkPending }));
    const service = chatChannelService(db, { idleOptimizations: optimized, heartbeat: { wakeup: vi.fn(async () => null) } });
    try {
      for (let tick = 1; tick <= 2; tick += 1) {
        await service.schedulePendingPublications();
        await vi.waitFor(() => expect(checkPending).toHaveBeenCalledTimes(tick));
      }
      expect(reviewPending).toHaveBeenCalledTimes(2);
      expect(reviews).toHaveBeenCalledTimes(optimized ? 1 : 2);
      expect(checks).toHaveBeenCalledTimes(optimized ? 1 : 2);
    } finally {
      await service.shutdown();
      reviews.mockRestore();
      checks.mockRestore();
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
