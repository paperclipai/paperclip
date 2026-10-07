import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { markExecutionReconciliation, validateExecutionReconciliation } from "./execution-recovery-resolution.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("retained workspace repair admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("workspace-restore-reconciliation-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), leaseId = randomUUID(), actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace repair", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover saved work", status: "blocked", assigneeAgentId: agentId });
    const workspaceRestoreRecovery = { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [leaseId] };
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, runtimeMode: "legacy",
      status: "failed", errorCode: "workspace_restore_failed", contextSnapshot: { issueId },
      finishedAt: new Date("2000-01-01T00:00:00Z"), runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      resultJson: { workspaceRestoreFailure: "restore_failed", conversationContinuation: "continue_conversation_v1", workspaceRestoreRecovery },
    });
    const identity = { id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId: `sandbox-${leaseId}` };
    await db.insert(environmentLeases).values({ ...identity, leasePolicy: "retain_on_failure", status: "released",
      releasedAt: new Date(), cleanupStatus: "success", metadata: {
        remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }),
      },
    });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
      status: "resolved", outcome: "blocked", nextAction: "Recover the missing workspace files and record repair evidence.",
      evidence: { runId: sourceRunId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery, automaticRecovery: { replay: "blocked" } },
    });
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "mixed",
      outcomeEvidence: "Inspected the saved run and confirmed its external action outcomes.",
      workspaceRepairEvidence: "Recovered the missing files from the retained sandbox and verified their contents.",
    };
    return { companyId, agentId, issueId, sourceRunId, leaseId, actionId, identity, decision };
  }

  it.each([
    { scenario: "reset_command", status: "failed" },
    { scenario: "existing_boundary", status: "failed" },
    { scenario: "reset_command", status: "cancelled" },
  ])("keeps a workspace hold through $scenario after $status without offering a task retry", async ({ scenario, status }) => {
    const f = await seed(), commentId = randomUUID();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "/new" });
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "active",
      ...(scenario === "existing_boundary" ? { conversationBoundaryCommentId: commentId } : {}),
    }).where(eq(issues.id, f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId,
      scenario === "reset_command" ? { conversationResetCommentId: commentId } : undefined);
    expect(blocker).toMatchObject({ recoveryActionId: f.actionId, runId: f.sourceRunId,
      canRetry: false, canContinue: false, nextAction: "Recover the missing workspace files and record repair evidence." });
  });

  it("accepts verified repair after exact remote stop without interpreting the sandbox PID on this server", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(validateExecutionReconciliation({ db, ...f })).resolves.toMatchObject({ id: f.sourceRunId });
  });

  it.each(["pending_stop", "wrong_receipt", "missing_source", "unrecorded_source", "empty_sources"])("rejects repair with %s even when releasedAt is populated", async scenario => {
    const f = await seed();
    if (scenario === "pending_stop") {
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.leaseId));
    } else if (scenario === "wrong_receipt") {
      await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt({ ...f.identity, id: randomUUID() },
        { providerLeaseId: f.identity.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.leaseId));
    } else if (scenario === "missing_source") {
      await db.delete(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    } else {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: scenario === "empty_sources" ? [] : [randomUUID()] },
      } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    await expect(validateExecutionReconciliation({ db, ...f })).rejects.toThrow("has not confirmed that it stopped");
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, f.actionId),
      eq(issueRecoveryActions.status, "resolved")))).toHaveLength(1);
  });

  it("requires workspace repair evidence even after stop succeeds", async () => {
    const f = await seed();
    await expect(validateExecutionReconciliation({ db, ...f, decision: { ...f.decision, workspaceRepairEvidence: undefined } }))
      .rejects.toThrow("workspaceRepairEvidence");
  });

  it("clears the replay hold only after validated repair is recorded, preserving the source and recovery evidence", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    const repaired = await validateExecutionReconciliation({ db, ...f });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await markExecutionReconciliation(db, action, f.decision, "board");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(recorded.evidence).toMatchObject({ workspaceRestoreRecovery: repaired.resultJson!.workspaceRestoreRecovery,
      executionReconciliation: { runId: f.sourceRunId, workspaceRepairEvidence: f.decision.workspaceRepairEvidence },
      continuationDelivery: "pending" });
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(source).toMatchObject({ status: "released", leasePolicy: "retain_on_failure",
      metadata: { remoteExecutionTermination: { state: "stopped" } } });
  });

  it("preserves the host process check for local restore failures", async () => {
    const f = await seed();
    await db.delete(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    await db.update(heartbeatRuns).set({ processPid: process.pid, resultJson: { workspaceRestoreFailure: "restore_lock_timeout" } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(validateExecutionReconciliation({ db, ...f })).rejects.toThrow("previous provider is still running");
  });

  it("does not let a remote stop receipt waive a separate local execution's process check", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "local", leasePolicy: "ephemeral", status: "released", releasedAt: new Date(), cleanupStatus: "success" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: null, cause: "execution_owner_active", nextAction: expect.stringContaining("provider process is still running"),
    });
    await expect(validateExecutionReconciliation({ db, ...f })).rejects.toThrow("previous provider is still running");
  });

  it.each(["pending_stop", "wrong_receipt", "missing_source"])("keeps remote ownership blocked with %s even without a host PID", async scenario => {
    const f = await seed();
    if (scenario === "pending_stop") {
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.leaseId));
    } else if (scenario === "wrong_receipt") {
      await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt({ ...f.identity, id: randomUUID() },
        { providerLeaseId: f.identity.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, f.leaseId));
    } else await db.delete(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: null, cause: "execution_owner_active", nextAction: expect.stringContaining("has not confirmed that it stopped"),
    });
  });
});
