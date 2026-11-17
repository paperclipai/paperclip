import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, issueTreeHoldMembers, issueTreeHolds, nativeRunFinalizations, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpStructuredRunResult, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE,
  NATIVE_ENVIRONMENT_BLOCKER_HINT, NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES } from "./native-environment-blocker.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

type Blocker = NonNullable<PrpStructuredRunResult["blocker"]>;

const environmentBlocker: Blocker = {
  owner: { kind: "system", name: "execution-environment" }, scope: "task_wide", reasonCode: "environment_unavailable",
  unblockAction: "Resume/retry the run so the tool-result channel is healthy; then finish the remaining steps.",
};

describe("native run that reports a system environment blocker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-environment-blocker-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Environment blocker regression", issuePrefix: "ENV" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Environment worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "test-model" } });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function reportBlocked(blocker: Blocker, contextSnapshot: Record<string, unknown> = {}, beforeFinalize?: (issueId: string) => Promise<unknown>) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Ledger task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "env-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "env-owner", contextSnapshot: { issueId, ...contextSnapshot } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task using its history.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "blocked" };
    const result: PrpStructuredRunResult = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "blocked",
      summary: "Tool results looked corrupted, so the run stopped.",
      completionClaim: { contractRevision: contractInput.revision, objectiveSatisfied: false,
        criteria: contractInput.criteria.map(criterion => ({ criterionId: criterion.id, status: "unknown" as const, evidenceRefs: [] })),
        remainingWork: [{ description: "Finish the ledger", blocksCompletion: true }] },
      evidence: [], verification: [], attentionRequests: [], blocker };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 0, highestContiguousSourceSeq: 0, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    await beforeFinalize?.(issueId);
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const retries = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    const [settled] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { runId, issueId, decision: decision!, retries, issue: settled! };
  }

  it("continues the task automatically in a fresh session instead of resting it blocked", async () => {
    const { runId, decision, retries, issue } = await reportBlocked(environmentBlocker);
    expect(decision).toMatchObject({ reasonCode: NATIVE_ENVIRONMENT_BLOCKER_CODE });
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: NATIVE_ENVIRONMENT_BLOCKER_CODE, scheduledRetryAttempt: 1,
      contextSnapshot: { forceFreshSession: true, livenessContinuationSourceRunId: runId,
        livenessContinuationReason: NATIVE_ENVIRONMENT_BLOCKER_CODE, livenessContinuationInstruction: NATIVE_ENVIRONMENT_BLOCKER_HINT } });
    expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effectKind: "schedule_retry", targetType: "heartbeat_run", targetId: retries[0]!.id })]));
    expect(issue).toMatchObject({ status: "in_progress", unblockDescriptor: null });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "retry_scheduled", canRetry: false, userAction: null });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retries[0]!.id));
  });

  it("hands the task to the board once the automatic retries are spent", async () => {
    const { decision, retries, issue } = await reportBlocked(environmentBlocker, {
      executionRetryAccounting: { version: 1, failureRetries: NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES, maxTurnContinuations: 0 },
    });
    expect(decision).toMatchObject({ reasonCode: NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE });
    expect(retries).toHaveLength(0);
    expect(issue).toMatchObject({ status: "blocked",
      unblockDescriptor: { owner: "board", action: NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: false });
  });

  it("does not continue a paused task automatically", async () => {
    const { decision, retries } = await reportBlocked(environmentBlocker, {}, async issueId => {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId, rootIssueId: issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId, holdId, issueId, depth: 0, issueTitle: "Ledger task", issueStatus: "in_progress" });
    });
    expect(decision.reasonCode).not.toBe(NATIVE_ENVIRONMENT_BLOCKER_CODE);
    expect(retries).toHaveLength(0);
  });

  it("keeps a blocker that only its owner can resolve", async () => {
    const { decision, retries, issue } = await reportBlocked({ ...environmentBlocker, owner: { kind: "user", name: "board" },
      reasonCode: "credential_missing", unblockAction: "Add the deploy key." });
    expect(decision.reasonCode).toBe("task_wide_blocker_bound");
    expect(retries).toHaveLength(0);
    expect(issue.status).toBe("blocked");
  });
});
