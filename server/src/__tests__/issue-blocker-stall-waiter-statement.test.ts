import { randomUUID } from "node:crypto";
import { eq, fillPlaceholders, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, createDb, issueRelations, issues, type Db } from "@paperclipai/db";
import { stallWaiterPageQuery, stallWaiterPageStatement, wakeWaitersOfStalledIssues } from "../services/recovery/blocker-stall-wakeups.js";
import { markStallWakeDelivered, seedBlockerStall, seedBlockerStallCompany } from "./helpers/blocker-stall-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("blocker stall waiter page statement", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  type PageInput = Parameters<typeof stallWaiterPageStatement>[1];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("blocker-stall-statement-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const text = (value: string) => value.replace(/\s+/g, " ").trim();
  const builderQuery = ({ stall, onlyIssueId, after }: PageInput) => stallWaiterPageQuery(db, {
    companyId: stall.companyId, stalledIssueId: stall.issueId, parentId: stall.parentId ?? null, hasParent: Boolean(stall.parentId),
    onlyIssueId: onlyIssueId ? onlyIssueId : undefined, after: after ? after : undefined,
    wakeKeySuffix: `:${stall.issueId}:${stall.actionId}`,
  });
  const inputs = (stall: PageInput["stall"]): PageInput[] => [stall, { ...stall, parentId: null }].flatMap(variant =>
    [null, randomUUID()].flatMap(onlyIssueId => [null, randomUUID()].map(after => ({ stall: variant, onlyIssueId, after }))));

  it("sends the SQL text and the parameters that the query builder writes, for every shape of the read", () => {
    const stall = { companyId: randomUUID(), issueId: randomUUID(), actionId: randomUUID(), parentId: randomUUID() };
    const texts = new Set<string>();
    for (const input of inputs(stall)) {
      const built = builderQuery(input).toSQL();
      const { statement, values } = stallWaiterPageStatement(db, input);
      const prepared = statement.getQuery();
      expect(text(prepared.sql)).toBe(text(built.sql));
      expect(fillPlaceholders(prepared.params, values)).toEqual(built.params);
      expect(built.params[0]).toBe(input.stall.parentId);
      expect(built.params).toContain(`:${stall.issueId}:${stall.actionId}`);
      texts.add(prepared.sql);
    }
    expect(texts.size).toBe(8);
  });

  it("returns the rows of the query builder: same values, types and order, and no other company's rows", async () => {
    const company = await seedBlockerStallCompany(db), other = await seedBlockerStallCompany(db);
    const f = await seedBlockerStall(db, company, { dependents: 6 });
    const orphan = await seedBlockerStall(db, company, { parent: false, dependents: 2 });
    const foreign = await seedBlockerStall(db, other, { dependents: 1 });
    const [woken, done, hidden, unassigned, ...waiting] = f.dependents;
    await markStallWakeDelivered(db, f, woken!.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, done!.id));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden!.id));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, unassigned!.id));
    await markStallWakeDelivered(db, f, waiting[0]!.id, "failed");
    await markStallWakeDelivered(db, { ...foreign, stall: f.stall }, waiting[1]!.id);
    await db.insert(issueRelations).values({ companyId: other.companyId, issueId: foreign.stalled.id,
      relatedIssueId: foreign.parent!.id, type: "blocks" });

    const both = async (input: PageInput) => {
      const { statement, values } = stallWaiterPageStatement(db, input);
      const prepared = await statement.execute(values), built = await builderQuery(input);
      expect(prepared).toStrictEqual(built);
      return prepared;
    };
    const expected = [f.parent!.id, ...waiting.map(row => row.id)].sort();
    const all = await both({ stall: f.stall, onlyIssueId: null, after: null });
    expect(all.map(row => row.id)).toEqual(expected);
    expect(all.find(row => row.id === f.parent!.id)).toMatchObject({ relation: "child", status: "blocked",
      assigneeAgentId: company.agentId, identifier: null, responsibleUserId: null, executionWorkspaceId: null });
    expect(all.filter(row => row.id !== f.parent!.id).every(row => row.relation === "blocker")).toBe(true);

    expect((await both({ stall: f.stall, onlyIssueId: waiting[1]!.id, after: null })).map(row => row.id)).toEqual([waiting[1]!.id]);
    expect(await both({ stall: f.stall, onlyIssueId: woken!.id, after: null })).toEqual([]);
    expect((await both({ stall: f.stall, onlyIssueId: null, after: expected[0]! })).map(row => row.id)).toEqual(expected.slice(1));
    expect(await both({ stall: f.stall, onlyIssueId: expected[0]!, after: expected[0]! })).toEqual([]);
    expect(await both({ stall: f.stall, onlyIssueId: null, after: expected.at(-1)! })).toEqual([]);

    const blockers = await both({ stall: orphan.stall, onlyIssueId: null, after: null });
    expect(blockers.map(row => [row.id, row.relation])).toEqual(orphan.dependents.map(row => row.id).sort().map(id => [id, "blocker"]));
    expect((await both({ stall: orphan.stall, onlyIssueId: orphan.dependents[1]!.id, after: null })).map(row => row.id))
      .toEqual([orphan.dependents[1]!.id]);
    expect((await both({ stall: orphan.stall, onlyIssueId: null, after: blockers[0]!.id })).map(row => row.id)).toEqual([blockers[1]!.id]);
    expect(await both({ stall: orphan.stall, onlyIssueId: blockers[0]!.id, after: blockers[0]!.id })).toEqual([]);

    expect(await both({ stall: { ...f.stall, companyId: other.companyId }, onlyIssueId: null, after: null })).toEqual([]);
    expect((await both({ stall: foreign.stall, onlyIssueId: null, after: null })).map(row => row.id).sort())
      .toEqual([foreign.parent!.id, foreign.dependents[0]!.id].sort());
  });

  it("writes the SQL text of the waiter read one time and then only binds values", async () => {
    const company = await seedBlockerStallCompany(db);
    const stalls = [await seedBlockerStall(db, company), await seedBlockerStall(db, company), await seedBlockerStall(db, company)];
    for (const f of stalls) await markStallWakeDelivered(db, f, f.parent!.id);
    const enqueueWakeup = vi.fn();
    await wakeWaitersOfStalledIssues(db, enqueueWakeup, { companyId: company.companyId });

    const written = vi.spyOn(PgDialect.prototype, "sqlToQuery");
    const sent = vi.spyOn(db.$client, "unsafe");
    expect(await wakeWaitersOfStalledIssues(db, enqueueWakeup, { companyId: company.companyId }))
      .toMatchObject({ stalls: 3, woken: 0, failed: 0 });
    const waiterRead = (statement: unknown) => String(statement).includes("issue_blocker_stalled:");
    expect(sent.mock.calls.filter(call => waiterRead(call[0]))).toHaveLength(3);
    expect(new Set(sent.mock.calls.filter(call => waiterRead(call[0])).map(call => call[0])).size).toBe(1);
    expect(written.mock.results.filter(result => waiterRead((result.value as { sql: string }).sql))).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(3);
  });
});
