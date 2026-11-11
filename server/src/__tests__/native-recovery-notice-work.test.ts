import * as museTerminal from "../services/native-runtime/muse-terminal-reconciliation.js";
import * as conversationLifecycle from "../services/slack-conversation-lifecycle.js";
import { projectCommittedRun } from "../services/native-runtime/native-run-projection.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { statusDecisionEffects } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { nativeRecoveryNoticeWork } from "../services/native-runtime/native-recovery-notice-work.js";
import { resolveCommittedNativeRecoveryNotices } from "../services/native-runtime/native-recovery-notices.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueRecoveryActions } from "@paperclipai/db";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import * as statusCommitter from "../services/native-runtime/status-decision-committer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { emitAgentTaskRun } from "../services/agent-task-run-telemetry.js";
vi.mock("../services/agent-task-run-telemetry.js", () => ({ emitAgentTaskRun: vi.fn(async () => undefined) }));
vi.mock("../services/run-failure-report.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/run-failure-report.js")>(), reportRunFailure: vi.fn(async () => undefined),
}));

describe("committed native recovery notice lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db, root: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof nativeRecoveryNoticeWork>["register"]> | undefined;
  const companyId = randomUUID(), agentId = randomUUID();
  const priorLogs = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  let admitted = true;
  const errors: unknown[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "native-recovery-notice-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = root;
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RECOVERY_NOTICE_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-recovery-notice-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Result commits", issuePrefix: `RC${randomUUID().slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Result worker", adapterType: "paperclip_runner" });
  }, 30_000);
  beforeEach(() => {
    admitted = true; errors.length = 0; vi.mocked(emitAgentTaskRun).mockClear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; worker = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorLogs === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogs;
  });
  async function start(project = resolveCommittedNativeRecoveryNotices) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = nativeRecoveryNoticeWork(db, project).register(coordinator, () => admitted);
    await worker.ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
  }
  async function quiet() {
    const previous = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try { await vi.advanceTimersByTimeAsync(120_000); await delay(10); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = previous; }
  }
  async function seed() {
    const runId = randomUUID(), issueId = randomUUID(), contractId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Commit accepted work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "result-worker-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "result-worker-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "result-worker-test" };
  }
  async function complete(binding: Awaited<ReturnType<typeof seed>>, producer: "control_plane" | "coordinator", writer: Db = db, terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const port = producer === "control_plane" ? new PaperclipControlPlanePort(writer, binding)
      : new NativeRunCoordinatorStore(writer, { ...binding, normalizedSessionId: binding.sessionId,
        runnerSourceInstanceId: binding.sourceInstanceId,
        completionContractRevision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        completionContractCriterionIds: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(item => item.criterionId) });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: terminalStatus },
      callerResultId: `${binding.runId}:result` });
  }
  async function barrier(binding: Awaited<ReturnType<typeof seed>>) {
    await workspaceOperationService(db).createRecorder({ companyId, issueId: binding.issueId, heartbeatRunId: binding.runId })
      .recordOperation({ phase: "workspace_finalize", cwd: root, run: async () => ({ status: "succeeded", exitCode: 0 }) });
  }
  async function state(runId: string) {
    return db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]);
  }
  async function read(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
  }
  async function accepted(status: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const binding = await seed(); await complete(binding, "control_plane", db, status); await barrier(binding); return binding;
  }
  async function committed() {
    const binding = await accepted();
    const result = await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(result.phase, JSON.stringify(await state(binding.runId))).toBe("committed");
    return binding;
  }
  async function notice(binding: Awaited<ReturnType<typeof seed>>, writer: Db = db,
    patch: Partial<Parameters<ReturnType<typeof issueRecoveryActionService>["upsertSourceScoped"]>[0]> = {}) {
    return issueRecoveryActionService(writer).upsertSourceScoped({ companyId, sourceIssueId: binding.issueId,
      kind: "active_run_watchdog", ownerType: "system", cause: "native_workspace_sync_out_failed",
      fingerprint: binding.runId, evidence: { runId: binding.runId }, nextAction: "Retry finalization",
      wakePolicy: { kind: "resume_native_run", runId: binding.runId }, ...patch });
  }
  async function action(id: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).then(rows => rows[0]);
  }
  it("reconstructs pending notices and leaves resolved history quiet across restart", async () => {
    const binding = await committed(); const pending = await notice(binding);
    await start(); await flush(); expect(await action(pending.id)).toMatchObject({ status: "resolved", outcome: "restored" });
    await quiet(); const settled = await action(pending.id);
    await coordinator!.stop(); await start(); await flush(); await quiet(); expect(await action(pending.id)).toEqual(settled);
  });
  it("ignores routine company-only finalization hints and still resolves a real notice", async () => {
    await start(); await flush(); await quiet();
    const previous = db.$client.options.debug;
    const queries: string[] = [];
    db.$client.options.debug = (_id, query) => {
      if (/from\s+"native_run_finalizations"/i.test(query)) queries.push(query);
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        await db.transaction(async tx => { await notifyNativeFinalizationWork(tx, { companyId }); });
        await flush();
      }
      expect(queries).toEqual([]);
    } finally { db.$client.options.debug = previous; }
    const binding = await committed();
    const pending = await notice(binding); await flush();
    expect(await action(pending.id)).toMatchObject({ status: "resolved", outcome: "restored" });
    await quiet();
  });

  it("wakes from a real notice created after startup is quiet", async () => {
    const binding = await committed(); await start(); await flush(); await quiet();
    const pending = await notice(binding); await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it.each(["commit", "rollback"])("honors the notice writer's outer %s", async outcome => {
    const binding = await committed(); await start(); await flush();
    let actionId = "";
    const transaction = db.transaction(async tx => {
      actionId = (await notice(binding, tx as unknown as Db)).id;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await action(actionId)).toBeUndefined();
      if (outcome === "rollback") throw new Error("rollback notice");
    });
    if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback notice"); else await transaction;
    await flush();
    if (outcome === "rollback") expect(await action(actionId)).toBeUndefined();
    else expect((await action(actionId)).status).toBe("resolved");
    await quiet();
  });
  it("wakes when the real finalizer commits after a notice was already present", async () => {
    const binding = await accepted(); const pending = await notice(binding);
    await start(); await flush(); await quiet();
    await finalizeNativeRun({ db, runId: binding.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
      skipNativeRecoveryNotices: true });
    await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("preserves a notice rebound to a new run after discovery", async () => {
    const binding = await committed(); const pending = await notice(binding);
    const differentRun = randomUUID();
    const resolve: typeof resolveCommittedNativeRecoveryNotices = async (database, scope, settled) => {
      const updated = await notice({ ...binding, runId: differentRun }); expect(updated.id).toBe(pending.id);
      await resolveCommittedNativeRecoveryNotices(database, scope, settled);
    };
    await start(resolve); await flush();
    expect(await action(pending.id)).toMatchObject({ status: "active", evidence: { runId: differentRun } }); await quiet();
  });
  it("does not wake for an already-resolved notice", async () => {
    const binding = await committed(); const pending = await notice(binding);
    await start(); await flush();
    const queries: string[] = []; const previous = db.$client.options.debug;
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try {
      await issueRecoveryActionService(db).resolveActiveForIssue({ companyId, sourceIssueId: binding.issueId,
        actionId: pending.id, status: "resolved", outcome: "restored" });
      await flush();
      expect(queries.filter(query => query.includes('from "native_run_finalizations"'))).toEqual([]);
    } finally { db.$client.options.debug = previous; }
    await quiet();
  });
  it.each(["restore", "worktree"])("preserves %s suppression and settings activation", async mode => {
    const binding = await committed(); const pending = await notice(binding);
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "notice-suppression-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
      onError: error => errors.push(error) });
    worker = heartbeatService(db, { runtimeEnv }).registerNativeRecoveryNoticeWork(coordinator, () => admitted);
    await worker.ready; await flush(); await quiet(); expect((await action(pending.id)).status).toBe("active");
    if (mode === "worktree") {
      try { await settings.updateExperimental({ enableWorktreeRunExecution: true }); await flush();
        expect((await action(pending.id)).status).toBe("resolved"); await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
  });
  it("retains the first notice committed during drain", async () => {
    const binding = await committed(); await start(); await flush(); admitted = false;
    const pending = await notice(binding); await vi.advanceTimersByTimeAsync(120_000); await quiet();
    expect((await action(pending.id)).status).toBe("active"); admitted = true;
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("retains a real failure retry through drain and restart", async () => {
    const binding = await committed(); const pending = await notice(binding);
    const resolve: typeof resolveCommittedNativeRecoveryNotices = async () => { throw new Error("notice unavailable"); };
    await start(resolve); expect(errors).toHaveLength(1); errors.length = 0;
    expect(coordinator!.nextWakeAt()).not.toBeNull(); admitted = false;
    await vi.advanceTimersByTimeAsync(120_000); await quiet(); expect((await action(pending.id)).status).toBe("active");
    await coordinator!.stop(); admitted = true; await start(); await flush();
    expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("joins in-flight resolution on shutdown and reconstructs later notices", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const entered = vi.fn();
    const resolve: typeof resolveCommittedNativeRecoveryNotices = async (...args) => {
      entered(); await gate; return resolveCommittedNativeRecoveryNotices(...args);
    };
    const first = await committed(); const second = await committed(); await start(resolve); await flush();
    const pending = await notice(first);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(entered).toHaveBeenCalledTimes(1); });
    const later = await notice(second); let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await delay(20); expect(stopped).toBe(false); release(); await stopping;
    expect((await action(pending.id)).status).toBe("resolved"); expect((await action(later.id)).status).toBe("active");
    await start(); await flush(); expect((await action(later.id)).status).toBe("resolved"); await quiet();
  });
  it("waits for real pending-effect settlement", async () => {
    const binding = await committed(); const pending = await notice(binding); const current = await state(binding.runId);
    const [effect] = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, current.decisionId!));
    expect(effect).toBeDefined();
    await db.update(statusDecisionEffects).set({ deliveryState: "pending", deliveredAt: null }).where(eq(statusDecisionEffects.id, effect.id));
    await start(); await flush(); await quiet(); expect((await action(pending.id)).status).toBe("active");
    await statusCommitter.dispatchPendingNativeStatusEffects({ db, ...binding, decisionId: current.decisionId!, onlyWhenDue: true });
    await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("waits for projection and wakes from the real projection owner", async () => {
    const binding = await committed(); const pending = await notice(binding);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, binding.runId));
    await start(); await flush(); await quiet(); expect((await action(pending.id)).status).toBe("active");
    await projectCommittedRun({ db, run: await read(binding.runId), coordinator: await state(binding.runId) });
    await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("wakes after the real lifecycle writer releases an ownership hold", async () => {
    const binding = await committed(); const pending = await notice(binding);
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" })
      .where(eq(heartbeatRuns.id, binding.runId));
    await start(); await flush(); await quiet(); expect((await action(pending.id)).status).toBe("active");
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    await lifecycle.setRunStatus(binding.runId, "succeeded", { nativePhase: "committed", errorCode: null });
    await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it.each([
    { delegated: false, alreadyCommitted: false }, { delegated: true, alreadyCommitted: false },
    { delegated: false, alreadyCommitted: true }, { delegated: true, alreadyCommitted: true },
  ])("preserves resource settlement while delegating external assignments: %j", async ({ delegated, alreadyCommitted }) => {
    const binding = await (alreadyCommitted ? committed() : accepted());
    const settleAssignment = vi.spyOn(museTerminal, "reconcileMuseNativeTerminalRun");
    const settled = vi.fn(async () => undefined);
    await reconcileNativeFinalizations(db, [binding.runId], {
      skipExternalAgentSettlement: delegated,
      skipExternalConversationSettlement: true, skipNativeRecoveryNotices: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, onWorkspaceSettled: settled,
    });
    expect(settleAssignment).toHaveBeenCalledTimes(delegated ? 0 : 1);
    if (!delegated) expect(settleAssignment).toHaveBeenCalledWith(db, expect.objectContaining({ id: binding.runId, companyId }));
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ runId: binding.runId, succeeded: true }));
  });
  it.each([true, false])("preserves resource settlement while delegating conversations: %s", async delegated => {
    const binding = await committed();
    const settleConversation = vi.spyOn(conversationLifecycle, "settleExternalConversation");
    const settled = vi.fn(async () => undefined);
    await reconcileNativeFinalizations(db, [binding.runId], {
      skipExternalConversationSettlement: delegated,
      skipNativeRecoveryNotices: true, skipNativeResponsePresentation: true,
      skipNativeReviewResponse: true, onWorkspaceSettled: settled,
    });
    expect(settleConversation).toHaveBeenCalledTimes(delegated ? 0 : 1);
    if (!delegated) expect(settleConversation).toHaveBeenCalledWith(db, companyId, binding.issueId);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ runId: binding.runId, succeeded: true }));
  });
  it("delegates only notice repair and preserves periodic resource settlement", async () => {
    const binding = await committed(); const pending = await notice(binding); const settled = vi.fn(async () => undefined);
    await reconcileNativeFinalizations(db, [binding.runId], { skipNativeRecoveryNotices: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, onWorkspaceSettled: settled });
    expect((await action(pending.id)).status).toBe("active"); expect(settled).toHaveBeenCalledTimes(1);
    await start(); await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it.each(["wakePolicy", "kind"])("activates an existing notice after only its %s changes", async field => {
    const binding = await committed();
    const pending = await notice(binding, db, field === "kind" ? { kind: "missing_disposition" } : { wakePolicy: null });
    await start(); await flush(); await quiet(); expect((await action(pending.id)).status).toBe("active");
    const updated = await notice(binding); expect(updated.id).toBe(pending.id);
    await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("resolves the escalated owner-verification notice without a retry policy", async () => {
    const binding = await committed();
    const pending = await notice(binding, db, { cause: "native_workspace_finalization_owner_unverified", maxAttempts: 1 });
    await notice(binding, db, { cause: "native_workspace_finalization_owner_unverified", maxAttempts: 1 });
    expect(await action(pending.id)).toMatchObject({ status: "escalated", wakePolicy: null });
    await start(); await flush(); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("wakes for a new identity while preserving the superseded notice", async () => {
    const binding = await committed(); const old = await notice({ ...binding, runId: randomUUID() });
    await start(); await flush(); await quiet();
    const pending = await notice(binding, db, { supersedeOnIdentityChange: true });
    expect(pending.id).not.toBe(old.id); await flush();
    expect((await action(old.id)).status).toBe("cancelled"); expect((await action(pending.id)).status).toBe("resolved"); await quiet();
  });
  it("writes a resolution once across competing live/recovery owners", async () => {
    const binding = await committed(); const pending = await notice(binding);
    const queries: string[] = []; const previous = db.$client.options.debug;
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try {
      await Promise.all(Array.from({ length: 4 }, () => resolveCommittedNativeRecoveryNotices(db, binding, true)));
      expect(queries.filter(query => query.startsWith('update "issue_recovery_actions"'))).toHaveLength(1);
    } finally { db.$client.options.debug = previous; }
    expect((await action(pending.id)).status).toBe("resolved");
  });
  it("rechecks the action after waiting for the run lock", async () => {
    const binding = await committed(); const pending = await notice(binding);
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId)).for("update");
      locked(); await gate;
    });
    await ready;
    let waiting = false; const previous = db.$client.options.debug;
    db.$client.options.debug = (_id, query) => { if (query.includes('from "heartbeat_runs"') && query.includes('for update')) waiting = true; };
    const resolving = resolveCommittedNativeRecoveryNotices(db, binding, true);
    const replacementRun = randomUUID();
    try {
      await vi.waitFor(() => { expect(waiting).toBe(true); });
      const updated = await notice({ ...binding, runId: replacementRun }); expect(updated.id).toBe(pending.id);
    } finally { release(); db.$client.options.debug = previous; await holding; await resolving; }
    expect(await action(pending.id)).toMatchObject({ status: "active", evidence: { runId: replacementRun } });
  });
});
