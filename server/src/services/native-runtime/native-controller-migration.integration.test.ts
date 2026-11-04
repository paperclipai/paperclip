import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agentTaskSessions, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, DurablePrpControlPlane, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { hasLocalNativeControllerObligations, migrateNativeControllers } from "./native-controller-migration.js";
import { insertMigratedNativeRunnerCheckpoint, loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { resolveRemoteProviderPackAuthority } from "./remote-provider-pack-authority.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";
import { nativeSha256 } from "./canonical.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { legacyNativeControllerArchive } from "./native-controller-archive.js";
import { restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";

describeEmbeddedPostgres.each(["import", "archive", "success", "batch"])("offline native controller migration (%s)", scenario => {
  const environment = nativeRestartFixture();
  afterEach(() => vi.unstubAllEnvs());
  async function fixture(commandCount = 1) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "73".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, paperclipHome, runtimeRoot } = environment.current;
    const binding = { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: f.native.environmentLeaseId };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null }, binding,
      task: { identifier: "MIG-1", title: "Retained work", description: null, prompt: "Continue the work.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
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
    const snapshot = { backendKind: "mock", sessionId: f.native.normalizedSessionId,
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
