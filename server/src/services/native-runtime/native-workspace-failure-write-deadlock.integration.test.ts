import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";

// Staging: a workspace sync-out failure was recorded in one transaction that
// updates the run row and then inserts its recovery action. That insert's
// foreign-key check waited on an agent row another transaction held, which in
// turn waited on the run row. Postgres aborted the failure write (40P01), the
// run failed with a database error, and the bounded export retry was lost.
describe("native workspace failure write under a deadlock", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-workspace-failure-deadlock-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Failure deadlock", issuePrefix: "NWD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Exporter", adapterType: "paperclip_runner" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("records the retryable export failure after losing a deadlock", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Export saved work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "result_accepted" });

    // Hold the agent row. Once the failure write waits on it for its recovery
    // action, wait on the run row that write already updated. The holder
    // detects deadlocks late, so Postgres aborts the failure write.
    const holder = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
      for (let waited = 0; ; waited += 25) {
        const blocked = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where wait_event_type = 'Lock' and query like 'insert into "issue_recovery_actions"%'`);
        if (blocked.length) break;
        if (waited > 30_000) throw new Error("failure write never waited on the agent row");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    });
    const failure = await recordNativeFinalizationFailure({ db, runId, error: new Error("native_workspace_sync_out_failed"),
      failureScope: "workspace", projectRunStatus: true });
    await holder;

    expect(failure).toMatchObject({ phase: "retryable_failure", failureCode: "native_workspace_sync_out_failed" });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "native_workspace_sync_out_failed",
      failureDetail: expect.objectContaining({ workspaceFinalizeAttempt: 1 }) });
    const actions = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", kind: "active_run_watchdog", cause: "native_workspace_sync_out_failed",
      ownerAgentId: agentId, wakePolicy: expect.objectContaining({ kind: "resume_native_run", runId }) });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "running", nativePhase: "retryable_failure" });
  }, 120_000);
});
