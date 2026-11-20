import { randomUUID } from "node:crypto";
import { eq, fillPlaceholders } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatConversations, chatPublications, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { loadNativeChatProgressScopes, nativeProgressPageQuery, nativeProgressPageStatement } from "../services/chat-native-progress.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_PROGRESS_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native chat progress page statement", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  type Chat = Awaited<ReturnType<typeof fixtures.create>>;
  type PageInput = Parameters<typeof nativeProgressPageStatement>[1];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-chat-progress-statement-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await fixtures.cleanup(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const since = new Date(Date.now() - 3_600_000);
  const text = (value: string) => value.replace(/\s+/g, " ").trim();
  const builderQuery = (input: PageInput) => nativeProgressPageQuery(db, {
    since: input.since, pageSize: input.pageSize, cursor: input.cursor,
    companyId: input.scope ? input.scope.companyId : undefined,
    issueId: input.scope?.issueId ? input.scope.issueId : undefined,
  });

  async function progressRun(chat: Chat, events: Array<{ eventType: string; payload?: Record<string, unknown> | null; message?: string | null }>,
    run: Partial<typeof heartbeatRuns.$inferInsert> = {}): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: chat.companyId, agentId: chat.agentId, nativeIssueId: chat.issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId: chat.issueId }, ...run });
    await db.insert(chatPublications).values({ companyId: chat.companyId, endpointId: chat.endpointId, conversationId: chat.conversationId,
      issueId: chat.issueId, idempotencyKey: `run:${runId}:working:${chat.endpointId}`,
      payload: { text: "Maya is working…", progressState: "working" }, state: "published", createdAt: new Date(Date.now() - 600_000) });
    if (events.length) {
      await db.insert(heartbeatRunEvents).values(events.map((event, index) => ({ companyId: chat.companyId, agentId: chat.agentId, runId,
        seq: index + 1, eventType: event.eventType, payload: event.payload ?? null, message: event.message ?? null,
        createdAt: new Date(Date.now() - 60_000 + index) })));
    }
    return runId;
  }

  const shapes = (companyId: string, issueId: string): PageInput[] => {
    const cursor = { eventCreatedAt: "2026-11-12 10:00:00.123456+00", runId: randomUUID(), conversationId: randomUUID() };
    return [undefined, { companyId }, { companyId, issueId }, { companyId, issueId: "" }].flatMap(scope =>
      [null, cursor].map(pageCursor => ({ since, scope, cursor: pageCursor, pageSize: pageCursor ? 25 : 200 })));
  };

  it("sends the SQL text and the parameters that the query builder writes, for every shape of the read", () => {
    const texts = new Set<string>();
    for (const input of shapes(randomUUID(), randomUUID())) {
      const built = builderQuery(input).toSQL();
      const { statement, values } = nativeProgressPageStatement(db, input);
      const prepared = statement.getQuery();
      expect(text(prepared.sql)).toBe(text(built.sql));
      expect(fillPlaceholders(prepared.params, values)).toEqual(built.params);
      expect(built.params).toContain(since.toISOString());
      texts.add(prepared.sql);
    }
    expect(texts.size).toBe(6);
  });

  it("returns the rows of the query builder: same values, types and order, and no other company's rows", async () => {
    const first = await fixtures.create(), second = await fixtures.create(first.companyId), other = await fixtures.create();
    const runs: string[] = [
      await progressRun(first, [{ eventType: "tool.execution.started", payload: { tool: null, nested: { value: 1 } } },
        { eventType: "item.completed", payload: null, message: null }, { eventType: "adapter.output", message: "not progress" }]),
      await progressRun(second, [{ eventType: "research.started" }]),
      await progressRun(second, [{ eventType: "workspace.ready" }], { nativeIssueId: null, issueId: second.issueId, contextSnapshot: null }),
      await progressRun(other, [{ eventType: "item.completed", payload: { private: "other company" } }]),
    ];
    await progressRun(first, [{ eventType: "item.completed" }], { status: "succeeded", finishedAt: new Date() });
    await progressRun(first, [{ eventType: "adapter.output" }]);
    const completed = await fixtures.create(first.companyId);
    await progressRun(completed, [{ eventType: "item.completed" }]);
    await db.update(chatConversations).set({ state: "completed" }).where(eq(chatConversations.id, completed.conversationId));

    const both = async (input: PageInput) => {
      const { statement, values } = nativeProgressPageStatement(db, input);
      const prepared = await statement.execute(values), built = await builderQuery(input);
      expect(prepared).toStrictEqual(built);
      return prepared;
    };
    const all = await both({ since, scope: undefined, cursor: null, pageSize: 200 });
    expect(all.filter(row => runs.includes(row.runId)).map(row => row.runId).sort()).toEqual([...runs].sort());
    expect(all.find(row => row.runId === runs[0])).toMatchObject({ eventSeq: 2, eventType: "item.completed", agentName: "Maya",
      companyId: first.companyId, issueId: first.issueId, endpointId: first.endpointId, conversationId: first.conversationId });
    expect(typeof all[0]!.eventId).toBe("number");
    expect(all[0]!.eventCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}/);

    const company = await both({ since, scope: { companyId: first.companyId }, cursor: null, pageSize: 200 });
    expect(company.map(row => row.runId)).toEqual(all.filter(row => row.companyId === first.companyId).map(row => row.runId));
    expect(company).toHaveLength(3);
    expect(company.every(row => row.companyId === first.companyId)).toBe(true);
    expect(await both({ since, scope: { companyId: first.companyId, issueId: "" }, cursor: null, pageSize: 200 })).toStrictEqual(company);

    const task = await both({ since, scope: { companyId: first.companyId, issueId: second.issueId }, cursor: null, pageSize: 200 });
    expect(task.map(row => row.runId).sort()).toEqual([runs[1], runs[2]].sort());
    expect(await both({ since, scope: { companyId: first.companyId, issueId: other.issueId }, cursor: null, pageSize: 200 })).toEqual([]);
    expect(await both({ since, scope: { companyId: other.companyId }, cursor: null, pageSize: 200 })).toHaveLength(1);
    expect(await both({ since: new Date(Date.now() + 60_000), scope: { companyId: first.companyId }, cursor: null, pageSize: 200 })).toEqual([]);

    const walked: typeof company = [];
    for (let cursor: PageInput["cursor"] = null; ;) {
      const page = await both({ since, scope: { companyId: first.companyId }, cursor, pageSize: 1 });
      if (!page.length) break;
      expect(page).toHaveLength(1);
      walked.push(page[0]!);
      cursor = { eventCreatedAt: page[0]!.eventCreatedAt, runId: page[0]!.runId, conversationId: page[0]!.conversationId };
    }
    expect(walked).toStrictEqual(company);
    const last = company.at(-1)!;
    expect(await both({ since, scope: { companyId: first.companyId, issueId: second.issueId }, pageSize: 25,
      cursor: { eventCreatedAt: company[0]!.eventCreatedAt, runId: company[0]!.runId, conversationId: company[0]!.conversationId } }))
      .toStrictEqual(task.filter(row => row.runId !== company[0]!.runId));
    expect(await both({ since, scope: undefined, pageSize: 25,
      cursor: { eventCreatedAt: last.eventCreatedAt, runId: last.runId, conversationId: last.conversationId } }))
      .toStrictEqual(all.slice(all.findIndex(row => row.runId === last.runId) + 1, all.findIndex(row => row.runId === last.runId) + 26));
  });

  it("writes the SQL text of a read one time and then only binds values", async () => {
    const first = await fixtures.create(), second = await fixtures.create();
    await progressRun(first, [{ eventType: "item.completed" }]);
    await progressRun(second, [{ eventType: "item.completed" }]);
    await loadNativeChatProgressScopes(db, { companyId: first.companyId, issueId: first.issueId });

    const written = vi.spyOn(PgDialect.prototype, "sqlToQuery");
    const sent = vi.spyOn(db.$client, "unsafe");
    expect(await loadNativeChatProgressScopes(db, { companyId: first.companyId, issueId: first.issueId }))
      .toEqual([{ companyId: first.companyId, issueId: first.issueId }]);
    expect(await loadNativeChatProgressScopes(db, { companyId: second.companyId, issueId: second.issueId }))
      .toEqual([{ companyId: second.companyId, issueId: second.issueId }]);
    expect(await loadNativeChatProgressScopes(db, { companyId: second.companyId, issueId: first.issueId })).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(3);
    expect(new Set(sent.mock.calls.map(call => call[0])).size).toBe(1);
    expect(written).not.toHaveBeenCalled();
  });
});
