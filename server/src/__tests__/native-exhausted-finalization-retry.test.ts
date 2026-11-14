import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workspaceOperations,
} from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { finalizeNativeRun, NATIVE_FINALIZATION_AUTOMATIC_BACKOFF_MS } from "../services/native-runtime/native-run-finalizer.js";
import { refinalizeSavedNativeResult } from "../services/native-runtime/exhausted-finalization-retry.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { requestTaskRetry } from "../services/task-retry.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_FINALIZATION_TEST_DATABASE_URL");

// A provider-succeeded native run whose accepted result could not be applied
// to its task used to rest in review with a board recovery card and no Retry.
// Retry must apply the same saved result again, never start a provider run.
describe("Retry after native finalization runs out of retries", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "72200000-0000-4000-8000-000000000001";
  const agentId = "72200000-0000-4000-8000-000000000002";
  const userId = "board-user";
  let seq = 0;

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-exhausted-retry-");
    db = createDb(external ?? temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Exhausted finalization", issuePrefix: "NEF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Finalizing agent", adapterType: "codex_local", status: "running" });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function seedAcceptedRun(options: { brokenResult?: boolean } = {}) {
    seq += 1;
    const id = (n: number) => `72200000-0000-4000-8${String(seq).padStart(3, "0")}-${String(n).padStart(12, "0")}`;
    const issueId = id(1), contractId = id(2), runId = id(3);
    await db.insert(issues).values({ id: issueId, companyId, title: `Finalize saved result ${seq}`, status: "in_progress",
      assigneeAgentId: agentId, workMode: "standard" });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "phase6-v1", objective: "Finalize the saved result",
        criteria: [{ id: "objective", requirement: "The saved result is applied" }] },
      canonicalSha256: `exhausted-contract-${seq}`, createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch", nativeIssueId: issueId, nativeSessionId: runId,
      runnerInstanceId: contractId, completionContractId: contractId,
      completionContractSha256: `exhausted-contract-${seq}`, contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: `exhausted-contract-${seq}`, sourceInstanceId: contractId,
      controlPlaneSourceInstanceId: `exhausted-control-${seq}`,
    });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId, sessionId: runId }, sourceInstanceId: contractId });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `exhausted-result-${seq}` });
    if (options.brokenResult) await setResultTerminal(runId, "unknown");
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: runId, issueId,
      phase: "workspace_finalize", status: "succeeded" });
    return { issueId, runId };
  }

  async function setResultTerminal(runId: string, runTerminalState: string) {
    const stored = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)).then(rows => rows[0]!);
    await db.update(nativeRunResults).set({ resultJson: { ...(stored.resultJson as Record<string, unknown>),
      terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState } } }).where(eq(nativeRunResults.id, stored.id));
  }

  /** Three failed finalizations of a deterministic cause: no automatic delay applies. */
  async function exhaustFinalization(runId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, runId));
      await reconcileNativeFinalizations(db, [runId]);
    }
  }

  const coordinator = (runId: string) => db.select().from(nativeRunFinalizations)
    .where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]!);
  const issueRow = (issueId: string) => db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]!);
  const runCount = (issueId: string) => db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.nativeIssueId, issueId))).then(rows => rows[0]!.count);
  const presentation = async (issueId: string) => taskInterruptionPresentation(db, await issueRow(issueId));
  const retry = (issueId: string, runId: string, key: string) => requestTaskRetry({ db, companyId, issueId,
    actorId: userId, actorSource: "session", idempotencyKey: key, observedRunId: runId });

  async function expectStuckButRetryable(issueId: string, runId: string) {
    await expect(coordinator(runId)).resolves.toMatchObject({ phase: "terminal_failure",
      failureCode: "native_finalization_retry_exhausted" });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]))
      .resolves.toMatchObject({ status: "succeeded" });
    await expect(issueRow(issueId)).resolves.toMatchObject({ status: "in_review" });
    await expect(presentation(issueId)).resolves.toMatchObject({ state: "failed", canRetry: true, observedRunId: runId });
  }

  it("re-finalizes the saved result on Retry with no new provider run or attempt", async () => {
    const { issueId, runId } = await seedAcceptedRun({ brokenResult: true });
    await exhaustFinalization(runId);
    await expectStuckButRetryable(issueId, runId);
    const before = await coordinator(runId);
    // The cause clears (as row contention does); the saved result is intact.
    await setResultTerminal(runId, CONTROL_PLANE_CONFORMANCE_TERMINAL.runTerminalState);

    const receipt = await retry(issueId, runId, "refinalize-1");
    expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: runId, finalizeRunId: runId });
    await expect(retry(issueId, runId, "refinalize-1")).resolves.toMatchObject({ accepted: true, requestId: receipt.requestId });
    await expect(coordinator(runId)).resolves.toMatchObject({ phase: "workspace_finalizing", failureCode: null,
      recoveryHistory: [expect.objectContaining({ kind: "exhausted_finalization_retry", generationId: receipt.requestId,
        previousFailureCode: "native_finalization_retry_exhausted" })] });
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!)))
      .resolves.toEqual([expect.objectContaining({ status: "coalesced", runId,
        payload: expect.objectContaining({ taskRetry: expect.objectContaining({ strategy: "finalize_result" }) }) })]);
    await expect(db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.retry_requested")))).resolves.toEqual([expect.objectContaining({
        actorType: "user", actorId: userId, runId, details: expect.objectContaining({ strategy: "finalize_result" }) })]);

    // A second click (another tab, another user, a new key) joins the pending
    // saved-result Retry instead of queueing a provider Retry.
    await expect(retry(issueId, runId, "refinalize-2")).resolves.toMatchObject({ accepted: true,
      requestId: receipt.requestId, finalizeRunId: runId });
    const providerRetries = () => db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_retry"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      sql`${agentWakeupRequests.status} <> 'coalesced' or ${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' <> 'finalize_result'`));
    await expect(providerRetries()).resolves.toHaveLength(0);
    // A finalizer holds the coordinator (and would take the task next). A
    // click must join without waiting on it, or the two could deadlock.
    await db.transaction(async finalizer => {
      await finalizer.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).for("update");
      const joined = await Promise.race([retry(issueId, runId, "refinalize-locked"),
        new Promise(resolve => setTimeout(() => resolve("blocked on the coordinator lock"), 5_000))]);
      expect(joined).toMatchObject({ accepted: true, requestId: receipt.requestId });
    });
    // The Retry visibly took effect while the saved result is applied.
    await expect(presentation(issueId)).resolves.toMatchObject({ state: "working", canRetry: false,
      recoveryStep: "finishing_recovery" });

    await refinalizeSavedNativeResult(db, { companyId, runId });
    // A stale click after the result applied also joins; nothing new runs.
    const late = await retry(issueId, runId, "refinalize-3");
    expect(late).toMatchObject({ accepted: true, requestId: receipt.requestId });
    expect(late).not.toHaveProperty("finalizeRunId");
    await expect(providerRetries()).resolves.toHaveLength(0);
    const after = await coordinator(runId);
    expect(after).toMatchObject({ phase: "committed" });
    expect(after.decisionId).toBeTruthy();
    expect(after.attempt).toBe(before.attempt);
    expect(await runCount(issueId)).toBe(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]))
      .resolves.toMatchObject({ status: "succeeded", nativePhase: "committed" });
    const settled = await presentation(issueId);
    expect(settled?.canRetry ?? false).toBe(false);
    expect(settled?.state ?? "resolved").toBe("resolved");
    await expect(db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.status, "active"), eq(issueRecoveryActions.ownerType, "board")))).resolves.toHaveLength(0);
  });

  it("offers the same Retry for a coordinator an older build left terminal", async () => {
    const { issueId, runId } = await seedAcceptedRun({ brokenResult: true });
    await exhaustFinalization(runId);
    // The previous release's shape: no finalization count, budget judged on provider attempts.
    await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'finalizationFailureCount'` })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, runId));
    await expectStuckButRetryable(issueId, runId);
    await setResultTerminal(runId, CONTROL_PLANE_CONFORMANCE_TERMINAL.runTerminalState);

    await expect(retry(issueId, runId, "refinalize-old")).resolves.toMatchObject({ finalizeRunId: runId });
    await refinalizeSavedNativeResult(db, { companyId, runId });
    await expect(coordinator(runId)).resolves.toMatchObject({ phase: "committed", attempt: 3 });
    expect(await runCount(issueId)).toBe(1);
  });

  it("keeps a Retry whose re-finalization fails again bounded and visible", async () => {
    const { issueId, runId } = await seedAcceptedRun({ brokenResult: true });
    await exhaustFinalization(runId);
    await expectStuckButRetryable(issueId, runId);

    await expect(retry(issueId, runId, "refinalize-fails")).resolves.toMatchObject({ finalizeRunId: runId });
    await refinalizeSavedNativeResult(db, { companyId, runId });
    // The click granted a fresh budget: the first failure stays automatic.
    await expect(coordinator(runId)).resolves.toMatchObject({ phase: "retryable_failure",
      failureCode: "native_finalization_invalid" });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]?.resultJson))
      .resolves.toMatchObject({ finalizationFailureCount: 1 });
    await expect(presentation(issueId)).resolves.toMatchObject({ state: "working", canRetry: false });
    await exhaustFinalization(runId);
    await expectStuckButRetryable(issueId, runId);
    expect(await runCount(issueId)).toBe(1);
  });

  it("re-applies a result that lost status races after longer delays before asking for Retry", async () => {
    const { issueId, runId } = await seedAcceptedRun();
    const failOnce = async () => {
      // The quick retries are already spent; the next failure exhausts them.
      await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
        || '{"finalizationFailureCount": 2}'::jsonb` }).where(eq(heartbeatRuns.id, runId));
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
        failpoint: "status_projection" });
    };
    for (const delay of NATIVE_FINALIZATION_AUTOMATIC_BACKOFF_MS) {
      const started = Date.now();
      await failOnce();
      const row = await coordinator(runId);
      expect(row).toMatchObject({ phase: "retryable_failure", failureCode: "side_effect_planning_failed" });
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(started + delay - 1_000);
      await expect(issueRow(issueId)).resolves.toMatchObject({ status: "in_progress" });
      await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]?.resultJson))
        .resolves.toMatchObject({ finalizationFailureCount: 0 });
    }
    // Each delay is used once; then the board gets a working Retry.
    await failOnce();
    await expectStuckButRetryable(issueId, runId);
    await expect(retry(issueId, runId, "refinalize-after-backoff")).resolves.toMatchObject({ finalizeRunId: runId });
    await refinalizeSavedNativeResult(db, { companyId, runId });
    await expect(coordinator(runId)).resolves.toMatchObject({ phase: "committed" });
    expect(await runCount(issueId)).toBe(1);
  });
});
