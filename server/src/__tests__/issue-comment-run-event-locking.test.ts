import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { issueService } from "../services/issues.js";
import { randomUUID } from "node:crypto";

const support = await getEmbeddedPostgresTestSupport();
type Tx = Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitForBlock(tx: Tx, blockedPid: number, blockerPid: number, statement: string) {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    await tx.execute(sql`select pg_stat_clear_snapshot()`);
    last = await tx.execute(sql`select pid, query, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${blockedPid}`);
    const rows = await tx.execute<{ blocked: boolean }>(sql`select exists (
      select 1 from pg_stat_activity where pid = ${blockedPid} and wait_event_type = 'Lock'
        and query like ${statement} and ${blockerPid} = any(pg_blocking_pids(pid))
    ) as blocked`);
    if (rows[0]?.blocked) return;
    await pause(10);
  }
  throw new Error(`Expected the participating SQL statement to wait on its owning transaction: ${JSON.stringify(last)}`);
}
const outcome = async <T>(operation: Promise<T>) => operation.then(value => ({ value }), error => ({ error }));

describe.skipIf(!support.supported)("issue comments and run event row locks", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let writer: ReturnType<typeof createDb>, commenter: ReturnType<typeof createDb>;
  let writerPid: number, commenterPid: number;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-comment-event-lock-");
    writer = createDb(temporary.connectionString, { maxConnections: 1 });
    commenter = createDb(temporary.connectionString, { maxConnections: 1 });
    [writerPid, commenterPid] = await Promise.all([writer, commenter].map(async db =>
      Number((await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid)));
    await writer.insert(companies).values({ id: companyId, name: "Comment event locks", issuePrefix: "CEL" });
    await writer.insert(agents).values({ id: agentId, companyId, name: "Echo", adapterType: "process" });
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function fixture() {
    const issueId = randomUUID(), runId = randomUUID();
    await writer.insert(issues).values({ id: issueId, companyId, title: "Concurrent echo", assigneeAgentId: agentId, status: "in_progress" });
    await writer.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "running", contextSnapshot: { issueId } });
    return { issueId, runId };
  }

  it("commits an agent comment and a second run update without an issue/run foreign-key deadlock", async () => {
    const f = await fixture();
    let comment: Promise<unknown> | undefined;
    const event = await outcome(writer.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      comment = issueService(commenter).addComment(f.issueId, "One committed echo", { agentId, runId: f.runId });
      void comment.catch(() => {});
      await waitForBlock(tx, commenterPid, writerPid, 'insert into "issue_comments"%');
      return appendHeartbeatRunEvent(tx as unknown as ReturnType<typeof createDb>, {
        companyId, agentId, runId: f.runId, eventType: "log", message: "Provider output", stream: "stdout",
      });
    }));
    expect(comment).toBeDefined();
    const savedComment = await outcome(comment!);
    expect(event).not.toHaveProperty("error");
    expect(savedComment).not.toHaveProperty("error");
    expect(await writer.select({ body: issueComments.body, runId: issueComments.createdByRunId }).from(issueComments)
      .where(eq(issueComments.issueId, f.issueId))).toEqual([{ body: "One committed echo", runId: f.runId }]);
    expect(await writer.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, f.runId))).toEqual([{ seq: 1 }]);
    expect((await writer.select({ next: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId)))[0].next).toBe(2);
  }, 30_000);

  it.each(["issue status write", "Stop issue lock"] as const)("keeps %s serialized behind the actual comment transaction", async operation => {
    const f = await fixture();
    let competing: Promise<unknown> | undefined;
    await commenter.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await issueService(commenter).addComment(f.issueId, "Comment before competing mutation", { agentId, runId: f.runId }, undefined, tx);
      competing = operation === "issue status write"
        ? writer.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId)).returning().execute()
        : writer.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update").execute();
      void competing.catch(() => {});
      await waitForBlock(tx, writerPid, commenterPid, operation === "issue status write" ? 'update "issues"%' : 'select%');
    });
    expect(await outcome(competing!)).not.toHaveProperty("error");
    expect(await writer.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    expect((await writer.select({ status: issues.status }).from(issues).where(and(eq(issues.id, f.issueId), eq(issues.companyId, companyId))))[0].status)
      .toBe(operation === "issue status write" ? "cancelled" : "in_progress");
  }, 30_000);
});
