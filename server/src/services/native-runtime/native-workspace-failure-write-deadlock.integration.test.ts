import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";

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

    let agentLocked!: () => void;
    const agentLock = new Promise<void>(resolve => { agentLocked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
      agentLocked();
      for (let waited = 0; ; waited += 25) {
        const blocked = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where wait_event_type = 'Lock' and query like 'insert into "issue_recovery_actions"%'`);
        if (blocked.length) break;
        if (waited > 30_000) throw new Error("failure write never waited on the agent row");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    });
    await Promise.race([agentLock, holder]);
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
