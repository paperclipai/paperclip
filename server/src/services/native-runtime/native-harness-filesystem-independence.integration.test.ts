import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activityLog, agentTaskSessions, agents, companies, companySkills, companySkillVersions, companySkillRepositorySnapshots, createDb, environmentLeases,
  heartbeatRuns, issues, nativeHarnessBackups, nativeRunnerCheckpoints, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { describeEmbeddedPostgres } from "../../__tests__/helpers/native-restart.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { canonicalNativeRuntimeContextDigest, captureLegacyDurablePrpCheckpoint, DurablePrpControlPlane, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { preserveRuntimeSkillAssets } from "./runtime-skill-preservation.js";
import { nativeControllerMigrationDescriptor, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { hasLocalNativeHarnessObligations } from "./native-harness-backup-migration.js";
import { preserveNativeHarnessFilesystemIndependence, hasValidNativeHarnessFilesystemIndependence } from "./native-harness-filesystem-independence.js";
import { originalHarnessVolumeAnchorPath, verifyOriginalHarnessVolumeSource, type OriginalHarnessVolumeAnchor,
  type ReviewedOriginalHarnessVolumeWitness } from "./native-harness-original-volume.js";
import { removeRuntimeAssetTree } from "./runtime-asset-retention.js";
import { skillPackageStore } from "../skill-package-store.js";
import { repositorySkillProjection } from "../skill-repository-package.js";
import { skillFileBytes } from "../skill-snapshot.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { ensureNativeCompletionContract } from "./completion-contracts.js";
import { restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeCheckpointRetirement } from "./native-runner-checkpoint-retirement.js";
import { nativeSha256 } from "./canonical.js";
import { nativeControllerEvidenceDescriptor } from "./native-controller-archive.js";

vi.mock("../../build-commit.js", () => ({ readBuildCommit: () => "a".repeat(40) }));

describeEmbeddedPostgres("owner-verified native harness filesystem independence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-harness-filesystem-"); db = createDb(database.connectionString); }, 90_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.delete(agentTaskSessions); for (const root of roots.splice(0)) await removeRuntimeAssetTree(root); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(kind: "unversioned" | "repository" | "package" | "deleted" | "none" = "unversioned", managedWorkspace = false) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    const mount = await realpath(await mkdtemp(join(tmpdir(), "native-harness-original-"))); roots.push(mount);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    const projectId = randomUUID(), serviceId = randomUUID(), environmentId = randomUUID(), volumeId = randomUUID(), deploymentId = randomUUID();
    for (const [key, value] of Object.entries({ PAPERCLIP_HOME: mount, PAPERCLIP_INSTANCE_ID: "default", RAILWAY_PROJECT_ID: projectId,
      RAILWAY_SERVICE_ID: serviceId, RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_VOLUME_ID: volumeId,
      RAILWAY_DEPLOYMENT_ID: deploymentId, RAILWAY_VOLUME_MOUNT_PATH: mount,
      PAPERCLIP_RUNNER_STATE_DIR: join(mount, "instances/default/runtime/paperclip-runner/durable-sessions") })) vi.stubEnv(key, value);
    await mkdir(process.env.PAPERCLIP_RUNNER_STATE_DIR!, { recursive: true, mode: 0o700 });
    await mkdir(join(mount, "instances/default/recovery"), { recursive: true, mode: 0o700 });
    const m = await lstat(mount), instance = await lstat(join(mount, "instances/default"));
    const anchor: OriginalHarnessVolumeAnchor = { schema: "paperclip.native-harness-original-volume-anchor.v1", nonce: "b".repeat(64),
      projectId, serviceId, environmentId, volumeId, volumeInstanceId: randomUUID(), mountPath: mount,
      mountIdentity: { dev: m.dev, ino: m.ino }, instanceIdentity: { dev: instance.dev, ino: instance.ino },
      createdFrom: { deploymentId: randomUUID(), commit: "c".repeat(40), providerWitnessSha256: "d".repeat(64) }, createdAt: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(anchor)); await writeFile(originalHarnessVolumeAnchorPath(), bytes, { mode: 0o600 });
    const observed = Date.now();
    const witness: ReviewedOriginalHarnessVolumeWitness = { projectId, serviceId, environmentId, volumeId, volumeInstanceId: anchor.volumeInstanceId,
      mountPath: mount, currentDeploymentId: deploymentId, currentCommit: "a".repeat(40), currentMountIdentity: anchor.mountIdentity,
      currentInstanceIdentity: anchor.instanceIdentity, observedAt: new Date(observed).toISOString(), expiresAt: new Date(observed + 120_000).toISOString(),
      anchorSha256: createHash("sha256").update(bytes).digest("hex"), providerWitnessSha256: "e".repeat(64) };
    const source = await verifyOriginalHarnessVolumeSource(witness);
    const storage = createStorageService({ ...createLocalDiskStorageProvider(join(mount, "objects")), id: "s3" });
    await db.insert(companies).values({ id: companyId, name: "Original-volume preservation", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retained source" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retain prior failure", status: "blocked" });
    const runtimeContext = nativeRuntimeContextFixture();
    if (kind !== "none") {
      let versionId: string | null = null;
      const files: CompanySkillVersionFileInventoryEntry[] = kind === "deleted"
        ? [{ path: "SKILL.md", kind: "skill", content: "# Historical acceptance skill\n\n".padEnd(281, "x") }]
        : [{ path: "SKILL.md", kind: "skill", content: "# original immutable skill\n" },
          { path: "tool.sh", kind: "other" as const, content: "#!/bin/sh\nexit 0\n", executable: true }];
      let projected = files;
      if (kind === "repository") {
        files[0]!.content = "---\nname: retained\ndescription: retained\n---\n# original immutable skill\n";
        projected = repositorySkillProjection(files, "SKILL.md");
      }
      if (kind === "repository" || kind === "package" || kind === "deleted") {
        const packageId = await skillPackageStore(db, storage).prepare(companyId, files, true);
        const [skill] = await db.insert(companySkills).values({ companyId, key: "retained", slug: "retained", name: "Retained", markdown: projected[0]!.content }).returning();
        const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 1,
          ...(kind === "repository" ? { repositorySnapshotId: packageId, repositorySkillPath: "SKILL.md" } : { packageSnapshotId: packageId }), fileInventory: [] }).returning();
        versionId = version!.id;
      }
      const bundle = await materializeAsset(projected.map(file => ({ path: file.path, content: skillFileBytes(file), mode: file.executable ? 0o555 : 0o444 })));
      runtimeContext.skills = [{ key: "retained", runtimeName: "retained", versionId, bundle }];
      runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    }
    const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v3", executionMode: "default", planningContext: null,
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: managedWorkspace ? randomUUID() : runId }, provider: { kind: "codex", model: null },
      task: { identifier: "FS-1", title: "Retain failure", description: null, prompt: "Retain failure", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Retain failure", criteria: [{ id: "retain", requirement: "Retain failure" }] } },
      runtimeContext, interactionResponses: [], credentialBindings: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId: runnerId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(), processPid: 1234, processStartedAt: new Date(0),
      runnerProfileJson: { nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "codex"), retainedWarning: "provider resume remains failed", sessionCheckpoint: {
        backendKind: "runner", driverKind: "codex_app_server", sessionId: "saved-provider-driver", providerSessionId: "saved-provider-session",
        identity: { companyId, agentId, issueId, runId, sessionId }, activeTurnId: null, cursor: "2", goal: null,
      } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure", recoveryState: "blocked" });
    const [selection] = await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId,
      lastRunId: runId, lastError: "existing provider failure" }).returning();
    const scopeDigest = basename(scopedRunnerdStateRoot(execution)), leaseId = randomUUID(), providerLeaseId = `destroyed-${randomUUID()}`;
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, provider: "daytona", providerLeaseId,
      status: "released", cleanupStatus: "success", releasedAt: new Date(), metadata: {
        nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId, runnerInstanceId: runnerId,
          sessionScopeSha256: scopeDigest, sourceProviderLeaseId: providerLeaseId, authorizedProviderLeaseId: providerLeaseId,
          manifestSha256: `sha256:${"f".repeat(64)}`, completedAt: new Date().toISOString() },
        remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId, provider: "daytona", providerLeaseId,
          state: "destroyed", confirmedAt: new Date().toISOString() },
      } });
    if (kind !== "none") {
      if (kind === "unversioned") await preserveRuntimeSkillAssets(db, { companyId, runId }, storage);
      await mkdir(join(scopedRunnerdStateRoot(execution), "codex-home/skills"), { recursive: true, mode: 0o700 });
      await cp(runtimeContext.skills[0]!.bundle.rootPath, join(scopedRunnerdStateRoot(execution), "codex-home/skills/retained"), { recursive: true });
    }
    const input = { companyId, selectedSessionId: selection!.id, scopeDigest, source, storage, signal: AbortSignal.timeout(60_000) };
    return { input, runId, issueId, agentId, leaseId, execution, witness, storage, mount, sourceRoot: scopedRunnerdStateRoot(execution) };
  }

  async function controllerFixture(managedWorkspace = false, kind: Parameters<typeof fixture>[0] = "unversioned", checkpointParts?: number) {
    const f = await fixture(kind, managedWorkspace);
    const completion = await ensureNativeCompletionContract({ db, companyId: f.input.companyId,
      issue: { id: f.issueId, title: "Retain controller evidence", description: null }, actorId: f.agentId });
    const execution = parseNativeExecutionInput({ ...f.execution, session: { ...f.execution.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: completion.row.id, sha256: completion.row.canonicalSha256,
        schemaVersion: completion.row.schemaVersion, contract: completion.contract } });
    const [prior] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const snapshot = prior!.runnerProfileJson!.sessionCheckpoint;
    const descriptor = nativeControllerMigrationDescriptor(execution, nativeToolContractFingerprintForTarget("remote", "codex"));
    const bootId = randomUUID(), leaseOwner = randomUUID();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, completionContractId: completion.row.id,
      completionContractSha256: completion.row.canonicalSha256 }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", controllerBootId: bootId, controllerGeneration: 1,
      leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const identity = { runId: f.runId, normalizedSessionId: execution.session.normalizedSessionId!, runnerInstanceId: prior!.runnerInstanceId!,
      environmentLeaseId: f.leaseId, turnId: randomUUID(), itemId: randomUUID() };
    const control = new DurablePrpControlPlane({ stateDirectory: join(f.sourceRoot, "control-plane"), identity,
      expectedRunnerVersion: "raw-evidence-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
      Object.assign(control.queueCommand(type), { status: "completed", result: { status: "completed" } });
    }
    control.store.state.committedEvents.push({ sourceSeq: 1, sourceEventId: "raw-stream", eventType: "item.delta", priority: 1,
      envelope: { ...identity, text: "Raw stream bytes absent from control-v1 records" }, deliveryCount: 1, logicalEffectCount: 1 },
    { sourceSeq: 2, sourceEventId: "raw-terminal", eventType: "run.terminal", priority: 0,
      envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
    control.store.state.ackedSourceSeq = 2;
    if (checkpointParts) {
      const artifact = { version: "raw-evidence-fixture", digest: `sha256:${"a".repeat(64)}` };
      for (let count = 0; count < 512 && captureLegacyDurablePrpCheckpoint(JSON.stringify(control.store.state), identity, artifact).records.size < checkpointParts; count++) {
        Object.assign(control.queueCommand("runner.suspend"), { status: "completed", result: { status: "completed" } });
      }
      expect(captureLegacyDurablePrpCheckpoint(JSON.stringify(control.store.state), identity, artifact).records.size).toBe(checkpointParts);
    }
    const raw = JSON.stringify(control.store.state);
    control.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, { companyId: f.input.companyId, issueId: f.issueId,
      runId: f.runId, authorityRunId: f.runId, bootId, generation: 1, leaseOwner }));
    await control.flushCheckpoint();
    await control.stop();
    const controllerPath = join(f.sourceRoot, "control-plane/control-plane-state.json");
    await writeFile(controllerPath, raw, { mode: 0o600 });
    const supervisor = JSON.stringify({ schema: "paperclip.native-session-supervisor.v1", configDigest: descriptor.configDigest,
      processConfigDigest: null, snapshot });
    await mkdir(join(descriptor.supervisorPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(descriptor.supervisorPath, supervisor, { mode: 0o600 });
    const [result] = await db.insert(nativeRunResults).values({ companyId: f.input.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: completion.row.id, serverFingerprint: "raw-evidence-fixture", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "a".repeat(64) }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: { ...prior!.runnerProfileJson,
      nativeExecutionInput: execution, nativeControllerRecovery: createNativeControllerRecovery(snapshot as never,
        { configDigest: descriptor.configDigest, processConfigDigest: null },
        { runId: f.runId, runnerInstanceId: prior!.runnerInstanceId!, normalizedSessionId: execution.session.normalizedSessionId! }) } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id, recoveryState: null,
      leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    return { ...f, execution, controllerPath, raw, supervisor, supervisorPath: descriptor.supervisorPath, identity };
  }

  it("preserves WEB-only evidence with a succeeded source and unresolved external lease", async () => {
    const f = await controllerFixture(true, "deleted");
    if (!("runtimeContext" in f.execution)) throw new Error("fixture runtime context missing");
    const versionId = f.execution.runtimeContext.skills[0]!.versionId!;
    await db.delete(companySkillVersions).where(eq(companySkillVersions.id, versionId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const metadata = { ...lease!.metadata }; delete metadata.remoteExecutionTermination;
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.leaseId));
    const beforeLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId));
    const beforeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.input.companyId));
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("unverified");
    const result = await preserveNativeHarnessFilesystemIndependence(db, { ...f.input, mode: "web_evidence" });
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect(await hasLocalNativeHarnessObligations(db)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = run!.runnerProfileJson!.nativeHarnessFilesystemIndependence as { schema: string; controller: { archive: { id: string } } };
    expect(receipt.schema).toBe("paperclip.native-harness-web-evidence.v1");
    const [archive] = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, receipt.controller.archive.id));
    const target = join(f.mount, "isolated-web-evidence");
    expect(await restoreDurableNativeHarnessBackup({ db, storage: f.storage, companyId: f.input.companyId,
      scopeDigest: archive!.scopeDigest, backupRoot: target })).toBe(true);
    expect(await readFile(join(target, "current/control-plane-state.json"), "utf8")).toBe(f.raw);
    expect(await readFile(join(target, "current/supervisor.json"), "utf8")).toBe(f.supervisor);
    const original = join(f.sourceRoot, "codex-home/skills/retained/SKILL.md"), restored = join(target, "current/web-home/codex-home/skills/retained/SKILL.md");
    expect(await readFile(restored)).toEqual(await readFile(original));
    expect((await lstat(restored)).mode & 0o777).toBe(0o444);
    expect((await readFile(restored)).length).toBe(281);
    expect(await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, versionId))).toEqual([]);
    expect(await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.input.scopeDigest))).toEqual([]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId))).toEqual(beforeLeases);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.input.companyId))).toEqual(beforeRuns.map(r => ({ ...r,
      runnerProfileJson: { ...r.runnerProfileJson, nativeHarnessFilesystemIndependence: run!.runnerProfileJson!.nativeHarnessFilesystemIndependence } })));
    vi.stubEnv("PAPERCLIP_HOME", join(f.mount, "absent-web")); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(f.mount, "absent-web/state"));
    vi.stubEnv("RAILWAY_VOLUME_ID", ""); vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("replacement must not read storage"));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  async function webFixture(checkpointParts?: number) {
    const f = await controllerFixture(true, "unversioned", checkpointParts);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const metadata = { ...lease!.metadata }; delete metadata.remoteExecutionTermination;
    await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "failed", releasedAt: null, metadata })
      .where(eq(environmentLeases.id, f.leaseId));
    return { ...f, input: { ...f.input, mode: "web_evidence" as const } };
  }

  it("preserves a genuinely absent controller with its supervisor and 267 durable checkpoint parts", async () => {
    const f = await webFixture(267);
    await rm(f.controllerPath);
    const before = await db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    expect(before).toHaveLength(267);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const lastRunId = randomUUID(), execution = parseNativeExecutionInput({ ...f.execution, binding: { ...f.execution.binding, runId: lastRunId } });
    await db.insert(heartbeatRuns).values({ ...source!, id: lastRunId, status: "failed", processPid: null, processStartedAt: null,
      createdAt: new Date(source!.createdAt.getTime() + 1_000), runnerProfileJson: { nativeExecutionInput: execution, retainedWarning: "existing failed admission" } });
    await db.insert(nativeRunFinalizations).values({ companyId: f.input.companyId, issueId: f.issueId, runId: lastRunId,
      phase: "terminal_failure", recoveryState: "blocked" });
    await db.update(agentTaskSessions).set({ lastRunId }).where(eq(agentTaskSessions.id, f.input.selectedSessionId));
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lastRunId));
    const receipt = run!.runnerProfileJson!.nativeHarnessFilesystemIndependence as { web: { controllerAbsent: boolean };
      controller: { archive: { id: string; controllerDigest: null } } };
    expect(receipt.web.controllerAbsent).toBe(true);
    expect(receipt.controller.archive.controllerDigest).toBeNull();
    const [archive] = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, receipt.controller.archive.id));
    const target = join(f.mount, "isolated-supervisor-only");
    expect(await restoreDurableNativeHarnessBackup({ db, storage: f.storage, companyId: f.input.companyId,
      scopeDigest: archive!.scopeDigest, backupRoot: target })).toBe(true);
    await expect(lstat(join(target, "current/control-plane-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(target, "current/supervisor.json"), "utf8")).toBe(f.supervisor);
    expect(await db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual(before);
    vi.stubEnv("PAPERCLIP_HOME", join(f.mount, "absent-supervisor-host"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(f.mount, "absent-supervisor-host/state")); vi.stubEnv("RAILWAY_VOLUME_ID", "");
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
  });

  it("keeps WEB coverage valid through external cleanup observations without changing recovery authority", async () => {
    const f = await webFixture();
    const result = await preserveNativeHarnessFilesystemIndependence(db, f.input);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "pending", expiresAt: new Date(),
      lastUsedAt: new Date(), releasedAt: new Date(), metadata: { ...lease!.metadata, sandboxState: "archived",
        pendingCleanupRetryAfterMs: Date.now(), pendingCleanupManualAttemptId: randomUUID(),
        pendingCleanupController: { attemptId: randomUUID(), countedAttempt: true }, remoteExecutionTermination: { observation: "not a stop receipt" } } })
      .where(eq(environmentLeases.id, f.leaseId));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect((await preserveNativeHarnessFilesystemIndependence(db, f.input)).receiptDigest).toBe(result.receiptDigest);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
      eq(activityLog.action, "native_harness_filesystem_independence_verified")))).toHaveLength(1);
    await db.update(environmentLeases).set({ providerLeaseId: "different-allocation" }).where(eq(environmentLeases.id, f.leaseId));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
  });

  it.each(["active-web", "owned-finalizer", "physical-writer", "foreign-supervisor", "missing-manifest", "symlink", "foreign-controller"])(
    "refuses WEB evidence with %s and retains the original recovery state", async control => {
      const f = await webFixture(), where = eq(heartbeatRuns.id, f.runId);
      if (control === "active-web") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(where);
      if (control === "owned-finalizer") await db.update(nativeRunFinalizations).set({ leaseOwner: "expired-but-still-owned", leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (control === "physical-writer") { const [run] = await db.select().from(heartbeatRuns).where(where);
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson, nativeWorkspaceFinalizationOwner: { token: "owned" } } }).where(where); }
      if (control === "foreign-supervisor") { const saved = JSON.parse(f.supervisor); saved.snapshot.identity.runId = randomUUID();
        await writeFile(f.supervisorPath, JSON.stringify(saved)); }
      if (control === "foreign-controller") { const saved = JSON.parse(f.raw); saved.identity.runId = randomUUID(); await writeFile(f.controllerPath, JSON.stringify(saved)); }
      if (control === "missing-manifest") { if (!("runtimeContext" in f.execution)) throw new Error("fixture runtime context missing");
        await rm(join(f.mount, "instances/default/runtime-context-assets/manifests", `${f.execution.runtimeContext.skills[0]!.bundle.digest}.json`)); }
      if (control === "symlink") { const file = join(f.sourceRoot, "codex-home/history.jsonl"); await symlink(f.controllerPath, file); }
      try {
        const before = await db.select().from(heartbeatRuns).where(where);
        await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
        expect(await db.select().from(heartbeatRuns).where(where)).toEqual(before);
        expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
      } finally { if (control === "symlink") await rm(join(f.sourceRoot, "codex-home/history.jsonl")); }
    });

  it.each(["changed-byte", "changed-mode", "added-file", "controller-appeared", "changed-source"])(
    "does not publish WEB evidence after %s changes during encrypted upload", async control => {
      const f = await webFixture();
      const originalMode = (await lstat(f.supervisorPath)).mode & 0o777;
      if (control === "controller-appeared") await rm(f.controllerPath);
      const put = f.storage.putFile.bind(f.storage); let changed = false;
      vi.spyOn(f.storage, "putFile").mockImplementation(async (...args) => {
        const result = await put(...args);
        if (!changed) { changed = true;
          if (control === "changed-byte") await writeFile(f.supervisorPath, `${f.supervisor} `);
          if (control === "changed-mode") await chmod(f.supervisorPath, originalMode === 0o400 ? 0o600 : 0o400);
          if (control === "added-file") await writeFile(join(f.sourceRoot, "codex-home/history.jsonl"), "new uncovered bytes");
          if (control === "controller-appeared") await writeFile(f.controllerPath, f.raw);
          if (control === "changed-source") { const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
            await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson, retainedWarning: "new source binding" } }).where(eq(heartbeatRuns.id, f.runId)); }
        } return result;
      });
      await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
      expect(changed).toBe(true);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
        .not.toHaveProperty("nativeHarnessFilesystemIndependence");
      expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
    });

  it.each([false, true])("retains the authenticated WEB publication winner after a late upload (invalid: %s)", async invalid => {
    const f = await webFixture();
    let release!: () => void, entered!: () => void, delay = true;
    const blocked = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const get = f.storage.getObject.bind(f.storage);
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      if (delay) { delay = false; entered(); await blocked; } return get(...args);
    });
    const late = preserveNativeHarnessFilesystemIndependence(db, f.input);
    try {
      await ready;
      const winner = await preserveNativeHarnessFilesystemIndependence(db, f.input);
      let [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      if (invalid) {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...published!.runnerProfileJson,
          nativeHarnessFilesystemIndependence: { ...(published!.runnerProfileJson!.nativeHarnessFilesystemIndependence as Record<string, unknown>), assetsDigest: "0".repeat(64) } } })
          .where(eq(heartbeatRuns.id, f.runId));
        [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      }
      release();
      if (invalid) await expect(late).rejects.toThrow("unverified");
      else expect((await late).receiptDigest).toBe(winner.receiptDigest);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(published);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
        eq(activityLog.action, "native_harness_filesystem_independence_verified")))).toHaveLength(1);
    } finally { release(); await late.catch(() => undefined); }
  });

  it.each(["missing-entry", "changed-source"])("refuses existing WEB coverage after %s without replacing its receipt", async control => {
    const f = await webFixture(); await preserveNativeHarnessFilesystemIndependence(db, f.input);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = run!.runnerProfileJson!.nativeHarnessFilesystemIndependence as Record<string, unknown> & { web: { entries: Array<{ path: string }> } };
    const profile = control === "missing-entry" ? { ...run!.runnerProfileJson, nativeHarnessFilesystemIndependence: { ...receipt,
      web: { ...receipt.web, entries: receipt.web.entries.filter(entry => entry.path !== "web-supervisor.json") } } }
      : { ...run!.runnerProfileJson, sessionCheckpoint: { changed: true } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson).toEqual(profile);
  });

  async function historyFixture(keepHistoricalHeaders = false, includeRunnerState = false) {
    const f = await controllerFixture(true);
    const get = f.storage.getObject.bind(f.storage);
    const held = vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      if (args[1].includes("/skill-packages/")) throw new Error("fixture package verification held");
      return get(...args);
    });
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("fixture package verification held");
    held.mockRestore();
    const [currentOnly] = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, f.runId));
    expect(currentOnly?.status).toBe("current");
    const [anchor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const entries: Array<{ path: string; contents: string; runId: string; header: typeof nativeRunnerCheckpoints.$inferSelect;
      runner?: { path: string; contents: string } }> = [];
    for (let index = 1; index <= 3; index++) {
      const runId = randomUUID(), bootId = randomUUID(), leaseOwner = randomUUID(), leaseId = randomUUID();
      const execution = parseNativeExecutionInput({ ...f.execution, binding: { ...f.execution.binding, runId } });
      const snapshot = { ...(anchor!.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>),
        identity: { companyId: f.input.companyId, agentId: f.agentId, issueId: f.issueId, runId,
          sessionId: execution.session.normalizedSessionId } };
      await db.insert(heartbeatRuns).values({ ...anchor!, id: runId, status: "running", finishedAt: null,
        createdAt: new Date(anchor!.createdAt.getTime() - index * 60_000),
        runnerProfileJson: { ...anchor!.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot } });
      await db.insert(nativeRunFinalizations).values({ companyId: f.input.companyId, issueId: f.issueId, runId,
        phase: "observed", controllerBootId: bootId, controllerGeneration: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
      const identity = { ...f.identity, environmentLeaseId: execution.binding.executionWorkspaceId, runId, turnId: randomUUID(), itemId: randomUUID() };
      let epoch = "epoch-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
      let path = join("authority-epochs", epoch, "control-plane/control-plane-state.json");
      const control = new DurablePrpControlPlane({ stateDirectory: join(f.sourceRoot, "authority-epochs", epoch, "control-plane"),
        identity, expectedRunnerVersion: "raw-evidence-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
        Object.assign(control.queueCommand(type), { status: "completed", result: { status: "completed" } });
      }
      control.store.state.committedEvents.push({ sourceSeq: 1, sourceEventId: `retired-stream-${index}`, eventType: "item.delta", priority: 1,
        envelope: { ...identity, text: `Retained historical stream ${index}` }, deliveryCount: 1, logicalEffectCount: 1 });
      control.store.state.ackedSourceSeq = 1;
      const contents = JSON.stringify(control.store.state);
      control.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, { companyId: f.input.companyId, issueId: f.issueId,
        runId, authorityRunId: runId, bootId, generation: 1, leaseOwner }));
      await control.flushCheckpoint(); await control.stop();
      const canonicalEpoch = "epoch-" + createHash("sha256").update(JSON.stringify(JSON.parse(contents).identity)).digest("hex").slice(0, 24);
      if (canonicalEpoch !== epoch) {
        await rename(join(f.sourceRoot, "authority-epochs", epoch), join(f.sourceRoot, "authority-epochs", canonicalEpoch));
        epoch = canonicalEpoch; path = join("authority-epochs", epoch, "control-plane/control-plane-state.json");
      }
      await writeFile(join(f.sourceRoot, path), contents, { mode: 0o600 });
      const runner = includeRunnerState ? { path: join("authority-epochs", epoch, "runner-state.json"), contents: JSON.stringify({
        schema: "paperclip.runner.durable.state.v1", ...JSON.parse(contents).identity, lifecycle: "suspended",
        nextSourceSeq: 2, ackedSourceSeq: 1, lastControllerCommandSeq: 4, reconnectCount: 0,
        outbox: [{ sourceSeq: 2, sourceEventId: `retired-outbox-${index}`, eventType: "item.delta",
          payload: { text: `Suspended historical outbox ${index}` } }], processedCommands: {}, diagnostics: ["retained suspended authority"],
      }) } : undefined;
      if (runner) await writeFile(join(f.sourceRoot, runner.path), runner.contents, { mode: 0o600 });
      const [result] = await db.insert(nativeRunResults).values({ companyId: f.input.companyId, issueId: f.issueId, runId,
        completionContractId: anchor!.completionContractId!, serverFingerprint: "historical-evidence-fixture", schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: "a".repeat(64) }).returning();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, runId));
      const [header] = await db.select().from(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, runId), eq(nativeRunnerCheckpoints.part, "header")));
      expect(header).toBeDefined();
      if (!keepHistoricalHeaders) await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
      const providerLeaseId = `destroyed-${randomUUID()}`;
      await db.insert(environmentLeases).values({ ...lease!, id: leaseId, heartbeatRunId: runId, providerLeaseId,
        metadata: { ...lease!.metadata, nativeHarnessBackup: { ...(lease!.metadata!.nativeHarnessBackup as Record<string, unknown>),
          sourceProviderLeaseId: providerLeaseId, authorizedProviderLeaseId: providerLeaseId },
        remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: f.input.companyId, runId, leaseId,
          provider: "daytona", providerLeaseId, state: "destroyed", confirmedAt: new Date().toISOString() } } });
      entries.push({ path, contents, runId, header: header!, runner });
    }
    return { ...f, entries, currentOnly: currentOnly! };
  }

  it.each([false, true])("preserves a four-run session's three authority epochs with suspended Runner state %s and validates without the original volume", async includeRunnerState => {
    const f = await historyFixture(false, includeRunnerState);
    const beforeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.input.companyId));
    const beforeLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId));
    for (const entry of f.entries) expect(await db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, entry.runId))).toEqual([]);
    const result = await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    const [anchor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = anchor!.runnerProfileJson!.nativeHarnessFilesystemIndependence as { controller: { archive: { id: string } } };
    const [archive] = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, receipt.controller.archive.id));
    expect(archive!.id).not.toBe(f.currentOnly.id);
    expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, f.currentOnly.id)))[0]).toEqual(f.currentOnly);
    const target = join(f.mount, "isolated-authority-evidence");
    expect(await restoreDurableNativeHarnessBackup({ db, storage: f.storage, companyId: f.input.companyId,
      scopeDigest: archive!.scopeDigest, backupRoot: target })).toBe(true);
    for (const entry of f.entries) {
      for (const file of [entry, ...(entry.runner ? [entry.runner] : [])]) {
        expect(await readFile(join(target, "current", file.path), "utf8")).toBe(file.contents);
        expect((await lstat(join(target, "current", file.path))).mode & 0o777).toBe(0o600);
        expect(await readFile(join(f.sourceRoot, file.path), "utf8")).toBe(file.contents);
      }
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.input.companyId))).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(beforeRuns.map(run => run.id === f.runId ? { ...run, runnerProfileJson: { ...run.runnerProfileJson,
        nativeHarnessFilesystemIndependence: anchor!.runnerProfileJson!.nativeHarnessFilesystemIndependence } } : run).sort((a, b) => a.id.localeCompare(b.id)));
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId))).toEqual(beforeLeases);
    vi.stubEnv("PAPERCLIP_HOME", join(f.mount, "absent-replacement")); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(f.mount, "absent-replacement/state"));
    vi.stubEnv("RAILWAY_VOLUME_ID", ""); vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("replacement must not read storage"));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect(result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["active", "foreign-identity"])("retains historical Runner state without publication for %s", async control => {
    const f = await historyFixture(false, true), runner = f.entries[0]!.runner!, value = JSON.parse(runner.contents);
    if (control === "active") value.lifecycle = "active";
    else value.runId = randomUUID();
    const contents = JSON.stringify(value), path = join(f.sourceRoot, runner.path);
    await writeFile(path, contents);
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("native_harness_filesystem_independence_unverified");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, f.currentOnly.id)))[0]).toEqual(f.currentOnly);
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("bounds historical evidence at sixteen MiB per file and sixty-four MiB total", () => {
    const limit = 16 * 1024 * 1024;
    const descriptor = (sizes: number[]) => nativeControllerEvidenceDescriptor({ companyId: randomUUID(), issueId: randomUUID(),
      runId: randomUUID(), controllerDigest: "a".repeat(64), supervisorDigest: null, purpose: "filesystem_independence",
      historyBindingDigest: "b".repeat(64), history: [{ path: "authority-epochs", mode: 0o700, type: "directory" },
        ...sizes.flatMap((size, index) => {
          const root = `authority-epochs/epoch-${index.toString(16).padStart(24, "0")}`;
          return [{ path: root, mode: 0o700, type: "directory" as const },
            { path: `${root}/control-plane`, mode: 0o700, type: "directory" as const },
            { path: `${root}/control-plane/control-plane-state.json`, mode: 0o600, type: "file" as const, size, sha256: "c".repeat(64) }];
        })] });
    expect(() => descriptor([limit])).not.toThrow();
    expect(() => descriptor([limit + 1])).toThrow("native_controller_archive_authority_invalid");
    expect(() => descriptor([limit, limit, limit, limit])).not.toThrow();
    expect(() => descriptor([limit, limit, limit, limit, 1])).toThrow("native_controller_archive_authority_invalid");
  });

  it("retains an oversized historical file and its existing archive without publication", async () => {
    const f = await historyFixture(), path = join(f.sourceRoot, f.entries[0]!.path);
    await truncate(path, 20 * 1024 * 1024);
    const put = vi.spyOn(f.storage, "putFile");
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("native_harness_filesystem_independence_unverified");
    expect(put).not.toHaveBeenCalled();
    expect((await lstat(path)).size).toBe(20 * 1024 * 1024);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, f.currentOnly.id)))[0]).toEqual(f.currentOnly);
  });

  it.each(["foreign", "unknown", "active-owner", "changed-after-upload", "added-after-upload"])("retains authority history without publication for %s", async control => {
    const f = await historyFixture(), path = join(f.sourceRoot, f.entries[0]!.path);
    if (control === "foreign") {
      const value = JSON.parse(f.entries[0]!.contents); value.identity.runId = randomUUID();
      await writeFile(path, JSON.stringify(value));
    }
    if (control === "unknown") await writeFile(join(path, "..", "unknown.json"), "uncovered retained data");
    if (control === "active-owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned", leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.entries[0]!.runId));
    if (control.endsWith("after-upload")) {
      const put = f.storage.putFile.bind(f.storage);
      vi.spyOn(f.storage, "putFile").mockImplementation(async args => {
        const result = await put(args);
        if (control === "changed-after-upload") await writeFile(path, f.entries[0]!.contents + "\n");
        else await writeFile(join(path, "..", "new-uncovered.json"), "new retained data");
        return result;
      });
    }
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, f.currentOnly.id)))[0]).toEqual(f.currentOnly);
    expect((await lstat(path)).isFile()).toBe(true);
  });

  it("invalidates authority history coverage when a retained historical header disappears", async () => {
    const f = await historyFixture(true);
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    await db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, f.entries[0]!.runId), eq(nativeRunnerCheckpoints.part, "header")));
    vi.stubEnv("PAPERCLIP_HOME", join(f.mount, "absent-replacement")); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(f.mount, "absent-replacement/state"));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
    expect(await readFile(join(f.sourceRoot, f.entries[0]!.path), "utf8")).toBe(f.entries[0]!.contents);
  });

  it.each(["new-header", "receipt-identity", "missing-history"])("invalidates published authority history after %s changes", async control => {
    const f = await historyFixture();
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    if (control === "new-header") await db.insert(nativeRunnerCheckpoints).values(f.entries[0]!.header);
    else {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const profile = structuredClone(run!.runnerProfileJson!);
      const receipt = profile.nativeHarnessFilesystemIndependence as { controller: { history?: { epochs: Array<{ identity: { turnId: string }; identityDigest: string }> } } };
      if (control === "missing-history") delete receipt.controller.history;
      else {
        receipt.controller.history!.epochs[0]!.identity.turnId = randomUUID();
        receipt.controller.history!.epochs[0]!.identityDigest = nativeSha256(receipt.controller.history!.epochs[0]!.identity);
      }
      await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
    }
    vi.stubEnv("PAPERCLIP_HOME", join(f.mount, "absent-replacement")); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(f.mount, "absent-replacement/state"));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
    expect(await readFile(join(f.sourceRoot, f.entries[0]!.path), "utf8")).toBe(f.entries[0]!.contents);
  });

  it.each(["malformed", "retired", "unknown-override"])("refuses historical authority coverage with %s identity evidence", async control => {
    const f = await historyFixture(control !== "unknown-override"), entry = f.entries[0]!;
    if (control === "malformed") await db.update(nativeRunnerCheckpoints).set({ material: { schema: "unreadable" } })
      .where(and(eq(nativeRunnerCheckpoints.runId, entry.runId), eq(nativeRunnerCheckpoints.part, "header")));
    if (control === "retired") await db.update(nativeRunnerCheckpoints).set({ material: nativeCheckpointRetirement({ companyId: f.input.companyId,
      agentId: f.agentId, sessionId: f.execution.session.normalizedSessionId!, runIds: [entry.runId] }) })
      .where(and(eq(nativeRunnerCheckpoints.runId, entry.runId), eq(nativeRunnerCheckpoints.part, "header")));
    if (control === "unknown-override") {
      const value = JSON.parse(entry.contents); value.identity.environmentLeaseId = randomUUID();
      await writeFile(join(f.sourceRoot, entry.path), JSON.stringify(value));
      const previous = entry.path.split("/")[1]!, next = "epoch-" + createHash("sha256").update(JSON.stringify(value.identity)).digest("hex").slice(0, 24);
      await rename(join(f.sourceRoot, "authority-epochs", previous), join(f.sourceRoot, "authority-epochs", next));
    }
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, f.currentOnly.id)))[0]).toEqual(f.currentOnly);
  });

  it("retains the first complete authority-history archive and receipt when an upload finishes late", async () => {
    const f = await historyFixture();
    let release!: () => void, entered!: () => void, delay = true;
    const blocked = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async args => {
      if (delay) { delay = false; entered(); await blocked; }
      return put(args);
    });
    const late = preserveNativeHarnessFilesystemIndependence(db, f.input);
    void late.catch(() => undefined);
    try {
      await ready;
      const winner = await preserveNativeHarnessFilesystemIndependence(db, f.input);
      const [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      release(); expect((await late).receiptDigest).toBe(winner.receiptDigest);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(published);
      expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
        eq(activityLog.action, "native_harness_filesystem_independence_verified")))).toHaveLength(1);
    } finally { release(); await late.catch(() => undefined); }
  });

  it("publishes only independence and validates on an empty replacement without the source capability", async () => {
    const f = await fixture();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(await hasLocalNativeHarnessObligations(db)).toBe(true);
    const [unrelated] = await db.insert(heartbeatRuns).values({ companyId: f.input.companyId, agentId: f.agentId, status: "running", runtimeMode: "native" }).returning();
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasLocalNativeHarnessObligations(db)).toBe(false);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(after).toEqual({ ...before, runnerProfileJson: { ...before!.runnerProfileJson,
      nativeHarnessFilesystemIndependence: after!.runnerProfileJson!.nativeHarnessFilesystemIndependence } });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(lease);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", leaseOwner: null });
    expect(await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, f.input.companyId))).toEqual([]);
    expect(await readFile(join(f.sourceRoot, "codex-home/skills/retained/SKILL.md"), "utf8")).toBe("# original immutable skill\n");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated!.id)))[0]!.status).toBe("running");
    const replacement = await realpath(await mkdtemp(join(tmpdir(), "native-harness-replacement-"))); roots.push(replacement);
    vi.stubEnv("PAPERCLIP_HOME", replacement); vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(replacement, "state"));
    vi.stubEnv("RAILWAY_VOLUME_ID", ""); vi.stubEnv("RAILWAY_DEPLOYMENT_ID", randomUUID());
    const get = vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("startup must not read objects"));
    expect(await hasLocalNativeHarnessObligations(db)).toBe(false); expect(get).not.toHaveBeenCalled();
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
      eq(activityLog.action, "native_harness_filesystem_independence_verified"))))).toHaveLength(1);
  });

  it.each(["history", "changed-skill", "backup-present", "unknown-provider", "owned-finalizer", "physical-writer", "storage-failure", "changed-binding"])("refuses %s without publishing or changing recovery", async control => {
    const f = await fixture(), where = eq(heartbeatRuns.id, f.runId);
    if (control === "history") await writeFile(join(f.sourceRoot, "codex-home/history.jsonl"), "retained conversation");
    if (control === "changed-skill") { await chmod(join(f.sourceRoot, "codex-home/skills/retained"), 0o700); await writeFile(join(f.sourceRoot, "codex-home/skills/retained/extra"), "uncovered user bytes"); }
    if (control === "backup-present") await mkdir(join(f.sourceRoot, "failover-backups/current"), { recursive: true });
    if (control === "unknown-provider") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.leaseId));
    if (control === "owned-finalizer") await db.update(nativeRunFinalizations).set({ leaseOwner: "expired-but-owned", leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (control === "physical-writer") { const [r] = await db.select().from(heartbeatRuns).where(where); await db.update(heartbeatRuns).set({ runnerProfileJson: { ...r!.runnerProfileJson, nativeWorkspaceFinalizationOwner: { token: "still-owned" } } }).where(where); }
    if (control === "storage-failure") vi.spyOn(f.storage, "getObject").mockRejectedValue(new Error("unavailable object"));
    if (control === "changed-binding") { const get = f.storage.getObject.bind(f.storage); let changed = false;
      vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => { const result = await get(...args); if (!changed) { changed = true;
        const [row] = await db.select().from(heartbeatRuns).where(where); await db.update(heartbeatRuns).set({ runnerProfileJson: { ...row!.runnerProfileJson, retainedWarning: "newer warning" } }).where(where); } return result; }); }
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(where))[0]!.runnerProfileJson).not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect(await hasLocalNativeHarnessObligations(db)).toBe(true);
  });

  it.each(["checkpoint", "lease", "package", "retained-selection", "malformed-stamp"])("invalidates a published receipt after changed %s", async control => {
    const f = await fixture(); await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    if (control === "checkpoint") { const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...r!.runnerProfileJson, sessionCheckpoint: { changed: true } } }).where(eq(heartbeatRuns.id, f.runId)); }
    if (control === "lease") await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.leaseId));
    if (control === "package") await db.update(companySkillRepositorySnapshots).set({ storage: null }).where(eq(companySkillRepositorySnapshots.companyId, f.input.companyId));
    if (control === "retained-selection") await db.update(agentTaskSessions).set({ lastRunId: null }).where(eq(agentTaskSessions.id, f.input.selectedSessionId));
    if (control === "malformed-stamp") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const stamp = { ...(lease!.metadata!.nativeHarnessBackup as Record<string, unknown>) }; delete stamp.sessionScopeSha256;
      await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeHarnessBackup: stamp } }).where(eq(environmentLeases.id, f.leaseId));
      expect(await hasLocalNativeHarnessObligations(db)).toBe(true);
    }
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
  });
  it.each(["repository", "package"] as const)("uses the exact retained %s version rather than today's head", async kind => {
    const f = await fixture(kind);
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeRuntimeSkillPreservation");
    await db.delete(companySkillVersions).where(eq(companySkillVersions.companyId, f.input.companyId));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
  });
  it("does not publish across the actual physical-finalization lock", async () => {
    const f = await fixture("none");
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const owner = db.transaction(async tx => { expect(await tryLockNativeWorkspaceFinalization(tx as unknown as typeof db,
      { companyId: f.input.companyId, runId: f.runId })).toBe(true); acquired(); await held; });
    try { await ready; await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("unverified"); }
    finally { release(); await owner; }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
  });
  it("retains the first publication through concurrent attempts and an ordinary retry", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([preserveNativeHarnessFilesystemIndependence(db, f.input), preserveNativeHarnessFilesystemIndependence(db, f.input)]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeGreaterThan(0);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
      eq(activityLog.action, "native_harness_filesystem_independence_verified")))).toHaveLength(1);
  });
  it.each([false, true])("retains or refuses the existing receipt when an earlier capture finishes late (invalid: %s)", async invalid => {
    const f = await fixture();
    let release!: () => void, entered!: () => void, delay = true;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const get = f.storage.getObject.bind(f.storage);
    vi.spyOn(f.storage, "getObject").mockImplementation(async (...args) => {
      if (delay) { delay = false; entered(); await blocked; }
      return get(...args);
    });
    const late = preserveNativeHarnessFilesystemIndependence(db, f.input);
    try {
      await ready;
      const winner = await preserveNativeHarnessFilesystemIndependence(db, f.input);
      let [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      if (invalid) {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...published!.runnerProfileJson,
          nativeHarnessFilesystemIndependence: { ...(published!.runnerProfileJson!.nativeHarnessFilesystemIndependence as Record<string, unknown>), assetsDigest: "0".repeat(64) } } }).where(eq(heartbeatRuns.id, f.runId));
        [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      }
      release();
      if (invalid) await expect(late).rejects.toThrow("unverified");
      else expect((await late).receiptDigest).toBe(winner.receiptDigest);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(published);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
        eq(activityLog.action, "native_harness_filesystem_independence_verified")))).toHaveLength(1);
    } finally { release(); await late.catch(() => undefined); }
  });
  it("archives the successful source's raw controller and supervisor without changing execution authority", async () => {
    const f = await controllerFixture();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const checkpoint = await loadNativeRunnerCheckpoint(db, { companyId: f.input.companyId, issueId: f.issueId, runId: f.runId });
    const captured = captureLegacyDurablePrpCheckpoint(f.raw, { runId: f.runId, runnerInstanceId: before!.runnerInstanceId!,
      normalizedSessionId: before!.nativeSessionId! }, { version: checkpoint!.runnerVersion, digest: checkpoint!.runnerDigest });
    expect([...captured.records].map(([key, value]) => [key, JSON.parse(value)])).toEqual(
      [...checkpoint!.records].map(([key, value]) => [key, JSON.parse(value)]));
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    const rows = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, f.input.companyId));
    expect(rows).toHaveLength(1); expect(rows[0]!.scopeDigest).not.toBe(f.input.scopeDigest);
    expect(rows[0]!.status).toBe("current");
    const restored = join(f.mount, "isolated-raw-evidence");
    expect(await restoreDurableNativeHarnessBackup({ db, storage: f.storage, companyId: f.input.companyId,
      scopeDigest: rows[0]!.scopeDigest, backupRoot: restored })).toBe(true);
    expect(await readFile(join(restored, "current/control-plane-state.json"), "utf8")).toBe(f.raw);
    expect(await readFile(join(restored, "current/supervisor.json"), "utf8")).toBe(f.supervisor);
    expect(JSON.parse(await readFile(join(restored, "current/manifest.json"), "utf8")))
      .toMatchObject({ schema: "paperclip.legacy-controller-archive.v1", reason: "original_volume_source_evidence" });
    expect(await readFile(join(restored, "current/manifest.json"), "utf8")).toBe(JSON.stringify({ schema: "paperclip.legacy-controller-archive.v1",
      companyId: f.input.companyId, issueId: f.issueId, runId: f.runId, reason: "original_volume_source_evidence",
      files: { "control-plane-state.json": createHash("sha256").update(f.raw).digest("hex"),
        "supervisor.json": createHash("sha256").update(f.supervisor).digest("hex") } }));
    expect(await readFile(f.controllerPath, "utf8")).toBe(f.raw);
    expect(await readFile(f.supervisorPath, "utf8")).toBe(f.supervisor);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect((after!.runnerProfileJson!.nativeHarnessFilesystemIndependence as { controller: unknown }).controller).not.toHaveProperty("history");
    expect(after).toEqual({ ...before, runnerProfileJson: { ...before!.runnerProfileJson,
      nativeHarnessFilesystemIndependence: after!.runnerProfileJson!.nativeHarnessFilesystemIndependence } });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(owner);
    expect(await hasLocalNativeHarnessObligations(db)).toBe(false);
  });
  it.each(["codex-home", "opencode", "acpx"])("retains omitted %s history after switching to a preconfigured home", async directory => {
    const f = await fixture("none");
    const execution = parseNativeExecutionInput({ ...f.execution, schema: "paperclip.native-execution-input.v7", homeMode: "preconfigured",
      provider: { kind: "codex", model: null, approvalPolicy: "never" } });
    expect(scopedRunnerdStateRoot(execution)).toBe(f.sourceRoot);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before!.runnerProfileJson,
      nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
    const history = join(f.sourceRoot, directory, "history.json");
    await mkdir(join(history, ".."), { recursive: true, mode: 0o700 });
    await writeFile(history, "original provider history", { mode: 0o600 });
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow("unverified");
    expect(await readFile(history, "utf8")).toBe("original provider history");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    expect(await hasLocalNativeHarnessObligations(db)).toBe(true);
  });
  it("permits a preconfigured home only when no omitted provider directory remains", async () => {
    const f = await fixture("none");
    const execution = parseNativeExecutionInput({ ...f.execution, schema: "paperclip.native-execution-input.v7", homeMode: "preconfigured",
      provider: { kind: "codex", model: null, approvalPolicy: "never" } });
    expect(scopedRunnerdStateRoot(execution)).toBe(f.sourceRoot);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...before!.runnerProfileJson,
      nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    expect(await hasLocalNativeHarnessObligations(db)).toBe(false);
  });
  it("retains the first authenticated controller archive when a capture uploads late", async () => {
    const f = await controllerFixture();
    let release!: () => void, entered!: () => void, delay = true;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async args => {
      const result = await put(args);
      if (delay) { delay = false; entered(); await blocked; }
      return result;
    });
    const late = preserveNativeHarnessFilesystemIndependence(db, f.input);
    try {
      await ready;
      const winner = await preserveNativeHarnessFilesystemIndependence(db, f.input);
      const [published] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [archive] = await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, f.input.companyId),
        eq(nativeHarnessBackups.status, "current")));
      release();
      expect((await late).receiptDigest).toBe(winner.receiptDigest);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(published);
      expect(await db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.companyId, f.input.companyId),
        eq(nativeHarnessBackups.status, "current")))).toEqual([archive]);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.input.companyId),
        eq(activityLog.action, "native_controller_source_evidence_preserved")))).toHaveLength(1);
      expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    } finally { release(); await late.catch(() => undefined); }
  });
  it.each(["checkpoint", "archive"])("invalidates preserved raw coverage when its %s binding changes", async binding => {
    const f = await controllerFixture();
    await preserveNativeHarnessFilesystemIndependence(db, f.input);
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(true);
    if (binding === "checkpoint") await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    else await db.update(nativeHarnessBackups).set({ status: "retired" }).where(eq(nativeHarnessBackups.companyId, f.input.companyId));
    expect(await hasValidNativeHarnessFilesystemIndependence(db, f.input)).toBe(false);
    expect(await hasLocalNativeHarnessObligations(db)).toBe(true);
  });
  it.each(["missing-checkpoint", "foreign-controller", "active-source", "changed-after-upload"])("holds raw controller evidence for %s", async control => {
    const f = await controllerFixture();
    if (control === "missing-checkpoint") await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    if (control === "foreign-controller") { const raw = JSON.parse(f.raw); raw.identity.runId = randomUUID(); await writeFile(f.controllerPath, JSON.stringify(raw)); }
    if (control === "active-source") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    if (control === "changed-after-upload") { const put = f.storage.putFile.bind(f.storage); vi.spyOn(f.storage, "putFile").mockImplementation(async args => {
      const result = await put(args); await writeFile(f.controllerPath, f.raw + "\n"); return result;
    }); }
    await expect(preserveNativeHarnessFilesystemIndependence(db, f.input)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeHarnessFilesystemIndependence");
    const rows = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, f.input.companyId));
    expect(rows.every(row => row.status === "pending")).toBe(true);
  });
});
