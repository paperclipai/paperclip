import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
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
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

const EXITED_PID = 4_194_304;

describe("a scheduled same-run resume reaching the provider runtime", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-scheduled-resume-continuation-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Scheduled resume", issuePrefix: "NSR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native agent", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const exactResume = { recoveryMode: "exact_checkpoint_resume", recoverable: true, providerSessionEstablished: true,
    checkpointExists: true, originalFailureCode: "native_session_recovery_failed" };

  async function resumeOnce(options: { failureDetail: Record<string, unknown>; stopRecorded: boolean; viaReconciler?: boolean;
    failedRelaunch?: boolean; unidentifiedStopRecorded?: boolean; liveRunnerForRun?: boolean }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Resume the lost turn",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue!.title, description: null, prompt: "Continue the work.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
      sessionCheckpoint: { backendKind: "runner", driverKind: "codex_app_server", sessionId: native.normalizedSessionId,
        identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId },
        providerSessionId: "provider-thread", cursor: "1", activeTurnId: "lost-turn", pendingRuntimeRequests: [], lineage: [] } },
      ...(options.viaReconciler ? { status: "failed" as const, nativePhase: "retryable_failure" } : {}) })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1,
      failureCode: "native_session_interrupted", failureDetail: options.failureDetail });
    const identity = { processPid: EXITED_PID, processGroupId: EXITED_PID, processStartedAt: new Date().toISOString() };
    const events = [
      { eventType: "native.process_start_requested", payload: { providerAttempt: 1 } },
      { eventType: "native.process_identity_recorded", payload: identity },
      ...(options.stopRecorded ? [{ eventType: "native.local_process_stopped", payload: identity }] : []),
      ...(options.failedRelaunch ? [{ eventType: "native.process_start_requested",
        payload: { hostname: hostname(), providerAttempt: 1, requestedAt: new Date().toISOString() } }] : []),
      ...(options.unidentifiedStopRecorded ? [{ eventType: "native.local_process_stopped",
        payload: { processPid: null, processGroupId: null, processStartedAt: null, basis: "unidentified_runner_absent" } }] : []),
    ];
    const [last] = await db.select({ seq: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)::int` })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    let seq = last?.seq ?? 0;
    for (const event of events) {
      seq += 1;
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq, eventType: event.eventType,
        stream: "system", level: "info", payload: event.payload });
    }
    await db.update(heartbeatRuns).set({ nextEventSeq: seq + 1 }).where(eq(heartbeatRuns.id, runId));
    const passed: Array<boolean | undefined> = [];
    provider.execute.mockReset().mockImplementation(async (input: { resumeInterruptedTurn?: boolean }) => {
      passed.push(input.resumeInterruptedTurn);
      throw new Error("scheduled_resume_fixture_stop");
    });
    const liveRunner = options.liveRunnerForRun
      ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "--", "--run-id", runId], { stdio: "ignore" }) : null;
    if (liveRunner) await once(liveRunner, "spawn");
    let leaseOwner: string | undefined;
    if (options.viaReconciler) {
      const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: native.runnerInstanceId, runIds: [runId] });
      expect(claims).toEqual([expect.objectContaining({ runId })]);
      leaseOwner = claims[0]!.leaseOwner;
    }
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, leaseOwner, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).catch(() => undefined).finally(() => { liveRunner?.kill("SIGKILL"); });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    return { passed, coordinator: coordinator! };
  }

  it.each([false, true])("lets the runtime continue a lost turn after a verified stop and an admitted attempt (claimed by the resume reconciler: %s)", async (viaReconciler) => {
    const { passed, coordinator } = await resumeOnce({ failureDetail: exactResume, stopRecorded: true, viaReconciler });
    expect(passed).toEqual([true]);
    expect(coordinator.attempt).toBe(2);
  });

  it("continues the lost turn after a relaunch that failed before its runner existed", async () => {
    const { passed, coordinator } = await resumeOnce({ failureDetail: exactResume, stopRecorded: true, failedRelaunch: true });
    expect(passed).toEqual([true]);
    expect(coordinator.attempt).toBe(2);
  });

  it.each([false, true])("reuses the saved failed-relaunch stop on a later scheduled attempt (runner alive: %s)", async (liveRunnerForRun) => {
    const { passed } = await resumeOnce({ failureDetail: exactResume, stopRecorded: true, failedRelaunch: true,
      unidentifiedStopRecorded: true, liveRunnerForRun });
    expect(passed).toEqual([!liveRunnerForRun]);
  });

  it("keeps the lost turn failing after a failed relaunch while a runner for the run is still alive", async () => {
    const { passed } = await resumeOnce({ failureDetail: exactResume, stopRecorded: true, failedRelaunch: true, liveRunnerForRun: true });
    expect(passed).toEqual([false]);
  });

  it("keeps the lost turn failing when the reconciler claimed a resume without a stop receipt", async () => {
    const { passed } = await resumeOnce({ failureDetail: exactResume, stopRecorded: false, viaReconciler: true });
    expect(passed).toEqual([false]);
  });

  it.each([
    ["no stop of the previous runner was recorded", { failureDetail: exactResume, stopRecorded: false }],
    ["the saved failure is a bootstrap retry", { failureDetail: { ...exactResume, recoveryMode: "bootstrap_retry" }, stopRecorded: true }],
    ["the saved failure has no checkpoint", { failureDetail: { ...exactResume, checkpointExists: false }, stopRecorded: true }],
  ])("keeps the lost turn failing when %s", async (_name, options) => {
    const { passed } = await resumeOnce(options);
    expect(passed).toEqual([false]);
  });
});
