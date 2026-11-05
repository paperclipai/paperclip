import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agentTaskSessions, environmentLeases, environments, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, DurablePrpControlPlane, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { hasLocalNativeControllerObligations, migrateNativeControllers } from "./native-controller-migration.js";
import { insertMigratedNativeRunnerCheckpoint, loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
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

describeEmbeddedPostgres.each(["import", "archive", "success", "batch", "durable_failed",
  "stale_confirmed", "stale_foreign", "stale_changed", "stale_queued", "stale_overlap", "stale_success", "stale_busy", "stale_durable", "stale_durable_absent",
  "stale_durable_runner", "stale_durable_session", "stale_durable_snapshot",
  "controller_confirmed", "controller_foreign", "controller_thread", "controller_runner", "controller_success", "controller_busy", "controller_invalid", "controller_durable",
  "controller_observed_stopped", "controller_observed_stop_before_finish", "controller_observed_missing", "controller_observed_foreign",
  "controller_observed_live", "controller_observed_result", "controller_observed_retry", "controller_observed_task", "controller_observed_old_receipt", "controller_observed_revoked",
  "controller_observed_handoff", "controller_observed_handoff_stopped", "controller_observed_handoff_broken", "controller_observed_handoff_fork"])("offline native controller migration (%s)", scenario => {
  const environment = nativeRestartFixture();
  afterEach(() => vi.unstubAllEnvs());
  async function fixture(commandCount = 1, warm = false) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "73".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, paperclipHome, runtimeRoot } = environment.current;
    const binding = { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: f.native.environmentLeaseId };
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
      environmentLeaseId: f.native.environmentLeaseId, turnId: f.native.turnId, itemId: f.native.itemId };
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
