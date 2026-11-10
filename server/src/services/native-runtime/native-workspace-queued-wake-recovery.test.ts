import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { nativeSha256 } from "./canonical.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { resumeNativeWorkspaceAfterOwnerStop } from "./native-workspace-owner-recovery.js";
import * as platformProof from "./native-workspace-platform-proof.js";

// A user's answer queues the assignee's next wake behind the saved run's
// execution lock. Recovery of that saved run must not wait for the wake.
describe("native workspace recovery with a queued answer wake", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let workspaceRoot: string;
  let priorLogRoot: string | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-queued-wake-recovery-"));
    priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(workspaceRoot, "operation-logs");
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_WORKSPACE_FINALIZER_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-queued-wake-recovery-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
    await db.insert(companies).values({ id: companyId, name: "Queued wake recovery", issuePrefix: "QWR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native workspace agent", adapterType: "paperclip_runner", status: "running" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Native workspace project", status: "active" });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
  });

  async function seedAbandonedCopyback() {
    const issueId = randomUUID(), contractId = randomUUID(), runId = randomUUID(), resultId = randomUUID();
    const worker = { provider: "railway" as const, projectId: "p", environmentId: "e", serviceId: "s", deploymentId: "d" };
    const owner = { token: randomUUID(), hostname: "replaced-controller", pid: 2,
      processStartedAt: "2026-10-10T00:02:55.560Z", controllerBootId: randomUUID(), worker };
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved copyback with an answer wake",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "native-queued-wake-recovery-test-v1",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Saved copyback" }, canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativePhase: "workspace_finalizing", completionContractId: contractId,
      runnerProfileJson: { nativeExecutionInput: { binding: { executionWorkspaceId: randomUUID() } },
        nativeWorkspaceFinalizationOwner: owner } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `result-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `result-${resultId}` });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "workspace_finalizing", resultId });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "native_workspace_finalization_owner_unverified",
      fingerprint: nativeSha256({ runId, owner }), evidence: { runId, owner }, maxAttempts: 1,
      nextAction: "Verify the previous controller and its workspace-copyback processes have stopped." });
    return { companyId, db, issueId, runId, owner, actionId: action.id, ownerToken: owner.token, actorId: "operator",
      controllerAndCopybackStopped: true as const,
      stopEvidence: "Deployment platform confirms the exact old container and all its processes exited." };
  }

  async function queueAnswerWake(seed: { runId: string; issueId: string }, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    const [wake] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", status: "queued",
      contextSnapshot: { issueId: seed.issueId, wakeReason: "ask_user_questions.answered" },
      createdAt: new Date(run.createdAt.getTime() + 60_000), ...values }).returning();
    return wake;
  }

  function proveStopped(seed: Awaited<ReturnType<typeof seedAbandonedCopyback>>) {
    return vi.spyOn(platformProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({ status: "verified", proof: {
      v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "stack", runId: seed.runId,
      ownerToken: seed.owner.token, worker: seed.owner.worker, stopped: true, iat: 1, exp: 61 } });
  }

  it("confirms owner recovery while the answer wake waits", async () => {
    const seed = await seedAbandonedCopyback();
    await queueAnswerWake(seed);
    await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).resolves.toMatchObject({ runId: seed.runId, status: "queued" });
  });

  it.each(["still queued", "starts during copyback"] as const)("adopts a proven stopped deployment behind the answer wake: %s", async state => {
    const seed = await seedAbandonedCopyback();
    const wake = await queueAnswerWake(seed);
    const probe = proveStopped(seed);
    const write = vi.fn();
    try {
      const copyback = withNativeWorkspaceFinalizationOwnership(seed, async ownership => {
        if (state === "starts during copyback") await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, wake.id));
        await ownership.assertHeld();
        write();
        return "saved workspace copied";
      });
      if (state === "still queued") expect(await copyback).toEqual({ acquired: true, value: "saved workspace copied" });
      else await expect(copyback).rejects.toThrow("native_workspace_finalization_ownership_lost");
      expect(write).toHaveBeenCalledTimes(state === "still queued" ? 1 : 0);
    } finally { probe.mockRestore(); }
  });

  // These runs have started, or can start without the saved run's execution lock.
  it.each(["requeued started wake", "recovery action wake", "other agent's queued run"])("keeps the takeover fenced for %s", async changed => {
    const seed = await seedAbandonedCopyback();
    if (changed === "requeued started wake") await queueAnswerWake(seed, { startedAt: new Date() });
    if (changed === "recovery action wake") await queueAnswerWake(seed, { contextSnapshot: { issueId: seed.issueId, wakeReason: "source_scoped_recovery_action" } });
    if (changed === "other agent's queued run") {
      const [other] = await db.insert(agents).values({ companyId, name: "Mentioned agent", adapterType: "paperclip_runner", status: "running" }).returning();
      await queueAnswerWake(seed, { agentId: other.id });
    }
    const probe = proveStopped(seed);
    const copyback = vi.fn();
    try {
      expect(await withNativeWorkspaceFinalizationOwnership(seed, copyback)).toEqual({ acquired: false, reason: "binding_changed" });
      expect(copyback).not.toHaveBeenCalled();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
      expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(seed.owner);
    } finally { probe.mockRestore(); }
  });

  it("commits a retried copyback from a stopped deployment while the answer wake waits", async () => {
    const seed = await seedAbandonedCopyback();
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      nextAttemptAt: new Date(Date.now() - 60_000), failureCode: "native_workspace_sync_out_failed",
    }).where(eq(nativeRunFinalizations.runId, seed.runId));
    await db.update(heartbeatRuns).set({ nativePhase: "retryable_failure" }).where(eq(heartbeatRuns.id, seed.runId));
    const workspaceId = randomUUID(), cwd = path.join(workspaceRoot, seed.runId);
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "accepted work");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, mode: "local", strategyType: "local_directory", name: "Retained workspace", cwd });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, seed.issueId));
    await db.update(nativeRunResults).set({ resultJson: {
      result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Wait for the answer.",
        completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [],
          remainingWork: [{ description: "Continue after the answer.", blocksCompletion: true }] },
        continuation: { kind: "response_wake", summary: "Wait for the answer.", idempotencyKey: "saved-wait" },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed",
        runTerminalState: "succeeded", reportedWorkDisposition: "yielded" },
    } }).where(eq(nativeRunResults.runId, seed.runId));
    const wake = await queueAnswerWake(seed);
    const probe = proveStopped(seed);
    try { await reconcileNativeFinalizations(db, [seed.runId]); } finally { probe.mockRestore(); }
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId)))[0].phase).toBe("committed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)))[0]).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, seed.runId),
      eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded")))).toHaveLength(1);
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("accepted work");
    // The saved run is terminal, so the wake's execution claim is no longer blocked.
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
  });
});
