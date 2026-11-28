import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, completionContracts, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { executionControlSchedule } from "../execution-control-work.js";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "../recovery/continuation-ledger.js";
import { FRESH_CONTINUATION_WINDOW_MS } from "../fresh-continuation-fallback.js";

const DAYTONA_CLIENT_TIMEOUT = "HTTP request timed out after 300000ms waiting for a response. This is a client-side deadline "
  + "(DaytonaConfig.requestTimeoutMs, or the per-call operation/execution timeout); any operation already started on the "
  + "server may still be running.";

describe("a native turn cut off by a sandbox client timeout", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-client-timeout-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Client timeout", issuePrefix: "NCT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
  }, 240_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function failTurnWithClientTimeout(issueId: string) {
    const runId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Build it.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const turnStarted: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-started", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.started", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: {},
    };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId },
        backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(turnStarted);
      throw new Error(DAYTONA_CLIENT_TIMEOUT);
    });
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined);
    return runId;
  }

  const continuationsOf = (runId: string) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${runId}`));

  it("continues the task automatically exactly once in a fresh run, without replaying the cut-off turn", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Build the feature", status: "in_progress",
      workMode: "standard", assigneeAgentId: agentId });
    const runId = await failTurnWithClientTimeout(issueId);

    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failed).toMatchObject({ status: "failed", errorCode: "native_session_interrupted", error: DAYTONA_CLIENT_TIMEOUT });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_interrupted", nextAttemptAt: null,
      failureDetail: expect.objectContaining({ recoveryMode: "ambiguous_state", providerEventsExist: true }) });

    await settleUnrecoverableExecutions(db);
    await settleUnrecoverableExecutions(db);

    const continuations = await continuationsOf(runId);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.evidence).toMatchObject({ continuationDelivery: "pending",
      freshContinuation: { sourceRunId: runId, failureCode: "native_session_interrupted" },
      freshContinuationSettlement: { replay: "none", decision: "continue_in_fresh_run" } });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "todo", assigneeAgentId: agentId });
    const open = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
      sql`${issueRecoveryActions.status} in ('active', 'escalated')`));
    expect(open).toEqual([]);
    const [settled] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(settled.failureDetail).toMatchObject({ replacementDenied: "fresh_continuation" });
    expect(provider.execute).toHaveBeenCalledOnce();

    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await deliverReconciledExecutions(db, wake);
    await deliverReconciledExecutions(db, wake);
    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(agentId, expect.objectContaining({
      payload: expect.objectContaining({ issueId }) }));
  }, 120_000);

  it("registers the capped continuation's next check with the disposition worker and continues the task when it is due", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Build the capped feature", status: "in_progress",
      workMode: "standard", assigneeAgentId: agentId });
    const runId = await failTurnWithClientTimeout(issueId);
    const firstAt = new Date(Date.now() - 10 * 60_000);
    const capped = await db.insert(activityLog).values(Array.from({ length: 6 }, (_, index) => ({ companyId, actorId: "test",
      action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: issueId, details: { outcome: "queued" },
      createdAt: new Date(firstAt.getTime() + index * 1_000) }))).returning({ id: activityLog.id });

    await settleUnrecoverableExecutions(db);
    expect(await continuationsOf(runId)).toHaveLength(0);
    const [hold] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.status, "active")));
    const nextCheckAt = firstAt.getTime() + FRESH_CONTINUATION_WINDOW_MS;
    expect(hold?.evidence).toMatchObject({ freshContinuationCheck: { kind: "backoff", nextCheckAt } });
    expect(await executionControlSchedule(db).disposition()).toBe(nextCheckAt);

    await db.delete(activityLog).where(sql`${activityLog.id} in ${capped.map(row => row.id)}`);
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1}::bigint))` }).where(eq(issueRecoveryActions.id, hold!.id));
    await settleUnrecoverableExecutions(db);
    expect(await continuationsOf(runId)).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "todo" });
  }, 120_000);
});
