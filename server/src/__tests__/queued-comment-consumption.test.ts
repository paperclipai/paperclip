import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, createDb, heartbeatRuns, issueComments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { captureQueuedCommentQuery, fixtureTime, planNodes, seedQueuedCommentConsumption } from "./helpers/queued-comment-consumption-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const external = process.env.QUEUED_COMMENT_TEST_DATABASE_URL;
const describePostgres = external || support.supported ? describe : describe.skip;
if (!external && !support.supported) console.warn(`Skipping queued-comment consumption tests: ${support.reason ?? "unsupported PostgreSQL runtime"}`);

describePostgres("queued-comment consumption in the execution blocker", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external && !new URL(external).pathname.startsWith("/queued_comments_")) throw new Error("Use a disposable queued_comments_ database");
    if (!external) database = await startEmbeddedPostgresTestDatabase("queued-comment-consumption-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 1 });
    await db.$client.unsafe("set client_min_messages = warning");
  }, 30_000);
  afterEach(async () => { await db?.execute(sql`TRUNCATE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("bounds repeated run-context reads for eight unconsumed saved comments", async () => {
    const f = await seedQueuedCommentConsumption(db, { comments: 8, history: 300, payloadBytes: 32 * 1024 });
    const captured = await captureQueuedCommentQuery(db, f);
    expect(captured.result?.savedMessageCount).toBe(8);
    const [explain] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.query!.sql}`, captured.query!.params as never[]);
    const scans = planNodes(explain["QUERY PLAN"][0].Plan).filter(node => node["Relation Name"] === "heartbeat_runs");
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.reduce((total, node) => total + Number(node["Actual Loops"]), 0)).toBeLessThanOrEqual(1);
    const plan = explain["QUERY PLAN"][0].Plan;
    expect(Number(plan["Shared Hit Blocks"]) + Number(plan["Shared Read Blocks"])).toBeLessThanOrEqual(300 * 32 + 1000);
  });

  it("preserves JSON containment, text IDs, scope, author and cancellation rules", async () => {
    const f = await seedQueuedCommentConsumption(db, { comments: 16 });
    const [singular, array, nested, scalar, object, upper, cancelled, startedCancelled, wrongTask, nativeOnly, otherCompany, deleted, agent, pending] = f.commentIds;
    await f.run({ issueId: f.issueId, wakeCommentId: singular });
    await f.run({ issueId: f.issueId, wakeCommentIds: [array, array, 1, {}, null] });
    await f.run({ issueId: f.issueId, wakeCommentIds: [[nested]] });
    await f.run({ issueId: f.issueId, wakeCommentIds: scalar });
    await f.run({ issueId: f.issueId, wakeCommentIds: { [object!]: true } });
    await f.run({ issueId: f.issueId.toUpperCase(), wakeCommentId: upper });
    await f.run({ issueId: f.issueId, wakeCommentId: cancelled }, { status: "cancelled", startedAt: null });
    await f.run({ issueId: f.issueId, wakeCommentId: startedCancelled }, { status: "cancelled" });
    await f.run({ issueId: f.otherIssueId, wakeCommentId: wrongTask }, { nativeIssueId: f.issueId });
    await f.run({ wakeCommentId: nativeOnly }, { issueId: f.issueId, nativeIssueId: f.issueId });
    const other = await seedQueuedCommentConsumption(db, { comments: 0 });
    await other.run({ issueId: f.issueId, wakeCommentId: otherCompany });
    await f.run({ issueId: f.issueId, wakeCommentIds: [pending] }, { status: "queued", startedAt: null });
    await f.run(null);
    await f.run([]);
    await f.run("text");
    await db.update(issueComments).set({ deletedAt: fixtureTime }).where(eq(issueComments.id, deleted!));
    await db.update(issueComments).set({ authorType: "agent", authorAgentId: f.agentId }).where(eq(issueComments.id, agent!));
    const captured = await captureQueuedCommentQuery(db, f);
    const expected = await db.$client.unsafe(`select id from issue_comments where company_id = $1::uuid and issue_id = $2::uuid
      and id = any($3::uuid[]) and author_type = 'user' and deleted_at is null
      and not exists (select 1 from heartbeat_runs consumed where consumed.company_id = $1::uuid
        and consumed.context_snapshot->>'issueId' = $2::text and not (consumed.status = 'cancelled' and consumed.started_at is null)
        and (consumed.context_snapshot->>'wakeCommentId' = issue_comments.id::text
          or consumed.context_snapshot->'wakeCommentIds' @> jsonb_build_array(issue_comments.id::text)))`, [f.companyId, f.issueId, f.commentIds]);
    const actual = await db.$client.unsafe(captured.query!.sql, captured.query!.params as never[]).values();
    expect(actual.map(row => row[0]).sort()).toEqual(expected.map(row => row.id).sort());
    expect(captured.result?.savedMessageCount).toBe(expected.length);
    expect(expected.map(row => row.id)).toEqual(expect.arrayContaining([nested, scalar, object, upper, cancelled, wrongTask, nativeOnly, otherCompany]));
    expect(expected.map(row => row.id)).not.toEqual(expect.arrayContaining([singular]));
    expect(expected).toHaveLength(10);
  });

  it.each([0, 1, 8, 64])("counts %s queued comments without a run or a replay", async count => {
    const f = await seedQueuedCommentConsumption(db, { comments: count });
    const before = await db.select().from(heartbeatRuns);
    const result = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(result).toEqual({ recoveryActionId: f.action.id, runId: null, agentId: null, cause: f.action.cause,
      nextAction: f.action.nextAction, runStatus: null, runError: null, canContinue: false, canRetry: false, savedMessageCount: count });
    expect(await db.select().from(heartbeatRuns)).toEqual(before);
    await db.update(agentWakeupRequests).set({ status: "consumed" }).where(eq(agentWakeupRequests.id, f.wake.id));
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.savedMessageCount).toBe(0);
    await db.update(issueRecoveryActions).set({ status: "resolved" }).where(and(eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.id, f.action.id)));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
