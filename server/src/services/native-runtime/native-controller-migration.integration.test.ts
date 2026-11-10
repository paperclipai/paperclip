import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, environmentLeases, environments, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, DurablePrpControlPlane, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import * as sessionResume from "./native-session-resume.js";
import { nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { hasLocalNativeControllerObligations, migrateNativeControllers, prestageNativeControllers } from "./native-controller-migration.js";
import { insertMigratedNativeRunnerCheckpoint, loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { createNativeControllerRecovery, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { resolveRemoteProviderPackAuthority } from "./remote-provider-pack-authority.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";
import { createReusableLeaseHandoff } from "../environment-lease-handoff.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { nativeSha256 } from "./canonical.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { legacyNativeControllerArchive } from "./native-controller-archive.js";
import { restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";

describeEmbeddedPostgres.each(["archive_online", "archive_online_owned", "archive_online_changed", "archive_online_commit", "archive_online_active", "archive_online_foreign",
  "active_warm", "source_scan", "active_durable", "online_success", "online_owned", "online_same_source", "online_busy", "online_changed", "online_evidence", "import", "archive", "success", "batch", "durable_failed", "durable_inline_failed",
  "stale_confirmed", "stale_foreign", "stale_changed", "stale_queued", "stale_overlap", "stale_success", "stale_busy", "stale_durable", "stale_durable_absent",
  "stale_durable_runner", "stale_durable_session", "stale_durable_snapshot",
  "controller_confirmed", "controller_foreign", "controller_thread", "controller_runner", "controller_success", "controller_busy", "controller_invalid", "controller_durable",
  "controller_observed_stopped", "controller_observed_stop_before_finish", "controller_observed_missing", "controller_observed_foreign",
  "controller_observed_live", "controller_observed_result", "controller_observed_retry", "controller_observed_task", "controller_observed_old_receipt", "controller_observed_revoked",
  "controller_observed_handoff", "controller_observed_handoff_stopped", "controller_observed_handoff_broken", "controller_observed_handoff_fork"])("offline native controller migration (%s)", scenario => {
  const environment = nativeRestartFixture();
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  async function fixture(commandCount = 1, warm = false, modernWorkspace = false) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "73".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, paperclipHome, runtimeRoot } = environment.current;
    const binding = { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: modernWorkspace ? randomUUID() : f.native.environmentLeaseId };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null }, binding,
      task: { identifier: "MIG-1", title: "Retained work", description: null, prompt: "Continue the work.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: warm ? { mode: "warm", idleTimeoutMs: 60_000 } : { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Save work." }] } },
      credentialBindings: [], interactionResponses: [],
    });
    const fingerprint = nativeToolContractFingerprintForTarget("remote", "codex");
    const paths = nativeControllerMigrationDescriptor(execution, fingerprint);
    const identity = { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId,
      environmentLeaseId: binding.executionWorkspaceId, turnId: f.native.turnId, itemId: f.native.itemId };
    const core = new DurablePrpControlPlane({ stateDirectory: join(paths.root, "control-plane"), identity,
      expectedRunnerVersion: "migration-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.issueBootstrapTicket();
    for (let index = 0; index < commandCount; index++) core.queueCommand("session.snapshot",
      { diagnostic: "x".repeat(commandCount > 1 ? 6000 : 0) }, `retained-command-${index}`);
    await core.stop();
    const file = join(paths.root, "control-plane/control-plane-state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.tickets = {};
    const source = JSON.stringify(state); await writeFile(file, source, { mode: 0o600 });
    const packBinding = { companyId, agentId, workspaceId: binding.executionWorkspaceId,
      sessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId,
      environmentLeaseId: f.native.environmentLeaseId, remoteCwd: "/remote/workspace", providerDigest: nativeSha256(execution.provider) };
    const payload = {
      runnerSourceRevision: "a".repeat(40), target: { platform: "linux", architecture: "x64" },
      pins: { opencode: "1.18.34" }, artifacts: {
        nodeCommand: { path: "node", sha256: `sha256:${"1".repeat(64)}` },
        opencodeCommand: { path: "opencode", sha256: `sha256:${"2".repeat(64)}` },
      },
    };
    const pack = resolveRemoteProviderPackAuthority({ stateDirectory: paths.root, reattach: false, binding: packBinding,
      current: () => ({ schema: "paperclip-runner/remote-provider-pack/v1", payload,
        digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` }),
      runnerArtifact: () => ({ version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` }) });
    pack.verified();
    const snapshot = { backendKind: "mock" as const, sessionId: f.native.normalizedSessionId,
      identity: { companyId, agentId, issueId: f.issueId, runId: f.runId, sessionId: f.native.normalizedSessionId } };
    const profile = { ...f.preparedProfile, nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint, sessionCheckpoint: snapshot,
      nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: binding.executionWorkspaceId, leaseId: randomUUID(),
        providerLeaseId: randomUUID(), remoteCwd: "/remote/workspace", resourceDisposition: "destroy" } };
    await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    const queuedId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: queuedId, companyId, agentId, issueId: f.issueId, status: "queued" });
    await f.db.update(issues).set({ executionRunId: queuedId }).where(eq(issues.id, f.issueId));
    const [session] = await f.db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner",
      taskKey: f.issueId, lastRunId: f.runId }).returning();
    return { ...f, companyId, agentId, paperclipHome, runtimeRoot, paths, file, source, profile, session, queuedId, identity, snapshot };
  }
  if (scenario === "active_warm") it("preserves an active warm rotation only with its exact older committed authority", async () => {
    const f = await fixture(0, true, true), controller = await currentNativeControllerIdentity();
    const binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const owner = { controllerBootId: controller.bootId, controllerGeneration: 1, leaseOwner: "warm-checkpoint-writer",
      leaseExpiresAt: new Date(Date.now() + 60_000), phase: "observed", resultId: null, failureCode: null, recoveryState: null } as const;
    await f.db.update(nativeRunFinalizations).set(owner).where(eq(nativeRunFinalizations.runId, f.runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(f.paths.root, "control-plane"), identity: f.identity,
      expectedRunnerVersion: "migration-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    let writer = nativeRunnerCheckpointWriter(f.db, { ...binding, bootId: controller.bootId, leaseOwner: owner.leaseOwner,
      generation: 1, authorityRunId: f.runId });
    core.setCheckpointPersistence(value => writer(value));
    try {
      await core.flushCheckpoint();
      const marker = await readFile(f.file, "utf8"), [prior] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ ...binding, completionContractId: prior.completionContractId!,
        serverFingerprint: "warm-source-result", schemaStatus: "accepted", resultJson: {}, canonicalSha256: nativeSha256({}) }).returning();
      const finishedAt = new Date();
      await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null,
        leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      const next = { ...f.identity, runId: randomUUID(), turnId: randomUUID(), itemId: randomUUID() };
      const execution = parseNativeExecutionInput({ ...f.profile.nativeExecutionInput,
        binding: { ...f.profile.nativeExecutionInput.binding, runId: next.runId } });
      const profile = { ...f.profile, nativeExecutionInput: execution, sessionCheckpoint: null };
      expect(nativeControllerMigrationDescriptor(execution, f.profile.nativeToolContractFingerprint).root).toBe(f.paths.root);
      await f.db.insert(heartbeatRuns).values({ id: next.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId,
        runtimeMode: "native", status: "running", nativePhase: "observed", processPid: process.pid, processStartedAt: new Date(),
        createdAt: new Date(finishedAt.getTime() + 1), startedAt: new Date(finishedAt.getTime() + 2), runnerProfileJson: profile,
        completionContractId: prior.completionContractId });
      await f.db.insert(nativeRunFinalizations).values({ ...owner, ...binding, runId: next.runId });
      await f.db.update(issues).set({ executionRunId: next.runId, checkoutRunId: null }).where(eq(issues.id, f.issueId));
      await f.db.update(agentTaskSessions).set({ lastRunId: next.runId }).where(eq(agentTaskSessions.id, f.session.id));
      writer = nativeRunnerCheckpointWriter(f.db, { ...binding, runId: next.runId, authorityRunId: next.runId,
        bootId: controller.bootId, leaseOwner: owner.leaseOwner, generation: 1 });
      core.rotateRunIdentity(next);
      await core.flushCheckpoint();
      expect(await readFile(f.file, "utf8")).toBe(marker);
      expect((await loadNativeRunnerCheckpoint(f.db, { ...binding, runId: next.runId }))?.runId).toBe(next.runId);
      const oldRows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      const currentRows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, next.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
      for (const value of [{ ...f.identity, runId: randomUUID() }, { ...f.identity, runnerInstanceId: randomUUID() },
        { ...f.identity, normalizedSessionId: randomUUID() }, { ...f.identity, environmentLeaseId: randomUUID() },
        { ...f.identity, turnId: randomUUID() }]) {
        await writeFile(f.file, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: value }));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      }
      await writeFile(f.file, marker);
      await f.db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, f.runId), eq(nativeRunnerCheckpoints.part, "cursor")));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      await f.db.insert(nativeRunnerCheckpoints).values(oldRows);
      await f.db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, next.runId), eq(nativeRunnerCheckpoints.part, "cursor")));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, next.runId));
      await f.db.insert(nativeRunnerCheckpoints).values(currentRows);
      for (const patch of [{ status: "failed" }, { createdAt: new Date(Date.now() + 60_000) },
        { finishedAt: new Date(Date.now() + 60_000) }, { runnerInstanceId: randomUUID() }]) {
        await f.db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.runId));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
        await f.db.update(heartbeatRuns).set({ status: "succeeded", createdAt: prior.createdAt, finishedAt,
          runnerInstanceId: prior.runnerInstanceId }).where(eq(heartbeatRuns.id, f.runId));
      }
      await f.db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.id, result.id));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.update(nativeRunResults).set({ schemaStatus: "accepted" }).where(eq(nativeRunResults.id, result.id));
      const [foreign] = await f.db.insert(agents).values({ companyId: f.companyId, name: "Foreign owner", role: "engineer", adapterType: "paperclip_runner" }).returning();
      await f.db.update(heartbeatRuns).set({ agentId: foreign.id }).where(eq(heartbeatRuns.id, f.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.update(heartbeatRuns).set({ agentId: f.agentId }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativeExecutionInput: {
        ...execution, session: { ...execution.session, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } } })
        .where(eq(heartbeatRuns.id, next.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, next.runId));
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, next.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.update(nativeRunFinalizations).set(owner).where(eq(nativeRunFinalizations.runId, next.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
      expect(await readFile(f.file, "utf8")).toBe(marker);
      expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(oldRows);
    } finally { await core.stop(); }
  });
  if (scenario === "source_scan") it("bounds retained source readers at eight and joins every started reader before a failure", async () => {
    const f = await fixture(), binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const checkpoint = captureLegacyDurablePrpCheckpoint(f.source, f.identity,
      { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, checkpoint));
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile,
      nativeControllerRecovery: createNativeControllerRecovery(f.snapshot, { configDigest: f.paths.configDigest,
        processConfigDigest: null }, { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId,
        normalizedSessionId: f.native.normalizedSessionId }) } }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.insert(agentTaskSessions).values(Array.from({ length: 15 }, () => ({ companyId: f.companyId,
      agentId: f.agentId, adapterType: "paperclip_runner", taskKey: randomUUID(), lastRunId: f.runId })));
    const original = sessionResume.findNativeSessionResumeRun;
    let started = 0, finished = 0, inFlight = 0, peak = 0, fail = false;
    const reason = new Error("retained source reader failed");
    const spy = vi.spyOn(sessionResume, "findNativeSessionResumeRun").mockImplementation(async (...args) => {
      const first = ++started === 1; peak = Math.max(peak, ++inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (fail && first) throw reason;
        return await original(...args);
      } finally { inFlight--; finished++; }
    });
    try {
      const before = performance.now();
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
      console.info(JSON.stringify({ state: "retained_source_readers", elapsedMs: performance.now() - before, peak, started, finished }));
      expect(started).toBe(16); expect(finished).toBe(16); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
      started = finished = peak = 0; fail = true;
      await expect(hasLocalNativeControllerObligations(f.db)).rejects.toBe(reason);
      expect(started).toBe(8); expect(finished).toBe(8); expect(inFlight).toBe(0);
      expect(await readFile(f.file, "utf8")).toBe(f.source);
    } finally { spy.mockRestore(); }
  });
  if (scenario === "active_durable") it("accepts a complete active database authority without terminal metadata and refuses stale or incomplete handoff proof", async () => {
    const f = await fixture(1, false, true), controller = await currentNativeControllerIdentity();
    const binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const { nativeWorkspaceSync, ...baseProfile } = f.profile;
    const remoteWorkspace = { schema: "paperclip.remote-workspace-run.v1", workspaceId: nativeWorkspaceSync.workspaceId,
      leaseId: nativeWorkspaceSync.leaseId, providerLeaseId: nativeWorkspaceSync.providerLeaseId,
      remoteCwd: nativeWorkspaceSync.remoteCwd, epoch: 1, state: "prepared", snapshotId: null };
    const profile = { ...baseProfile, sessionCheckpoint: null, remoteWorkspace };
    await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null, nativePhase: "observed",
      processPid: process.pid, processStartedAt: new Date(), runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    const owner = { controllerBootId: controller.bootId, controllerGeneration: 1, leaseOwner: "live-checkpoint-writer",
      leaseExpiresAt: new Date(Date.now() + 60_000), phase: "observed", resultId: null, failureCode: null, recoveryState: null } as const;
    await f.db.update(nativeRunFinalizations).set(owner).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(issues).set({ executionRunId: f.runId, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(f.paths.root, "control-plane"), identity: f.identity,
      expectedRunnerVersion: "migration-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(f.db, { ...binding, bootId: controller.bootId,
      leaseOwner: owner.leaseOwner, generation: 1, authorityRunId: f.runId }));
    try {
      await core.flushCheckpoint();
      const marker = await readFile(f.file, "utf8");
      const rows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      expect(rows.length).toBeGreaterThan(2);
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
      for (const value of [f.source, JSON.stringify({ schema: "unknown", identity: f.identity }),
        JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: { ...f.identity, runId: randomUUID() } })]) {
        await writeFile(f.file, value); expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      }
      await writeFile(f.file, marker);
      for (const part of ["cursor", "command:1"]) {
        await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.part, part));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
        const savedProfile = { ...profile, sessionCheckpoint: f.snapshot,
          nativeControllerRecovery: createNativeControllerRecovery(f.snapshot, { configDigest: f.paths.configDigest,
            processConfigDigest: null }, { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId,
            normalizedSessionId: f.native.normalizedSessionId }) };
        await f.db.update(heartbeatRuns).set({ runnerProfileJson: savedProfile }).where(eq(heartbeatRuns.id, f.runId));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
        await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
        await f.db.insert(nativeRunnerCheckpoints).values(rows);
        await f.db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing", leaseOwner: null })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
        await f.db.update(nativeRunFinalizations).set(owner).where(eq(nativeRunFinalizations.runId, f.runId));
        await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      }
      const cipher = createLocalEncryptedCipher("write"), header = JSON.parse((await loadNativeRunnerCheckpoint(f.db, binding))!.records.get("header")!);
      for (const field of ["runId", "runnerInstanceId", "normalizedSessionId", "environmentLeaseId"]) {
        const contents = JSON.stringify({ ...header, state: { ...header.state, identity: { ...header.state.identity, [field]: randomUUID() } } });
        await f.db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents })) })
          .where(eq(nativeRunnerCheckpoints.part, "header"));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      }
      await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      await f.db.insert(nativeRunnerCheckpoints).values(rows);
      for (const patch of [{ leaseExpiresAt: new Date(0) }, { controllerGeneration: 0 }, { controllerBootId: null },
        { leaseOwner: null }, { failureCode: "uncertain" }, { phase: "retryable_failure" }]) {
        await f.db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, f.runId));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
        await f.db.update(nativeRunFinalizations).set(owner).where(eq(nativeRunFinalizations.runId, f.runId));
      }
      await f.db.update(issues).set({ executionRunId: f.queuedId }).where(eq(issues.id, f.issueId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      for (const value of [null, {}, { ...remoteWorkspace, workspaceId: randomUUID() }]) {
        await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, remoteWorkspace: value,
          nativeWorkspaceSync } }).where(eq(heartbeatRuns.id, f.runId));
        expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
      }
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...baseProfile, sessionCheckpoint: null, nativeWorkspaceSync } })
        .where(eq(heartbeatRuns.id, f.runId));
      expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      expect(await readFile(f.file, "utf8")).toBe(marker);
      expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(rows);
    } finally { await core.stop(); }
  });
  if (scenario.startsWith("archive_online")) it("preserves a failed source online without changing its execution or unrelated work", async () => {
    const f = await fixture();
    await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    await f.db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedId));
    if (scenario === "archive_online_commit") {
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: run.completionContractId!, serverFingerprint: "failed-committed-migration", schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: "failed-committed-migration" }).returning();
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null,
        leaseExpiresAt: null, recoveryState: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    } else {
      await rm(join(f.paths.root, "provider-pack-authority.json"));
      await f.db.update(nativeRunFinalizations).set({ recoveryState: "blocked", failureCode: "native_provider_terminal_failed" })
        .where(eq(nativeRunFinalizations.runId, f.runId));
    }
    if (scenario === "archive_online_owned") await f.db.update(nativeRunFinalizations).set({
      leaseOwner: "expired-is-still-owned", leaseExpiresAt: new Date(0),
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "archive_online_foreign") await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile,
      nativeExecutionInput: { ...f.profile.nativeExecutionInput, binding: { ...f.profile.nativeExecutionInput.binding, companyId: randomUUID() } } } })
      .where(eq(heartbeatRuns.id, f.runId));
    const unrelated = await environment.seedRun(randomUUID());
    const [unrelatedBefore] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId));
    const [runBefore] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [ownerBefore] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "durable-objects")));
    const originalPut = storage.putFile.bind(storage);
    const put = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await originalPut(input);
      if (scenario === "archive_online_changed") await writeFile(f.file, f.source + "\n", { mode: 0o600 });
      if (scenario === "archive_online_active") await f.db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId,
        status: "queued", runtimeMode: "native" });
      return result;
    });
    const counts = await prestageNativeControllers(f.db, { storage, signal: AbortSignal.timeout(30_000) });
    if (["archive_online_owned", "archive_online_changed", "archive_online_active", "archive_online_foreign"].includes(scenario)) {
      expect(counts.archivedFailed).toBe(0);
      expect(counts.deferred[scenario === "archive_online_foreign" ? "artifact_binding" : "archive_source_unsettled"]).toBe(1);
      if (["archive_online_owned", "archive_online_changed"].includes(scenario)) expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
      const backups = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, f.runId));
      expect(backups.some(backup => backup.status === "current")).toBe(false);
      if (scenario === "archive_online_owned") expect(put).not.toHaveBeenCalled();
      if (scenario === "archive_online_changed") expect(put).toHaveBeenCalledOnce();
      if (scenario === "archive_online_active") {
        expect(put).toHaveBeenCalledOnce();
        expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).some(run => run.status === "queued")).toBe(true);
      }
      if (scenario === "archive_online_foreign") expect(put).not.toHaveBeenCalled();
      if (scenario === "archive_online_foreign") await expect(hasLocalNativeControllerObligations(f.db, storage))
        .rejects.toThrow("native_controller_migration_artifact_binding");
    } else if (scenario === "archive_online_commit") {
      expect(counts.imported).toBe(1);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("failed");
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).not.toBeNull();
    } else {
      expect(counts.archivedFailed).toBe(1);
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
      expect((await prestageNativeControllers(f.db, { storage, signal: AbortSignal.timeout(30_000) })).archivedFailed).toBe(1);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(runBefore);
      const descriptor = legacyNativeControllerArchive({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, controller: f.source });
      const replacement = join(f.runtimeRoot, "online-archive-inspection");
      await rm(f.paperclipHome, { recursive: true, force: true });
      expect(await restoreDurableNativeHarnessBackup({ db: f.db, storage, companyId: f.companyId,
        scopeDigest: descriptor.scopeDigest, backupRoot: replacement })).toBe(true);
      expect(await readFile(join(replacement, "current", "control-plane-state.json"), "utf8")).toBe(f.source);
    }
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(ownerBefore);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId)))[0]).toEqual(unrelatedBefore);
  });
  if (scenario.startsWith("online_")) it("prestages only a settled legacy controller while unrelated work continues", async () => {
    const f = await fixture();
    const settle = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: run.completionContractId!, serverFingerprint: "online-migration", schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: "online-migration" }).returning();
      await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
      await f.db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedId));
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null,
        leaseExpiresAt: null, recoveryState: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    };
    await settle(f);
    const unrelated = await environment.seedRun(randomUUID());
    const [unrelatedBefore] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId));
    if (scenario === "online_owned") await f.db.update(nativeRunFinalizations).set({
      leaseOwner: "expired-owner-is-still-an-owner", leaseExpiresAt: new Date(0),
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "online_same_source") await f.db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId,
      agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId,
      status: "running", runtimeMode: "native" });
    const before = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "online_evidence") {
      await rm(join(f.paths.root, "provider-pack-authority.json"));
      await f.db.update(agentTaskSessions).set({ id: "00000000-0000-4000-8000-000000000001" }).where(eq(agentTaskSessions.id, f.session.id));
      const next = await fixture();
      await settle(next);
      const actual = await prestageNativeControllers(f.db, { signal: AbortSignal.timeout(30_000) });
      expect(actual).toMatchObject({ inspected: 2, imported: 1, deferred: { artifact_unproven: 1 } });
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).toBeNull();
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: next.companyId, issueId: next.issueId, runId: next.runId })).not.toBeNull();
      expect(await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual(before);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId)))[0]).toEqual(unrelatedBefore);
      return;
    }
    if (scenario === "online_changed") {
      const inode = (await stat(f.file)).ino;
      const probe = await open(f.file, "r");
      const prototype = Object.getPrototypeOf(probe);
      const originalRead = prototype.readFile;
      await probe.close();
      let changed = false;
      vi.spyOn(prototype, "readFile").mockImplementation(async function(this: { stat: () => Promise<{ ino: number }> }, ...args: unknown[]) {
        const bytes = await originalRead.apply(this, args);
        if (!changed && (await this.stat()).ino === inode) {
          changed = true;
          await writeFile(f.file, f.source + "\n", { mode: 0o600 });
        }
        return bytes;
      });
      expect(await prestageNativeControllers(f.db, { signal: AbortSignal.timeout(30_000) }))
        .toMatchObject({ imported: 0, deferred: { source_changed: 1 } });
      expect(changed).toBe(true);
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).toBeNull();
      expect(await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual(before);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId)))[0]).toEqual(unrelatedBefore);
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const writer = scenario === "online_busy" ? f.db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      acquired();
      await gate;
    }) : null;
    if (writer) await locked;
    let actual: Awaited<ReturnType<typeof prestageNativeControllers>>;
    try { actual = await prestageNativeControllers(f.db, { signal: AbortSignal.timeout(30_000) }); }
    finally { release(); await writer; }
    if (scenario === "online_busy") expect(actual.deferred.source_busy).toBe(1);
    if (scenario === "online_success") {
      expect(actual.imported).toBe(1);
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).not.toBeNull();
      expect((await prestageNativeControllers(f.db, { signal: AbortSignal.timeout(30_000) })).unchanged).toBeGreaterThanOrEqual(1);
    } else {
      expect(actual.imported).toBe(0);
      expect(await loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).toBeNull();
    }
    expect(await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual(before);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId)))[0]).toEqual(unrelatedBefore);
    expect(await readFile(f.file, "utf8")).toBe(f.source);
  });
  if (scenario === "import") it("imports an exact settled authority once, preserves queued work, and resumes from an empty home", async () => {
    const f = await fixture();
    const { companyId, agentId, paperclipHome, runtimeRoot, profile, file, source, session, queuedId, identity, snapshot } = f;
    expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile,
      nativeWorkspaceSync: { ...profile.nativeWorkspaceSync, workspaceId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) }))
      .rejects.toThrow("native_controller_migration_artifact_binding");
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    expect(profile.nativeWorkspaceSync.leaseId).not.toBe(identity.environmentLeaseId);
    expect(profile.nativeWorkspaceSync.workspaceId).toBe(identity.environmentLeaseId);
    const foreignProtocol = JSON.parse(source);
    foreignProtocol.identity.environmentLeaseId = randomUUID();
    await writeFile(file, JSON.stringify(foreignProtocol), { mode: 0o600 });
    await expect(migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) }))
      .rejects.toThrow("saved provider pack authority is invalid or does not match this execution");
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toHaveLength(0);
    await writeFile(file, source, { mode: 0o600 });
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "unsettled-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) })).rejects.toThrow("normal_ownership_recovery_required");
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toHaveLength(0);
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "expired-owner", leaseExpiresAt: new Date(0),
      phase: "retryable_failure", recoveryState: "resuming_session" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [preservedOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) }))
      .toMatchObject({ imported: 1, sourceAlreadyAbsent: 0 });
    expect(await migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) })).toMatchObject({ unchanged: 1, imported: 0 });
    expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(preservedOwner);
    expect(await readFile(file, "utf8")).toBe(source);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.id)))[0].lastRunId).toBe(f.runId);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedId)))[0].status).toBe("queued");
    await rm(paperclipHome, { recursive: true, force: true });
    await f.db.update(heartbeatRuns).set({ nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId,
      status: "running", runtimeMode: "native" }).where(eq(heartbeatRuns.id, queuedId));
    const recovered = await resolveNativeControllerRecovery(f.db, { companyId, agentId, issueId: f.issueId,
      normalizedSessionId: f.native.normalizedSessionId, currentRunId: queuedId });
    expect(recovered.kind).toBe("recoverable");
    if (recovered.kind !== "recoverable") throw new Error(JSON.stringify(recovered));
    const replacement = join(runtimeRoot, "replacement"); await mkdir(replacement, { mode: 0o700 });
    recovered.checkpoint.restoreSessionDirectory(replacement);
    expect(JSON.parse(await readFile(join(replacement, "control-plane/control-plane-state.json"), "utf8")).identity).toEqual(identity);
    expect(recovered.snapshot).toEqual(snapshot);
  });
  if (scenario === "batch") it("imports a large checkpoint with bounded writes and rolls back every batch on a late conflict", async () => {
    const f = await fixture(160);
    const binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const checkpoint = captureLegacyDurablePrpCheckpoint(f.source, { runId: f.runId,
      runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId },
    { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
    const last = [...checkpoint.records].at(-1)!;
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, {
      ...checkpoint, records: new Map([last]),
    }));
    const before = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    const parameters: number[] = [];
    const payloadBytes: number[] = [];
    const previousDebug = f.db.$client.options.debug;
    f.db.$client.options.debug = (_connection, query, values) => {
      if (query.startsWith('insert into "native_runner_checkpoints"')) {
        parameters.push(values.length);
        payloadBytes.push(values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0));
      }
    };
    try {
      await expect(f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, checkpoint)))
        .rejects.toThrow();
      expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(before);
      expect(parameters.length).toBeGreaterThan(1);
      expect(Math.max(...parameters)).toBeLessThanOrEqual(320);
      expect(Math.max(...payloadBytes)).toBeLessThanOrEqual(512 * 1024);
      await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      expect(await migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000) }))
        .toMatchObject({ imported: 1 });
      const rows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      const cipher = createLocalEncryptedCipher("read");
      for (const row of rows) expect(JSON.parse(cipher.decrypt(row.material))).toEqual({
        ...binding, part: row.part, contents: checkpoint.records.get(row.part),
      });
      const restored = await loadNativeRunnerCheckpoint(f.db, binding);
      expect(restored?.records).toEqual(checkpoint.records);
      expect(await readFile(f.file, "utf8")).toBe(f.source);
    } finally { f.db.$client.options.debug = previousDebug; }
  }, 60_000);
  if (scenario === "durable_inline_failed") it("preserves exact DB-only failed inline evidence while retaining every local payload and binding guard", async () => {
    const f = await fixture(), binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "unused-durable-objects")));
    const put = vi.spyOn(storage, "putFile");
    const checkpoint = captureLegacyDurablePrpCheckpoint(f.source, { runId: f.runId,
      runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId },
    { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, checkpoint));
    await f.db.update(nativeRunFinalizations).set({ recoveryState: "blocked", failureCode: "original_failure" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
    await rm(f.file);
    await mkdir(dirname(f.paths.supervisorPath), { recursive: true });
    await writeFile(f.paths.supervisorPath, "retained newer supervisor\n");
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
    expect(await readFile(f.paths.supervisorPath, "utf8")).toBe("retained newer supervisor\n");
    await rm(f.paths.supervisorPath);
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
    for (const field of ["companyId", "agentId", "issueId", "runId", "sessionId"] as const) {
      const profile = { ...f.profile, sessionCheckpoint: { ...f.snapshot, identity: { ...f.snapshot.identity, [field]: randomUUID() } } };
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
    }
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: f.profile }).where(eq(heartbeatRuns.id, f.runId));
    for (const field of ["runnerInstanceId", "normalizedSessionId"] as const) {
      const state = JSON.parse(f.source); state.identity[field] = randomUUID();
      const foreign = captureLegacyDurablePrpCheckpoint(JSON.stringify(state), { runId: f.runId,
        runnerInstanceId: state.identity.runnerInstanceId, normalizedSessionId: state.identity.normalizedSessionId },
      { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
      await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, foreign));
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
    }
    await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, checkpoint));
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const rows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    expect(await migrateNativeControllers(f.db, { writersStopped: true, signal: AbortSignal.timeout(30_000), storage }))
      .toMatchObject({ preservedFailed: 1, imported: 0, archivedFailed: 0 });
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(run);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(owner);
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(rows);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, f.session.id)))[0].lastRunId).toBe(f.runId);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedId)))[0].status).toBe("queued");
    expect(put).not.toHaveBeenCalled();
    expect((await loadNativeRunnerCheckpoint(f.db, binding))?.records).toEqual(checkpoint.records);
    await f.db.update(heartbeatRuns).set({ nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId })
      .where(eq(heartbeatRuns.id, f.queuedId));
    const recovery = await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId });
    expect(recovery).toEqual({ kind: "unsupported", reason: "metadata_format" });
  });
  if (scenario === "durable_failed") it("preserves a failed durable checkpoint without inventing a missing session snapshot", async () => {
    const f = await fixture();
    const binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
    const checkpoint = captureLegacyDurablePrpCheckpoint(f.source, { runId: f.runId,
      runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId },
    { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, checkpoint));
    await f.db.update(heartbeatRuns).set({ processPid: 12345, runnerProfileJson: { ...f.profile, sessionCheckpoint: null } })
      .where(eq(heartbeatRuns.id, f.runId));
    const options = { writersStopped: true as const, signal: AbortSignal.timeout(30_000) };
    await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(migrateNativeControllers(f.db, options)).rejects.toThrow("stale_supervisor_snapshot");
    await f.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const rows = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    const foreign = JSON.parse(f.source);
    foreign.identity.normalizedSessionId = randomUUID();
    const foreignCheckpoint = captureLegacyDurablePrpCheckpoint(JSON.stringify(foreign), { runId: f.runId,
      runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: foreign.identity.normalizedSessionId },
    { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
    await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, binding, foreignCheckpoint));
    expect(await hasLocalNativeControllerObligations(f.db)).toBe(true);
    await expect(migrateNativeControllers(f.db, options)).rejects.toThrow("stale_supervisor_snapshot");
    await f.db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    await f.db.insert(nativeRunnerCheckpoints).values(rows);
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ preservedFailed: 1, imported: 0 });
    expect(await hasLocalNativeControllerObligations(f.db)).toBe(false);
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ preservedFailed: 1, imported: 0 });
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(rows);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(run);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(owner);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, f.session.id)))[0].lastRunId).toBe(f.runId);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedId)))[0].status).toBe("queued");
    await rm(f.paperclipHome, { recursive: true, force: true });
    expect((await loadNativeRunnerCheckpoint(f.db, binding))?.records).toEqual(checkpoint.records);
    const recovery = await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId });
    expect(recovery.kind).not.toBe("recoverable");
  });
  if (scenario === "archive") it("preserves an already-failed legacy controller without inventing executable recovery authority", async () => {
    const f = await fixture();
    await rm(join(f.paths.root, "provider-pack-authority.json"));
    await f.db.update(nativeRunFinalizations).set({ recoveryState: "blocked", failureCode: "native_provider_terminal_failed" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const [originalRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [originalOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "durable-objects")));
    const options = { storage, writersStopped: true as const, signal: AbortSignal.timeout(30_000) };
    const put = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("storage unavailable"));
    await expect(migrateNativeControllers(f.db, options)).rejects.toThrow("storage unavailable");
    put.mockRestore();
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toHaveLength(0);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(originalRun);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(originalOwner);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.queuedId);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, f.session.id)))[0].lastRunId).toBe(f.runId);
    await rm(f.paperclipHome, { recursive: true, force: true });
    const descriptor = legacyNativeControllerArchive({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, controller: f.source });
    const replacement = join(f.runtimeRoot, "archived-inspection");
    expect(await restoreDurableNativeHarnessBackup({ db: f.db, storage, companyId: f.companyId,
      scopeDigest: descriptor.scopeDigest, backupRoot: replacement })).toBe(true);
    expect(await readFile(join(replacement, "current", "control-plane-state.json"), "utf8")).toBe(f.source);
    const recovery = await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId });
    expect(recovery.kind).not.toBe("recoverable");
  });
  if (scenario.startsWith("stale_")) it("archives a failed source only when its older supervisor matches scoped history", async () => {
    const f = await fixture(1, true), priorId = randomUUID();
    const priorSnapshot = { ...f.snapshot, identity: { ...f.snapshot.identity, runId: priorId } };
    if (scenario === "stale_foreign") priorSnapshot.identity.agentId = randomUUID();
    const priorProfile = { ...f.profile, nativeExecutionInput: { ...f.profile.nativeExecutionInput,
      binding: { ...f.profile.nativeExecutionInput.binding, runId: priorId } }, sessionCheckpoint: priorSnapshot };
    await f.db.insert(heartbeatRuns).values({ id: priorId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId,
      runtimeMode: "native", status: "succeeded", createdAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(Date.now() - 50_000), runnerProfileJson: priorProfile });
    if (scenario === "stale_queued" || scenario === "stale_overlap") {
      const now = Date.now();
      await f.db.update(heartbeatRuns).set({ createdAt: new Date(now - 45_000),
        startedAt: new Date(now - (scenario === "stale_queued" ? 30_000 : 43_000)) }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(heartbeatRuns).set({ finishedAt: new Date(now - 40_000) }).where(eq(heartbeatRuns.id, priorId));
    }
    const supervisor = JSON.stringify({ schema: "paperclip.native-session-supervisor.v1",
      configDigest: f.paths.configDigest, snapshot: priorSnapshot });
    await mkdir(dirname(f.paths.supervisorPath), { recursive: true });
    await writeFile(f.paths.supervisorPath, supervisor, { mode: 0o600 });
    if (scenario === "stale_changed") await f.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...priorProfile, sessionCheckpoint: { ...priorSnapshot, sessionId: "different-provider-thread" },
    } }).where(eq(heartbeatRuns.id, priorId));
    if (scenario === "stale_success") await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    if (scenario === "stale_busy") await f.db.update(nativeRunFinalizations).set({ leaseOwner: "live-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario.startsWith("stale_durable")) {
      const state = JSON.parse(f.source);
      if (scenario === "stale_durable_runner") state.identity.runnerInstanceId = randomUUID();
      if (scenario === "stale_durable_session") state.identity.normalizedSessionId = randomUUID();
      const checkpoint = captureLegacyDurablePrpCheckpoint(JSON.stringify(state), { runId: f.runId,
        runnerInstanceId: state.identity.runnerInstanceId, normalizedSessionId: state.identity.normalizedSessionId },
      { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
      await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx,
        { companyId: f.companyId, issueId: f.issueId, runId: f.runId }, checkpoint));
      if (scenario === "stale_durable_absent") await rm(f.paths.supervisorPath);
      if (scenario === "stale_durable_snapshot") await f.db.update(heartbeatRuns).set({ runnerProfileJson: {
        ...f.profile, sessionCheckpoint: { ...f.snapshot, identity: { ...f.snapshot.identity, agentId: randomUUID() } },
      } }).where(eq(heartbeatRuns.id, f.runId));
    }
    const [originalRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [originalOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "durable-objects")));
    const options = { storage, writersStopped: true as const, signal: AbortSignal.timeout(30_000) };
    if (scenario === "stale_durable" || scenario === "stale_durable_absent") {
      const binding = { companyId: f.companyId, issueId: f.issueId, runId: f.runId };
      const before = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
      expect(await migrateNativeControllers(f.db, options)).toMatchObject({ imported: 1, archivedFailed: 0 });
      expect(await migrateNativeControllers(f.db, options)).toMatchObject({ unchanged: 1, archivedFailed: 0 });
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
      expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(before);
      expect(await f.db.select().from(nativeHarnessBackups)).toHaveLength(0);
      const [afterRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(afterRun.runnerProfileJson?.sessionCheckpoint).toEqual(originalRun.runnerProfileJson?.sessionCheckpoint);
      expect(afterRun).toEqual({ ...originalRun, runnerProfileJson: afterRun.runnerProfileJson, updatedAt: afterRun.updatedAt });
      expect(afterRun.runnerProfileJson).toEqual({ ...originalRun.runnerProfileJson,
        nativeControllerRecovery: expect.objectContaining({ snapshotSha256: nativeSha256(f.snapshot),
          checkpoint: { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId } }) });
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(originalOwner);
      await rm(f.paperclipHome, { recursive: true, force: true });
      expect((await loadNativeRunnerCheckpoint(f.db, binding))?.records.size).toBe(before.length);
      await f.db.update(heartbeatRuns).set({ nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId,
        status: "running", runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.queuedId));
      expect((await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId })).kind).toBe("recoverable");
      return;
    }
    if (!["stale_confirmed", "stale_queued"].includes(scenario)) {
      await expect(migrateNativeControllers(f.db, options)).rejects.toThrow();
      expect(await f.db.select().from(nativeHarnessBackups)).toHaveLength(0);
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(originalRun);
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(originalOwner);
      return;
    }
    const put = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("storage unavailable"));
    await expect(migrateNativeControllers(f.db, options)).rejects.toThrow("storage unavailable");
    put.mockRestore();
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
    expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toHaveLength(0);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(originalRun);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(originalOwner);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, f.session.id)))[0].lastRunId).toBe(f.runId);
    await rm(f.paperclipHome, { recursive: true, force: true });
    const descriptor = legacyNativeControllerArchive({ companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, controller: f.source, supervisor });
    const replacement = join(f.runtimeRoot, "archived-stale-supervisor");
    expect(await restoreDurableNativeHarnessBackup({ db: f.db, storage, companyId: f.companyId,
      scopeDigest: descriptor.scopeDigest, backupRoot: replacement })).toBe(true);
    expect(await readFile(join(replacement, "current", "control-plane-state.json"), "utf8")).toBe(f.source);
    expect(await readFile(join(replacement, "current", "supervisor.json"), "utf8")).toBe(supervisor);
    expect((await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId })).kind).not.toBe("recoverable");
  });
  if (scenario.startsWith("controller_")) it("preserves failed legacy files only with proven older controller lineage", async () => {
    const f = await fixture(), priorId = randomUUID();
    const priorSnapshot = { ...f.snapshot, identity: { ...f.snapshot.identity, runId: priorId } };
    if (scenario === "controller_foreign") priorSnapshot.identity.agentId = randomUUID();
    const priorProfile = { ...f.profile, nativeExecutionInput: { ...f.profile.nativeExecutionInput,
      binding: { ...f.profile.nativeExecutionInput.binding, runId: priorId } }, sessionCheckpoint: priorSnapshot };
    await f.db.insert(heartbeatRuns).values({ id: priorId, companyId: f.companyId,
      agentId: f.agentId,
      nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId,
      runnerInstanceId: scenario === "controller_runner" ? randomUUID() : f.native.runnerInstanceId,
      runtimeMode: "native", status: "succeeded", createdAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(Date.now() - 50_000), runnerProfileJson: scenario === "controller_thread"
        ? { ...priorProfile, sessionCheckpoint: { ...priorSnapshot, sessionId: "foreign-provider-thread" } } : priorProfile });
    const state = JSON.parse(f.source);
    state.identity = { ...state.identity, runId: priorId, turnId: `turn-${priorId}`, itemId: `item-${priorId}` };
    if (scenario === "controller_invalid") state.schema = "unrecognized";
    const source = JSON.stringify(state);
    await writeFile(f.file, source, { mode: 0o600 });
    if (scenario === "controller_success") await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    if (scenario === "controller_busy") await f.db.update(nativeRunFinalizations).set({ leaseOwner: "live-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "controller_durable") {
      const checkpoint = captureLegacyDurablePrpCheckpoint(f.source, f.identity,
        { version: "migration-fixture", digest: `sha256:${"a".repeat(64)}` });
      await f.db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx,
        { companyId: f.companyId, issueId: f.issueId, runId: f.runId }, checkpoint));
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile, nativeControllerRecovery:
        createNativeControllerRecovery(f.snapshot, { configDigest: f.paths.configDigest, processConfigDigest: null },
          { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId }) } })
        .where(eq(heartbeatRuns.id, f.runId));
    }
    if (scenario.startsWith("controller_observed_")) {
      await f.db.update(nativeRunFinalizations).set({ phase: scenario === "controller_observed_result" ? "result_accepted" : "observed",
        leaseOwner: "retired-controller", leaseExpiresAt: new Date(Date.now() + (scenario === "controller_observed_live" ? 60_000 : -60_000)),
        nextAttemptAt: scenario === "controller_observed_retry" ? new Date(Date.now() + 60_000) : null,
      }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (scenario === "controller_observed_task") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      if (scenario !== "controller_observed_missing") {
        const lease = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId,
          provider: "daytona", providerLeaseId: randomUUID(), status: "released", cleanupStatus: "success", releasedAt: new Date() };
        const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" })!;
        if (scenario === "controller_observed_stop_before_finish") {
          const now = Date.now();
          await f.db.update(heartbeatRuns).set({ createdAt: new Date(now - 40_000), startedAt: new Date(now - 30_000) })
            .where(eq(heartbeatRuns.id, f.runId));
          receipt.confirmedAt = new Date(now - 10_000).toISOString();
          lease.releasedAt = new Date(now - 10_000);
        }
        if (scenario === "controller_observed_foreign") receipt.runId = randomUUID();
        if (scenario === "controller_observed_old_receipt") receipt.confirmedAt = new Date(0).toISOString();
        await f.db.insert(environmentLeases).values({ ...lease, metadata: { remoteExecutionTermination: receipt } });
        if (scenario.startsWith("controller_observed_handoff")) {
          const environmentId = randomUUID(), successorRunId = randomUUID(), handoffAt = new Date(Date.now() - 1000);
          await f.db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
          await f.db.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
            nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId, runtimeMode: "native", status: "succeeded", finishedAt: new Date() });
          const [previous] = await f.db.update(environmentLeases).set({ environmentId, leasePolicy: "reuse_by_environment",
            status: "expired", acquiredAt: new Date(handoffAt.getTime() - 1000), releasedAt: handoffAt,
            metadata: { agentId: f.agentId } }).where(eq(environmentLeases.id, lease.id)).returning();
          const successor = { ...previous, id: randomUUID(), heartbeatRunId: successorRunId, acquiredAt: handoffAt,
            status: "released", releasedAt: new Date(), metadata: { agentId: f.agentId } };
          const handoff = createReusableLeaseHandoff(previous, successor);
          const termination = remoteTerminationReceipt(successor, { providerLeaseId: successor.providerLeaseId,
            state: scenario === "controller_observed_handoff_stopped" ? "stopped" : "destroyed" });
          await f.db.update(environmentLeases).set({ metadata: { agentId: f.agentId, reusableLeaseSuccessor: handoff } })
            .where(eq(environmentLeases.id, previous.id));
          await f.db.insert(environmentLeases).values({ ...successor, metadata: { agentId: f.agentId,
            reusableLeasePredecessor: scenario === "controller_observed_handoff_broken" ? { ...handoff, handoffId: randomUUID() } : handoff,
            remoteExecutionTermination: termination } });
          if (scenario === "controller_observed_handoff_fork") await f.db.insert(environmentLeases).values({ ...previous,
            id: randomUUID(), heartbeatRunId: f.queuedId, status: "active", releasedAt: null, metadata: { agentId: f.agentId } });
        }
      }
    }
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "durable-objects")));
    const options = { storage, writersStopped: true as const, signal: AbortSignal.timeout(30_000) };
    if (scenario === "controller_observed_revoked") {
      const put = storage.putFile.bind(storage);
      vi.spyOn(storage, "putFile").mockImplementation(async args => {
        const result = await put(args);
        await f.db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.heartbeatRunId, f.runId));
        return result;
      });
    }
    if (scenario === "controller_durable") {
      expect(await migrateNativeControllers(f.db, options)).toMatchObject({ unchanged: 1, archivedFailed: 0 });
    } else if (!["controller_confirmed", "controller_observed_stopped", "controller_observed_stop_before_finish", "controller_observed_handoff"].includes(scenario)) {
      await expect(migrateNativeControllers(f.db, options)).rejects.toThrow();
      const archives = await f.db.select().from(nativeHarnessBackups);
      if (scenario === "controller_observed_revoked") {
        expect(storage.putFile).toHaveBeenCalledOnce();
        expect(archives).toHaveLength(1);
        expect(archives[0].status).toBe("pending");
      }
      else expect(archives).toHaveLength(0);
    } else {
      const put = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("storage unavailable"));
      await expect(migrateNativeControllers(f.db, options)).rejects.toThrow("storage unavailable");
      put.mockRestore();
      expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
      expect(await migrateNativeControllers(f.db, options)).toMatchObject({ archivedFailed: 1, imported: 0 });
      expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(false);
      expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toHaveLength(0);
      await rm(f.paperclipHome, { recursive: true, force: true });
      const descriptor = legacyNativeControllerArchive({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, controller: source });
      const replacement = join(f.runtimeRoot, "archived-older-controller");
      expect(await restoreDurableNativeHarnessBackup({ db: f.db, storage, companyId: f.companyId,
        scopeDigest: descriptor.scopeDigest, backupRoot: replacement })).toBe(true);
      expect(await readFile(join(replacement, "current", "control-plane-state.json"), "utf8")).toBe(source);
      expect((await resolveNativeControllerRecovery(f.db, { companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, normalizedSessionId: f.native.normalizedSessionId, currentRunId: f.queuedId })).kind).not.toBe("recoverable");
    }
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(run);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(owner);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, f.session.id)))[0].lastRunId).toBe(f.runId);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId)
      .toBe(scenario === "controller_observed_task" ? f.runId : f.queuedId);
  });
  if (scenario === "success") it("does not substitute a failure archive for a successful retained session", async () => {
    const f = await fixture();
    await rm(join(f.paths.root, "provider-pack-authority.json"));
    await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const storage = createStorageService(createLocalDiskStorageProvider(join(f.runtimeRoot, "durable-objects")));
    await expect(migrateNativeControllers(f.db, { storage, writersStopped: true, signal: AbortSignal.timeout(30_000) }))
      .rejects.toThrow("native_runner_checkpoint_artifact_unproven");
    expect(await f.db.select().from(nativeHarnessBackups)).toHaveLength(0);
    expect(await hasLocalNativeControllerObligations(f.db, storage)).toBe(true);
  });
});
