import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activityLog, agentTaskSessions, agents, companies, companySkills, companySkillVersions, companySkillRepositorySnapshots, createDb, environmentLeases,
  heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { describeEmbeddedPostgres } from "../../__tests__/helpers/native-restart.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { preserveRuntimeSkillAssets } from "./runtime-skill-preservation.js";
import { scopedRunnerdStateRoot } from "./native-session-executor.js";
import { hasLocalNativeHarnessObligations } from "./native-harness-backup-migration.js";
import { preserveNativeHarnessFilesystemIndependence, hasValidNativeHarnessFilesystemIndependence } from "./native-harness-filesystem-independence.js";
import { originalHarnessVolumeAnchorPath, verifyOriginalHarnessVolumeSource, type OriginalHarnessVolumeAnchor,
  type ReviewedOriginalHarnessVolumeWitness } from "./native-harness-original-volume.js";
import { removeRuntimeAssetTree } from "./runtime-asset-retention.js";
import { skillPackageStore } from "../skill-package-store.js";
import { repositorySkillProjection } from "../skill-repository-package.js";
import { skillFileBytes } from "../skill-snapshot.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";

vi.mock("../../build-commit.js", () => ({ readBuildCommit: () => "a".repeat(40) }));

describeEmbeddedPostgres("owner-verified native harness filesystem independence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-harness-filesystem-"); db = createDb(database.connectionString); }, 90_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.delete(agentTaskSessions); for (const root of roots.splice(0)) await removeRuntimeAssetTree(root); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(kind: "unversioned" | "repository" | "package" | "none" = "unversioned") {
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
    const witness: ReviewedOriginalHarnessVolumeWitness = { projectId, serviceId, environmentId, volumeId, volumeInstanceId: anchor.volumeInstanceId,
      mountPath: mount, currentDeploymentId: deploymentId, currentCommit: "a".repeat(40), currentMountIdentity: anchor.mountIdentity,
      currentInstanceIdentity: anchor.instanceIdentity, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
      anchorSha256: createHash("sha256").update(bytes).digest("hex"), providerWitnessSha256: "e".repeat(64) };
    const source = await verifyOriginalHarnessVolumeSource(witness);
    const storage = createStorageService({ ...createLocalDiskStorageProvider(join(mount, "objects")), id: "s3" });
    await db.insert(companies).values({ id: companyId, name: "Original-volume preservation", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retained source" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retain prior failure", status: "blocked" });
    const runtimeContext = nativeRuntimeContextFixture();
    if (kind !== "none") {
      let versionId: string | null = null;
      const files: CompanySkillVersionFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill", content: "# original immutable skill\n" },
        { path: "tool.sh", kind: "other" as const, content: "#!/bin/sh\nexit 0\n", executable: true }];
      let projected = files;
      if (kind === "repository") {
        files[0]!.content = "---\nname: retained\ndescription: retained\n---\n# original immutable skill\n";
        projected = repositorySkillProjection(files, "SKILL.md");
      }
      if (kind === "repository" || kind === "package") {
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
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: runId }, provider: { kind: "codex", model: null },
      task: { identifier: "FS-1", title: "Retain failure", description: null, prompt: "Retain failure", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Retain failure", criteria: [{ id: "retain", requirement: "Retain failure" }] } },
      runtimeContext, interactionResponses: [], credentialBindings: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId: runnerId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(), processPid: 1234, processStartedAt: new Date(0),
      runnerProfileJson: { nativeExecutionInput: execution, retainedWarning: "provider resume remains failed", sessionCheckpoint: {
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
});
