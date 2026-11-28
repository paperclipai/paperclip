import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, completionContracts, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions,
  issues, nativeRunFinalizations } from "@paperclipai/db";
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
import { heartbeatService } from "../heartbeat.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { NATIVE_RESUME_REFUSED_CONTINUATION_CODE, NATIVE_RESUME_REFUSED_CONTINUATION_DELAY_MS, nativeResumeRefusedHint,
  nativeResumeRefusedMessage, type NativeResumeRefusalReason as Reason } from "./native-resume-refused-continuation.js";

describe("native run whose environment refuses to resume its saved session", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-resume-refused-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Resume refused", issuePrefix: "NRR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function refuseAdmission(input: { reason: Reason; resumedFrom: string | null; scheduledRetryReason?: string;
    scheduledRetryAttempt?: number; resultJson?: Record<string, unknown> }) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the brief", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId, wakeCommentId: "original-message" }, resultJson: input.resultJson ?? null,
      scheduledRetryReason: input.scheduledRetryReason ?? null, scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0 }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, providerLeaseId: "attempt-task",
      metadata: { driver: "plugin", runnerTaskResumeFrom: input.resumedFrom, runnerTaskDispatched: false, runnerTaskExecutionStopped: true,
        runnerTaskAdmissionRejection: { taskId: "attempt-task", reason: input.reason } } });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Write the brief.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    provider.execute.mockReset().mockRejectedValue(new Error(`runner_task_admission_rejected: ${input.reason}`));
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const retries = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { issueId, runId, coordinator, retries, holds, issue: updatedIssue! };
  }

  function expectPermanentRefusal(refused: Awaited<ReturnType<typeof refuseAdmission>>) {
    expect(refused.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "runner_task_admission_rejected", nextAttemptAt: null,
      failureDetail: expect.objectContaining({ nextAction: expect.stringContaining("Automatic retries are stopped") }) });
    expect(refused.coordinator.failureDetail).not.toHaveProperty("successorRunId");
    expect(refused.retries).toHaveLength(0);
    expect(refused.issue).toMatchObject({ status: "blocked" });
    expect(refused.holds).toEqual([expect.objectContaining({ cause: "runner_task_admission_rejected", ownerType: "board" })]);
  }

  const reasons: Reason[] = ["account_binding_mismatch", "session_state_unavailable"];

  it.each(reasons)("continues a resumed session refused with %s once in a fresh session", async reason => {
    const refused = await refuseAdmission({ reason, resumedFrom: "prior-task" });
    const [retry] = refused.retries;
    expect(refused.retries).toHaveLength(1);
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: NATIVE_RESUME_REFUSED_CONTINUATION_CODE,
      scheduledRetryAttempt: 1, errorCode: NATIVE_RESUME_REFUSED_CONTINUATION_CODE, error: nativeResumeRefusedMessage(reason),
      contextSnapshot: { issueId: refused.issueId, forceFreshSession: true, retryOfRunId: refused.runId,
        livenessContinuationSourceRunId: refused.runId, livenessContinuationReason: NATIVE_RESUME_REFUSED_CONTINUATION_CODE,
        livenessContinuationInstruction: nativeResumeRefusedHint(reason) } });
    expect(retry!.contextSnapshot).not.toHaveProperty("wakeCommentId");
    expect(retry!.scheduledRetryAt!.getTime() - Date.now()).toBeLessThanOrEqual(NATIVE_RESUME_REFUSED_CONTINUATION_DELAY_MS);
    expect(refused.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "runner_task_admission_rejected",
      failureDetail: expect.objectContaining({ successorRunId: retry!.id, nextAction: nativeResumeRefusedMessage(reason) }) });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, refused.runId));
    expect(run).toMatchObject({ status: "failed", errorCode: "runner_task_admission_rejected" });
    expect(refused.holds).toHaveLength(0);
    expect(refused.issue).toMatchObject({ status: "in_progress", assigneeAgentId: agentId, executionRunId: null });
    await expect(taskInterruptionPresentation(db, refused.issue)).resolves.toMatchObject({ state: "retry_scheduled", canRetry: false });
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    expect(await scheduler.promoteDueScheduledRetries(retry!.scheduledRetryAt!)).toMatchObject({ promoted: 1, runIds: [retry!.id] });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry!.id));
  }, 120_000);

  it("names why the saved session could not be resumed", () => {
    expect(nativeResumeRefusedHint("account_binding_mismatch")).toContain("account binding changed");
    expect(nativeResumeRefusedHint("session_state_unavailable")).toContain("could not find the saved session state");
  });

  it.each(reasons)("stops when a fresh session is refused with %s", async reason => {
    expectPermanentRefusal(await refuseAdmission({ reason, resumedFrom: null }));
  }, 120_000);

  it.each(reasons)("stops when the fresh continuation itself is refused with %s", async reason => {
    expectPermanentRefusal(await refuseAdmission({ reason, resumedFrom: "prior-task",
      scheduledRetryReason: NATIVE_RESUME_REFUSED_CONTINUATION_CODE, scheduledRetryAttempt: 1 }));
  }, 120_000);

  it("does not continue a run a person stopped", async () => {
    const refused = await refuseAdmission({ reason: "account_binding_mismatch", resumedFrom: "prior-task",
      resultJson: { cancelledByActorType: "user" } });
    expect(refused.retries).toHaveLength(0);
    expect(refused.coordinator.failureDetail).not.toHaveProperty("successorRunId");
  }, 120_000);
});
