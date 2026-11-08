import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeSha256 } from "./canonical.js";
import { resumeNativeWorkspaceAfterOwnerStop } from "./native-workspace-owner-recovery.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { copybackOwnerOnAnotherHost, proveCopybackOwnerGone, proveLocalWorkspaceOwnerStopped } from "./native-workspace-owner-stop-proof.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, SystemRecoveryFailure } from "../system-recovery-state.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../recovery/ownership-registry.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  describe("shared owner proof (plan Phase 2)", () => {
    it("records its PID space on the copyback owner receipt", async () => {
      const seed = await seedAbandonedCopyback();
      await db.update(heartbeatRuns).set({ runnerProfileJson: { preserved: "workspace descriptor" } }).where(eq(heartbeatRuns.id, seed.runId));
      let receipt: Record<string, unknown> | undefined;
      expect(await withNativeWorkspaceFinalizationOwnership(seed, async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
        receipt = run.runnerProfileJson?.nativeWorkspaceFinalizationOwner as Record<string, unknown>;
        return "copied";
      })).toEqual({ acquired: true, value: "copied" });
      expect(receipt).toMatchObject({ hostname: os.hostname(), pid: process.pid, hostHash: currentProcessSpaceHash() });
    });

    it("never judges a receipt from another PID space by this host's PIDs, even under the same hostname", async () => {
      const seed = await seedAbandonedCopyback();
      // Same hostname (a container sharing it), but another PID namespace: the
      // dead PID here says nothing about the owner there.
      const { owner } = await killedControllerOwner({ orphanChild: false });
      const foreign = { ...owner, hostHash: "another-pid-namespace" };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: foreign } }).where(eq(heartbeatRuns.id, seed.runId));
      const work = vi.fn(async () => "must not run");
      expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "owner_unverified" });
      expect(work).not.toHaveBeenCalled();
      expect(await proveLocalWorkspaceOwnerStopped({ owner: foreign, identity: await currentNativeControllerIdentity() }))
        .toEqual({ status: "unsupported", reason: "foreign_host" });
      // The board can still attest the stop of an owner it cannot observe here.
      const current = await issueRecoveryActionService(db).getActiveForIssue(companyId, seed.issueId);
      await resumeNativeWorkspaceAfterOwnerStop({ ...seed, actionId: current!.id, ownerToken: foreign.token });
    });

    it("proves a stamped owner in this PID space gone and resumes copyback", async () => {
      const seed = await seedAbandonedCopyback();
      const { owner } = await killedControllerOwner({ orphanChild: false });
      const stamped = { ...owner, hostHash: currentProcessSpaceHash() };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: stamped } }).where(eq(heartbeatRuns.id, seed.runId));
      expect(await withNativeWorkspaceFinalizationOwnership(seed, async () => "resumed")).toEqual({ acquired: true, value: "resumed" });
    });

    it("judges the RC-50 hold's owner on the shared path and wakes its waiting recheck", async () => {
      const seed = await seedAbandonedCopyback();
      const { owner } = await killedControllerOwner({ orphanChild: false });
      const stamped = { ...owner, hostHash: currentProcessSpaceHash() };
      const waiting = failSystemRecovery(createSystemRecovery(seed.runId),
        new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence"));
      expect(waiting).toMatchObject({ state: "awaiting_evidence" });
      expect(waiting.nextAttemptAt!).toBeGreaterThan(Date.now());
      await db.update(issueRecoveryActions).set({ status: "active", evidence: { runId: seed.runId, systemRecovery: waiting,
        workspaceOwnerRecovery: { state: "operator_required", owner: stamped } } }).where(eq(issueRecoveryActions.id, seed.actionId));
      const kind = OWNABLE_KINDS.find(entry => entry.id === "copyback_owner_hold")!;
      const records = (await kind.listInProgress!(db, 500, 0)).records.filter(record => record.recordId === seed.actionId);
      expect(records).toHaveLength(1);

      const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), kinds: [kind] });
      expect(report.kinds[0]!.reasons.pid_dead).toBeGreaterThanOrEqual(1);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
      const woken = readSystemRecovery(action.evidence)!;
      // Due now; no attempt granted, and the hold itself stays for the worker.
      expect(woken.nextAttemptAt!).toBeLessThanOrEqual(Date.now());
      expect(woken).toMatchObject({ attempts: waiting.attempts, retriesUsed: waiting.retriesUsed, state: "awaiting_evidence" });
      expect(action.evidence?.workspaceOwnerRecovery).toMatchObject({ state: "operator_required" });

      // A receipt with no PID space stays unprovable and is never woken.
      const legacySeed = await seedAbandonedCopyback();
      await db.update(issueRecoveryActions).set({ status: "active", evidence: { runId: legacySeed.runId, systemRecovery:
        failSystemRecovery(createSystemRecovery(legacySeed.runId), new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence")),
        workspaceOwnerRecovery: { state: "operator_required", owner } } }).where(eq(issueRecoveryActions.id, legacySeed.actionId));
      const [record] = (await kind.listInProgress!(db, 500, 0)).records.filter(entry => entry.recordId === legacySeed.actionId);
      expect(record!.owner).toMatchObject({ kind: "process", stamp: { processSpace: null } });

      // A hold whose recheck no longer waits (exhausted) is the board's: still
      // listed, but the reconciler keeps no settle watch on it.
      const before = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), kinds: [kind] });
      const exhaustedSeed = await seedAbandonedCopyback();
      const { owner: exhaustedOwner } = await killedControllerOwner({ orphanChild: false });
      await db.update(issueRecoveryActions).set({ status: "active", evidence: { runId: exhaustedSeed.runId,
        systemRecovery: { ...failSystemRecovery(createSystemRecovery(exhaustedSeed.runId),
          new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence")), state: "exhausted", nextAttemptAt: null },
        workspaceOwnerRecovery: { state: "operator_required", owner: { ...exhaustedOwner, hostHash: currentProcessSpaceHash() } } } })
        .where(eq(issueRecoveryActions.id, exhaustedSeed.actionId));
      const after = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), kinds: [kind] });
      expect(after.kinds[0]!.inProgress).toBe(before.kinds[0]!.inProgress + 1);
      expect(after.kinds[0]!.reasons.pid_dead).toBe((before.kinds[0]!.reasons.pid_dead ?? 0) + 1);
      expect(after.settleWatch).toBe(before.settleWatch);
    });

    it("lets the board attest an owner on another hostname even when its PID space is unreadable", async () => {
      const proof = await proveCopybackOwnerGone({ hostname: "another-host", pid: 4_194_303,
        processStartedAt: new Date(0).toISOString(), hostHash: "unknown" });
      expect(proof).toMatchObject({ verdict: "unprovable", reason: "different_host" });
      expect(copybackOwnerOnAnotherHost(proof)).toBe(true);
    });

    it("never treats an unreadable local PID space as an owner on another host", () => {
      expect(copybackOwnerOnAnotherHost({ verdict: "unprovable", reason: "unknown_process_space" })).toBe(false);
      expect(copybackOwnerOnAnotherHost({ verdict: "unprovable", reason: "different_process_space" })).toBe(true);
    });
  });

  // Staging 2026-11-07: a deploy restarted the server while three accepted
  // results were being saved. The receipts name the previous Railway deployment
  // on another container (e2d490c61 shape). A volume-backed service cannot run
  // two deployments at once, so this server running on a newer deployment of the
  // same service proves the previous one, and all its copyback children, exited.
  describe("after a deploy on a volume-backed service", () => {
    const worker = { provider: "railway" as const, projectId: randomUUID(), environmentId: randomUUID(),
      serviceId: randomUUID(), deploymentId: randomUUID() };
    function currentDeployment(overrides: Partial<Record<string, string>> = {}) {
      const env = { RAILWAY_PROJECT_ID: worker.projectId, RAILWAY_ENVIRONMENT_ID: worker.environmentId,
        RAILWAY_SERVICE_ID: worker.serviceId, RAILWAY_DEPLOYMENT_ID: randomUUID(),
        RAILWAY_VOLUME_ID: randomUUID(), RAILWAY_VOLUME_MOUNT_PATH: "/paperclip", ...overrides };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value ?? "");
    }
    afterEach(() => vi.unstubAllEnvs());

    async function previousDeploymentOwner() {
      const seed = await seedAbandonedCopyback();
      const owner = { pid: 3, token: randomUUID(), worker, hostname: "3f58b3426ddc",
        controllerBootId: randomUUID(), processStartedAt: "2026-11-07T16:32:33.070Z" };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner, preserved: "workspace descriptor" } })
        .where(eq(heartbeatRuns.id, seed.runId));
      await db.update(issueRecoveryActions).set({ fingerprint: nativeSha256({ runId: seed.runId, owner }),
        evidence: { runId: seed.runId, owner, workspaceOwnerRecovery: { state: "operator_required" } } })
        .where(eq(issueRecoveryActions.id, seed.actionId));
      return { ...seed, owner };
    }

    it("resumes the interrupted save automatically, with no board action", async () => {
      currentDeployment();
      const seed = await previousDeploymentOwner();
      const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
      const work = vi.fn(async () => {
        const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
        expect(recovery.evidence?.workspaceOwnerRecovery).toEqual({ state: "resuming" });
        expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", userAction: null });
        return "saved workspace copied";
      });
      expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: true, value: "saved workspace copied" });
      expect(work).toHaveBeenCalledOnce();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
      expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
      expect(run.runnerProfileJson?.preserved).toBe("workspace descriptor");
      const verified = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seed.issueId),
        eq(activityLog.action, "issue.workspace_owner_stop_verified")));
      expect(verified).toHaveLength(1);
      expect(verified[0].details).toMatchObject({ deploymentProof: { reason: "deployment_replaced",
        previousDeploymentId: worker.deploymentId } });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    });

    it("records the volume on a new receipt only when the volume is fully configured", async () => {
      const seed = await seedAbandonedCopyback();
      await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, seed.runId));
      currentDeployment({ RAILWAY_VOLUME_ID: "half-configured", RAILWAY_VOLUME_MOUNT_PATH: "" });
      let recorded: Record<string, unknown> | undefined;
      await withNativeWorkspaceFinalizationOwnership(seed, async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
        recorded = run.runnerProfileJson?.nativeWorkspaceFinalizationOwner as Record<string, unknown>;
      });
      expect(recorded).toBeDefined();
      expect(recorded!.volumeId).toBeUndefined();
      expect(recorded!.exclusiveVolume).toBe(false);
      await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, seed.runId));
      currentDeployment({ RAILWAY_VOLUME_ID: "mounted-volume" });
      await withNativeWorkspaceFinalizationOwnership(seed, async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
        recorded = run.runnerProfileJson?.nativeWorkspaceFinalizationOwner as Record<string, unknown>;
      });
      expect(recorded!.volumeId).toBe("mounted-volume");
      expect(recorded!.exclusiveVolume).toBe(true);
    });

    it("keeps a receipt from a deployment that was not volume-exclusive fenced", async () => {
      currentDeployment();
      const seed = await previousDeploymentOwner();
      const owner = { ...seed.owner, exclusiveVolume: false };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } })
        .where(eq(heartbeatRuns.id, seed.runId));
      const work = vi.fn(async () => "second physical writer");
      expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "owner_unverified" });
      expect(work).not.toHaveBeenCalled();
    });

    it("keeps the save fenced when the receipt names a different volume", async () => {
      currentDeployment();
      const seed = await previousDeploymentOwner();
      const owner = { ...seed.owner, volumeId: randomUUID() };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } })
        .where(eq(heartbeatRuns.id, seed.runId));
      const work = vi.fn(async () => "second physical writer");
      expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "owner_unverified" });
      expect(work).not.toHaveBeenCalled();
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, seed.issueId),
        eq(issueRecoveryActions.fingerprint, nativeSha256({ runId: seed.runId, owner }))));
      expect(action.nextAction).toContain("Resume saved result");
      expect(action.nextAction).not.toMatch(/\bverify\b|\binspect\b/i);
    });

    it.each([
      ["the same deployment", () => ({ RAILWAY_DEPLOYMENT_ID: worker.deploymentId })],
      ["a service without a volume", () => ({ RAILWAY_VOLUME_ID: "", RAILWAY_VOLUME_MOUNT_PATH: "" })],
      ["another service", () => ({ RAILWAY_SERVICE_ID: randomUUID() })],
      ["another environment", () => ({ RAILWAY_ENVIRONMENT_ID: randomUUID() })],
      ["a half-configured volume", () => ({ RAILWAY_VOLUME_MOUNT_PATH: "" })],
    ] as const)("keeps the save fenced on %s", async (_case, overrides) => {
      currentDeployment(overrides());
      const seed = await previousDeploymentOwner();
      const work = vi.fn(async () => "second physical writer");
      expect(await withNativeWorkspaceFinalizationOwnership(seed, work)).toEqual({ acquired: false, reason: "owner_unverified" });
      expect(work).not.toHaveBeenCalled();
    });
  });
});
