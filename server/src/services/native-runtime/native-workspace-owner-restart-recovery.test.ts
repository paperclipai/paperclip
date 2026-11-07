import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeSha256 } from "./canonical.js";
import { resumeNativeWorkspaceAfterOwnerStop } from "./native-workspace-owner-recovery.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, agents, companies, completionContracts, createDb, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";

// RC-47: a control-plane restart kills the controller mid-copyback, before the
// completed-copyback barrier exists. The dead controller can never confirm its
// own stop. Same-host process evidence releases it; otherwise the task names
// one board action instead of a silent `running`.
describe("native workspace owner recovery after a restart", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let workspaceRoot: string;
  let priorLogRoot: string | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-owner-restart-"));
    priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(workspaceRoot, "operation-logs");
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_WORKSPACE_FINALIZER_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-owner-restart-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
    await db.insert(companies).values({ id: companyId, name: "Native owner restart", issuePrefix: "NOR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native owner agent", adapterType: "paperclip_runner", status: "running" });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
  });

  /** An accepted result whose copyback was abandoned by a recorded owner. */
  async function seedAbandonedCopyback() {
    const issueId = randomUUID(), contractId = randomUUID(), runId = randomUUID(), resultId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Accepted yield, abandoned copyback",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "native-owner-restart-test-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "copyback" }, canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system", createdByActorId: "test" });
    const owner = { token: randomUUID(), hostname: "replaced-controller", pid: 2,
      processStartedAt: "2026-10-10T00:02:55.560Z", controllerBootId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, completionContractId: contractId, nativePhase: "workspace_finalizing",
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner, preserved: "workspace descriptor",
        nativeExecutionInput: { binding: { executionWorkspaceId: randomUUID() } } } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `result-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `result-${resultId}` });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "workspace_finalizing", resultId });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "native_workspace_finalization_owner_unverified",
      fingerprint: nativeSha256({ runId, owner }), evidence: { runId, owner }, maxAttempts: 1,
      nextAction: "Verify the previous controller and its workspace-copyback processes have stopped." });
    return { issueId, runId, owner, actionId: action.id, companyId, db, ownerToken: owner.token,
      actorId: "operator", controllerAndCopybackStopped: true as const,
      stopEvidence: "Deployment platform confirms the exact old container and all its processes exited." };
  }

  async function killedControllerOwner(input: { orphanChild: boolean }) {
    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = input.orphanChild
      ? `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio:'ignore'}); console.log(child.pid); setInterval(() => {}, 1000);`
      : "console.log(0); setInterval(() => {}, 1000);";
    // The controller leads its own process group, as the restart supervisor runs it.
    const parent = spawn(process.execPath, ["-e", parentScript], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const [chunk] = await once(parent.stdout!, "data");
    const childPid = Number(String(chunk).trim());
    const startedAt = await readProcessStartedAt(parent.pid!);
    const exited = once(parent, "close");
    parent.kill("SIGKILL"); await exited;
    const owner = { token: randomUUID(), hostname: os.hostname(), pid: parent.pid!, processGroupId: parent.pid!,
      processStartedAt: startedAt!, controllerBootId: randomUUID() };
    return { owner, childPid: childPid > 0 ? childPid : null };
  }

  it("automatically resumes interrupted copyback after this host's previous controller and its process group stopped", async () => {
    const seed = await seedAbandonedCopyback();
    const { owner } = await killedControllerOwner({ orphanChild: false });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner, preserved: "workspace descriptor" } }).where(eq(heartbeatRuns.id, seed.runId));
    await db.update(issueRecoveryActions).set({ fingerprint: nativeSha256({ runId: seed.runId, owner }), evidence: { runId: seed.runId, owner, workspaceOwnerRecovery: { state: "operator_required" } } }).where(eq(issueRecoveryActions.id, seed.actionId));
    const work = vi.fn(async () => {
      const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
      expect(recovery.evidence?.workspaceOwnerRecovery).toEqual({ state: "resuming" });
      return "saved workspace copied";
    });
    expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: true, value: "saved workspace copied" });
    expect(work).toHaveBeenCalledOnce();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
    expect(run.runnerProfileJson?.preserved).toBe("workspace descriptor");
    const verified = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seed.issueId), eq(activityLog.action, "issue.workspace_owner_stop_verified")));
    expect(verified).toHaveLength(1);
    expect(verified[0].details).toMatchObject({ localProof: { pid: owner.pid, processGroupId: owner.processGroupId } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
  });

  it("does not let a locally proven stop restore files for a task that moved on", async () => {
    const seed = await seedAbandonedCopyback();
    const { owner } = await killedControllerOwner({ orphanChild: false });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, seed.runId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", startedAt: new Date(), nativeIssueId: seed.issueId });
    const work = vi.fn(async () => "stale restore");
    expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "binding_changed" });
    expect(work).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);
  });

  it("keeps copyback fenced while an orphaned child of this host's dead controller still runs", async () => {
    const seeded = await seedAbandonedCopyback();
    const { owner, childPid } = await killedControllerOwner({ orphanChild: true });
    expect(childPid).toBeGreaterThan(0);
    try {
      process.kill(childPid!, 0); // The copyback child outlived its controller.
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, seeded.runId));
      const work = vi.fn(async () => "second physical writer");
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, work))
        .toEqual({ acquired: false, reason: "local_stop_pending" });
      expect(work).not.toHaveBeenCalled();
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
      expect(action).toMatchObject({ ownerType: "board", cause: "native_workspace_finalization_owner_unverified" });
      process.kill(childPid!, "SIGKILL");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { process.kill(childPid!, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { break; }
      }
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => "resumed"))
        .toEqual({ acquired: true, value: "resumed" });
    } finally {
      try { process.kill(childPid!, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it("shows one board action for a previous server on another host, and clears it once confirmed", async () => {
    const seed = await seedAbandonedCopyback();
    const work = vi.fn(async () => "must not run");
    expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "owner_unverified" });
    expect(work).not.toHaveBeenCalled();
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    // The fenced run is still `running`; the task must not present it as working.
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({
      responsibility: "user", state: "waiting_for_user", userAction: "confirm_owner_stop", observedRunId: seed.runId });
    await resumeNativeWorkspaceAfterOwnerStop(seed);
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working", userAction: null });
  });

  it("requires the board confirmation for a dead controller recorded without its process group", async () => {
    const seeded = await seedAbandonedCopyback();
    const { owner } = await killedControllerOwner({ orphanChild: false });
    const { processGroupId: _omitted, ...legacy } = owner;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: legacy } }).where(eq(heartbeatRuns.id, seeded.runId));
    expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => "must not run"))
      .toEqual({ acquired: false, reason: "owner_unverified" });
  });
});
