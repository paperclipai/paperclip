import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

// Staging: an interrupted provider turn wrote its
// same-run resume under a 1 s lock_timeout. Another transaction briefly held
// the agent row, so the recovery action's foreign-key check timed out (55P03),
// the whole failure write rolled back, and a resumable run became a task
// blocked on native_continuation_requires_reconciliation.
describe("native failure write under brief lock contention", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-failure-lock-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Failure lock", issuePrefix: "NFL" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("records the same-run resume after the competing lock is released", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the brief", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Write the brief.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
      sessionCheckpoint: { backendKind: "mock", providerSessionId: "opencode-session" } } }).where(eq(heartbeatRuns.id, runId));

    // Hold the agent row from another connection across the failure write.
    // The new recovery action references this agent, so its insert must wait.
    // Release the row only after a write attempt was blocked by it and then
    // cancelled by its lock timeout, so only a later attempt can succeed.
    let holder: Promise<void> | undefined;
    let cancelledAttempt = false;
    provider.execute.mockReset().mockImplementation(async () => {
      let locked!: () => void;
      const acquired = new Promise<void>(resolve => { locked = resolve; });
      holder = db.transaction(async tx => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
        const holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
        locked();
        let blocked = false;
        for (let poll = 0; poll < 1_000 && !cancelledAttempt; poll++) {
          const rows = (await db.execute(
            sql`select 1 from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`,
          )) as unknown as Array<unknown>;
          if (rows[0]) blocked = true;
          else if (blocked) cancelledAttempt = true;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      });
      await acquired;
      throw new Error("PRP command turn.start indeterminate: runner connection closed");
    });
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined);
    await holder;
    expect(cancelledAttempt).toBe(true);

    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "native_session_interrupted",
      recoveryState: "resuming_session", leaseOwner: null });
    const actions = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", kind: "active_run_watchdog", cause: "native_session_interrupted",
      ownerAgentId: agentId, wakePolicy: expect.objectContaining({ kind: "resume_native_run", runId }) });
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failedRun.errorCode).toBe("native_session_interrupted");
  }, 120_000);
});
