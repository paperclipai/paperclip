import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, symlink, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { agentTaskSessions, environmentLeases, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, nativeRunResults,
  nativeProviderArtifacts, nativeProviderArtifactReferences, nativeRunnerCheckpoints } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup,
  verifyDurableNativeHarnessBackup, deleteRetiredNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { buildNativeHarnessBackupManifest } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { hasLocalNativeHarnessObligations, migrateNativeHarnessBackups, prestageNativeHarnessBackups } from "./native-harness-backup-migration.js";
import { nativeHarnessBackupExpirationService } from "./native-harness-backup-expiration.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { DurablePrpControlPlane, captureLegacyDurablePrpCheckpoint } from "../../vendor/paperclip-runner/index.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { restoreNativeProviderArtifacts } from "./native-provider-artifacts.js";
import * as backupArchive from "./native-harness-backup-archive.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const files = { ...original };
  return { ...original, default: files, cp: (...args: Parameters<typeof original.cp>) => files.cp(...args) };
});

describeEmbeddedPostgres("durable native provider backups", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  afterEach(async () => {
    for (const home of ownedHomes.splice(0)) await removeNativeHarnessBackup(home);
    vi.unstubAllEnvs();
  });
  async function fixture(provider = "codex") {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, runtimeRoot, successor } = environment.current;
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: "backup-writer", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId, issueId: f.issueId, runId: f.runId, bootId: successor.bootId });
    const home = join(runtimeRoot, randomUUID()), root = join(home, "failover-backups", "current");
    ownedHomes.push(home);
    await mkdir(join(root, provider, "sessions"), { recursive: true });
    await mkdir(join(root, "runner"));
    const identity = { normalizedSessionId: randomUUID(), providerSessionId: randomUUID(), provider };
    await writeFile(join(root, provider, "sessions", "history.json"), JSON.stringify(identity), { mode: 0o600 });
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ runId: f.runId, lifecycle: "suspended" }), { mode: 0o600 });
    const manifest = JSON.stringify({ schema: "paperclip.native-harness-backup.v1", ...identity, directories: [provider, "runner"] });
    await writeFile(join(root, "manifest.json"), manifest, { mode: 0o600 });
    await chmod(join(root, provider, "sessions"), 0o500);
    const sessionScopeId = randomUUID(), scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    return { ...f, home, root, companyId, owner, scopeDigest, sessionScopeId, storage, identity,
      manifestSha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}` };
  }
  async function offlineFixture(base: string) {
    const f = await fixture("codex-home"), home = join(base, f.scopeDigest);
    await rename(f.home, home);
    const root = join(home, "failover-backups", "current"), runnerInstanceId = randomUUID(), providerLeaseId = randomUUID();
    const execution = { provider: { kind: "codex" }, binding: { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, agentId: environment.current.agentId, executionWorkspaceId: randomUUID() },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.identity.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: f.identity.providerSessionId }, sourceProviderLeaseId: providerLeaseId });
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId: f.sessionScopeId,
      authorizedProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId, completedAt: manifest.completedAt });
    await f.db.update(heartbeatRuns).set({ nativeSessionId: f.identity.normalizedSessionId, runnerInstanceId }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      providerLeaseId, status: "expired", metadata: { nativeHarnessBackup: stamp } });
    return { ...f, home, root, runnerInstanceId, providerLeaseId };
  }
  async function offlineFixtures(count: number) {
    const base = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(base); await mkdir(base);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    const fixtures = [];
    for (let i = 0; i < count; i++) fixtures.push(await offlineFixture(base));
    const runs = await fixtures[0].db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixtures[0].companyId));
    for (const run of runs) await settle({ ...fixtures[0], runId: run.id, issueId: run.issueId! }, new Date());
    return fixtures.sort((a, b) => a.scopeDigest.localeCompare(b.scopeDigest));
  }
  it("overlaps verified offline backups within a four-transfer bound and restores their bytes", async () => {
    const fixtures = await offlineFixtures(6), f = fixtures[0], gate = deferred();
    const put = f.storage.putFile.bind(f.storage); let active = 0, peak = 0, entered = 0;
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      active++; entered++; peak = Math.max(peak, active);
      try { await gate.promise; return await put(input); } finally { active--; }
    });
    const migration = migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) });
    try { await vi.waitFor(() => expect(active).toBe(4), { timeout: 3000 }); }
    finally { gate.resolve(); await migration.catch(() => undefined); }
    expect(await migration).toBe(6); expect(peak).toBe(4); expect(entered).toBe(6); expect(active).toBe(0);
    for (const source of fixtures) {
      await removeNativeHarnessBackup(source.home);
      const replacement = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(replacement);
      expect(await restoreDurableNativeHarnessBackup({ ...source, storage: f.storage, backupRoot: replacement })).toBe(true);
      expect(JSON.parse(await readFile(join(replacement, "current", "codex-home", "sessions", "history.json"), "utf8"))).toEqual(source.identity);
    }
  });
  it("waits for cancelled peer transfers before returning failure and permits a complete retry", async () => {
    const fixtures = await offlineFixtures(2), f = fixtures[0], peerEntered = deferred(), release = deferred();
    const failed = deferred(), put = f.storage.putFile.bind(f.storage); let entered = 0, active = 0, settled = false;
    const spy = vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const ordinal = ++entered; active++;
      try {
        if (ordinal === 1) { await peerEntered.promise; failed.resolve(); throw new Error("storage unavailable"); }
        peerEntered.resolve(); await release.promise; return await put(input);
      } finally { active--; }
    });
    const migration = migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) });
    const completed = migration.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(entered).toBe(2), { timeout: 3000 }); await failed.promise;
      await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    } finally { peerEntered.resolve(); release.resolve(); await completed; }
    await expect(migration).rejects.toThrow("storage unavailable"); expect(active).toBe(0); spy.mockRestore();
    for (const source of fixtures) expect(await readFile(join(source.root, "manifest.json"), "utf8")).toContain("paperclip.native-harness-backup.v1");
    expect(await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) })).toBe(2);
    for (const source of fixtures) {
      const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, source.scopeDigest));
      expect(rows.filter(row => row.status === "current")).toHaveLength(1);
    }
  });
  it("preserves unlisted files with an exclusive scratch reservation", async () => {
    const fixtures = await offlineFixtures(3), f = fixtures[0], extra = fixtures[1];
    await writeFile(join(extra.root, "retained-extra.txt"), "unlisted surviving bytes");
    const put = f.storage.putFile.bind(f.storage); let active = 0, peak = 0;
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      active++; peak = Math.max(peak, active);
      try { await new Promise<void>(resolve => setImmediate(resolve)); return await put(input); } finally { active--; }
    });
    expect(await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) })).toBe(3);
    expect(peak).toBe(1);
    await removeNativeHarnessBackup(extra.home);
    const replacement = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...extra, storage: f.storage, backupRoot: replacement })).toBe(true);
    expect(await readFile(join(replacement, "current", "retained-extra.txt"), "utf8")).toBe("unlisted surviving bytes");
  });
  it("enforces the reserved archive size while streaming before publishing any object", async () => {
    const f = await fixture(), put = vi.spyOn(f.storage, "putFile");
    await expect(persistNativeHarnessBackup({ ...f, maxArchiveBytes: 512 })).rejects.toThrow("native_harness_archive_invalid");
    expect(put).not.toHaveBeenCalled();
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toHaveLength(0);
    expect(JSON.parse(await readFile(join(f.root, "codex", "sessions", "history.json"), "utf8"))).toEqual(f.identity);
  });
  it.each(["codex", "claude", "opencode", "grok", "new-provider"])("restores %s session bytes after deleting the entire controller home", async provider => {
    const f = await fixture(provider);
    await persistNativeHarnessBackup(f);
    const [row] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(row.status).toBe("current");
    const object = await f.storage.getObject(f.companyId, row.reference.objectKey as string);
    const parts: Buffer[] = []; for await (const part of object.stream) parts.push(part);
    expect(Buffer.concat(parts).includes(Buffer.from(f.identity.providerSessionId))).toBe(false);
    await removeNativeHarnessBackup(f.home);
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "failover-backups");
    ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current", provider, "sessions", "history.json"), "utf8"))).toEqual(f.identity);
    expect((await stat(join(replacement, "current", provider, "sessions"))).mode & 0o777).toBe(0o500);
    expect(await verifyDurableNativeHarnessBackup(f)).toBe(true);
  });
  async function artifactFixture(artifactVersion = randomUUID()) {
    const f = await fixture("opencode");
    const sourceRoot = join(f.home, "qualified-provider-pack");
    await mkdir(sourceRoot);
    const original = { nodeCommand: "qualified Node executable", opencodeExecutable: "qualified OpenCode executable",
      opencodeProxy: `qualified original proxy bytes ${artifactVersion}` };
    const artifacts = Object.fromEntries(await Promise.all(Object.entries(original).map(async ([name, bytes]) => {
      await writeFile(join(sourceRoot, name), bytes, { mode: 0o500 });
      return [name, { path: name, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }];
    })));
    const payload = { runnerSourceRevision: "a".repeat(40), target: { platform: "linux", architecture: "x64" },
      pins: { opencode: "1.18.34" }, artifacts: { ...artifacts, opencodeCommand: artifacts.opencodeExecutable } };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` };
    const launchRoot = `/home/daytona/.paperclip-runtime/paperclip-runner/provider-artifacts/${manifest.digest.slice(7)}`;
    await f.db.update(heartbeatRuns).set({ nativeSessionId: f.identity.normalizedSessionId, driverKind: "opencode_server",
      runnerProfileJson: { ...f.preparedProfile, nativeProviderPackAdmissionState: {
        schema: "paperclip.native-provider-pack-admission-state.v1", state: "verified", admissionEpoch: randomUUID() },
      nativeProviderPackAdmission: { schema: "paperclip.native-provider-pack-admission.v1", stage: "session_admitted",
        authority: "core_verified_selection", companyId: f.companyId, agentId: environment.current.agentId,
        runId: f.runId, sessionId: f.identity.normalizedSessionId, runnerInstanceId: "artifact-fixture-runner",
        runnerEnvironmentLeaseId: "artifact-fixture-lease", providerPackDigest: manifest.digest,
        opencodeProxySha256: artifacts.opencodeProxy.sha256, sourceRevision: payload.runnerSourceRevision } },
    }).where(eq(heartbeatRuns.id, f.runId));
    return { ...f, original, manifest, launchRoot, providerArtifacts: { sourceRoot, manifest, launchRoot, accountUid: 1000 } };
  }
  it("restores the admitted OpenCode launch bytes after the controller and sandbox image change", async () => {
    const publication = await artifactFixture(), f = publication;
    const { original, manifest, launchRoot } = publication;
    await persistNativeHarnessBackup(publication);
    await removeNativeHarnessBackup(f.home);
    const newImage = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(newImage);
    await mkdir(newImage);
    await writeFile(join(newImage, "opencodeProxy"), "qualified newer proxy bytes");
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "failover-backups"); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current/opencode/sessions/history.json"), "utf8"))).toEqual(f.identity);
    for (const [name, bytes] of Object.entries(original)) {
      expect(await readFile(join(replacement, "current/provider-artifacts", name), "utf8")).toBe(bytes);
    }
    const restored = JSON.parse(await readFile(join(replacement, "current/manifest.json"), "utf8"));
    expect(restored.providerArtifacts).toMatchObject({ launchRoot, providerPackDigest: manifest.digest });
  });
  it("repairs a missing local launch cache without adding the binaries to each harness backup", async () => {
    const f = await artifactFixture(); await persistNativeHarnessBackup(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const replacement = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    await removeNativeHarnessBackup(join(replacement, "current/provider-artifacts"));
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(await readFile(join(replacement, "current/provider-artifacts/opencodeProxy"), "utf8")).toBe(f.original.opencodeProxy);
    await persistNativeHarnessBackup({ ...f, providerArtifacts: undefined, root: join(replacement, "current") });
    const [after] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
      eq(nativeHarnessBackups.status, "current")));
    expect(after.reference.byteSize).toBe(before.reference.byteSize);
  });
  it("retries an interrupted artifact cache copy without publishing partial launch files", async () => {
    const f = await artifactFixture(); await persistNativeHarnessBackup(f);
    const receipt = JSON.parse(await readFile(join(f.root, "manifest.json"), "utf8")).providerArtifacts;
    const home = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(home); await mkdir(home);
    const targetRoot = join(home, "provider-artifacts"), copy = fs.cp.bind(fs);
    const interrupted = vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (String(destination).startsWith(targetRoot)) {
        await mkdir(destination, { recursive: true });
        await writeFile(join(String(destination), "opencodeProxy"), "partial copy");
        throw Object.assign(new Error("controlled disk full during cache publication"), { code: "ENOSPC" });
      }
      return copy(source, destination, options);
    });
    try { await expect(restoreNativeProviderArtifacts({ ...f, receipt, targetRoot })).rejects.toThrow("controlled disk full"); }
    finally { interrupted.mockRestore(); }
    await expect(fs.stat(targetRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restoreNativeProviderArtifacts({ ...f, receipt, targetRoot })).resolves.toBeUndefined();
    expect(await readFile(join(targetRoot, "opencodeProxy"), "utf8")).toBe(f.original.opencodeProxy);
    expect(await fs.readdir(home)).toEqual(["provider-artifacts"]);
  });
  it("uploads a shared admitted closure once and releases it only after the last stopped backup owner retires", async () => {
    const version = randomUUID(), first = await artifactFixture(version), other = await artifactFixture(version);
    const second = { ...other, storage: first.storage };
    const put = vi.spyOn(first.storage, "putFile");
    await persistNativeHarnessBackup(first); await persistNativeHarnessBackup(second);
    expect(put.mock.calls.filter(([input]) => input.namespace === "native-provider-artifacts")).toHaveLength(1);
    const [firstBackup] = await first.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, first.scopeDigest));
    const [secondBackup] = await first.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, second.scopeDigest));
    const artifactId = (firstBackup.reference.providerArtifacts as { artifactId: string }).artifactId;
    const [artifact] = await first.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, artifactId));
    const stop = async (f: typeof first) => {
      await settle(f);
      const leaseId = randomUUID(), providerLeaseId = randomUUID(), confirmedAt = new Date();
      await f.db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, heartbeatRunId: f.runId,
        issueId: f.issueId, provider: "daytona", providerLeaseId, status: "expired", cleanupStatus: "success", releasedAt: confirmedAt,
        metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: f.companyId,
          runId: f.runId, leaseId, provider: "daytona", providerLeaseId, state: "destroyed", confirmedAt: confirmedAt.toISOString() } } });
    };
    await stop(first);
    await first.db.update(nativeHarnessBackups).set({ status: "retired" }).where(eq(nativeHarnessBackups.id, firstBackup.id));
    expect(await deleteRetiredNativeHarnessBackup(first.db, first.storage, firstBackup.id)).toBe(true);
    expect(await first.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, artifact.id))).toHaveLength(1);
    const replacement = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...second, backupRoot: replacement })).toBe(true);
    await stop(second);
    await second.db.update(nativeHarnessBackups).set({ status: "retired" }).where(eq(nativeHarnessBackups.id, secondBackup.id));
    expect(await deleteRetiredNativeHarnessBackup(second.db, second.storage, secondBackup.id)).toBe(true);
    expect(await first.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, artifact.id))).toHaveLength(0);
    expect(await first.db.select().from(nativeProviderArtifactReferences).where(eq(nativeProviderArtifactReferences.artifactId, artifact.id))).toHaveLength(0);
  });
  it("keeps the exact encrypted upload receipt when its artifact owner changes after upload", async () => {
    const f = await artifactFixture(), put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (input.namespace === "native-provider-artifacts") await f.db.update(nativeRunFinalizations)
        .set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("native_runner_checkpoint_owner_lost");
    const [pin] = await f.db.select().from(nativeProviderArtifactReferences).where(eq(nativeProviderArtifactReferences.runId, f.runId));
    const [artifact] = await f.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, pin.artifactId));
    expect(artifact.status).toBe("pending");
    expect(artifact.reference).toMatchObject({ companyId: f.companyId, artifactId: artifact.id, objectKey: expect.any(String), material: expect.any(Object) });
    expect(await readFile(join(f.providerArtifacts.sourceRoot, "opencodeProxy"), "utf8")).toBe(f.original.opencodeProxy);
  });
  it("retires an abandoned artifact upload through checkpoint expiration without losing deletion retries", async () => {
    const f = await artifactFixture(), put = f.storage.putFile.bind(f.storage);
    const lostReply = vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      await put(input); throw new Error("artifact upload reply lost");
    });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("artifact upload reply lost"); lostReply.mockRestore();
    const [pin] = await f.db.select().from(nativeProviderArtifactReferences).where(eq(nativeProviderArtifactReferences.runId, f.runId));
    const [artifact] = await f.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, pin.artifactId));
    expect(artifact.reference).toMatchObject({ objectKey: expect.any(String), material: expect.any(Object) });
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toEqual([]);
    await f.db.insert(nativeRunnerCheckpoints).values({ companyId: f.companyId, runId: f.runId,
      issueId: f.issueId, part: "header", material: { retained: "canonical header index fixture" } });
    const retention = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await retention.tickCheckpoints()).expiredCheckpoints).toBe(0);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await settle(f, old);
    const leaseId = randomUUID(), providerLeaseId = randomUUID(), confirmedAt = new Date();
    await f.db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, heartbeatRunId: f.runId,
      issueId: f.issueId, provider: "daytona", providerLeaseId, status: "expired", cleanupStatus: "success", releasedAt: confirmedAt,
      metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: f.companyId,
        runId: f.runId, leaseId, provider: "daytona", providerLeaseId, state: "destroyed", confirmedAt: confirmedAt.toISOString() } } });
    const drop = vi.spyOn(f.storage, "deleteObject").mockRejectedValueOnce(new Error("delete reply lost"));
    const [earlier] = await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
      adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId }).returning();
    expect((await retention.tickCheckpoints()).expiredCheckpoints).toBe(0);
    expect(drop).not.toHaveBeenCalled();
    expect((await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId)))[0].material)
      .toEqual({ retained: "canonical header index fixture" });
    await f.db.delete(agentTaskSessions).where(eq(agentTaskSessions.id, earlier.id));
    expect((await retention.tickCheckpoints()).failed).toBe(1);
    const [retired] = await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId));
    expect(retired.material).toMatchObject({ schema: "paperclip.native-runner-checkpoint-retirement.v1", companyId: f.companyId,
      runIds: [f.runId], sessionId: f.identity.normalizedSessionId });
    expect(await f.db.select().from(nativeProviderArtifactReferences).where(eq(nativeProviderArtifactReferences.artifactId, artifact.id))).toHaveLength(1);
    await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
      adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId });
    await expect(loadNativeRunnerCheckpoint(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId }))
      .rejects.toThrow("native_runner_checkpoint_retired");
    const missingStorage = nativeHarnessBackupExpirationService(f.db);
    expect((await missingStorage.tickCheckpoints()).failed).toBe(1);
    expect(drop).toHaveBeenCalledTimes(1);
    const [priorOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const currentOwner = { ...f.owner, generation: priorOwner.controllerGeneration, leaseOwner: "fresh-retired-source-claim" };
    await f.db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: currentOwner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: f.runId,
      normalizedSessionId: f.identity.normalizedSessionId, turnId: randomUUID(), itemId: randomUUID() };
    const controller = new DurablePrpControlPlane({ stateDirectory: join(f.home, "new-source-controller"), identity,
      expectedRunnerVersion: "0.0.0", expectedRunnerDigest: "sha256:" + "1".repeat(64) });
    const checkpoint = captureLegacyDurablePrpCheckpoint(JSON.stringify(controller.store.state), {
      runId: f.runId, runnerInstanceId: identity.runnerInstanceId, normalizedSessionId: identity.normalizedSessionId },
      { version: "0.0.0", digest: "sha256:" + "1".repeat(64) });
    try { await expect(nativeRunnerCheckpointWriter(f.db, currentOwner)(checkpoint)).rejects.toThrow("native_runner_checkpoint_retired"); }
    finally { await f.db.update(nativeRunFinalizations).set({ phase: priorOwner.phase, leaseOwner: null,
      leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId)); }
    const restarted = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await restarted.tickCheckpoints()).expiredCheckpoints).toBe(1);
    expect(await f.db.select().from(nativeProviderArtifacts).where(eq(nativeProviderArtifacts.id, artifact.id))).toEqual([]);
    expect(await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId))).toEqual([]);
    expect((await restarted.tickCheckpoints()).expiredCheckpoints).toBe(0);
    expect(drop).toHaveBeenCalledTimes(2);
  });
  it("retains every artifact and checkpoint when a retirement family exceeds its run bound", async () => {
    const f = await artifactFixture(), put = f.storage.putFile.bind(f.storage);
    const lost = vi.spyOn(f.storage, "putFile").mockImplementation(async input => { await put(input); throw new Error("upload reply lost"); });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("upload reply lost"); lost.mockRestore();
    const old = new Date(Date.now() - 10 * 86_400_000); await settle(f, old);
    await f.db.insert(nativeRunnerCheckpoints).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      part: "header", material: { retained: "original checkpoint" } });
    const relatives = Array.from({ length: 100 }, () => randomUUID());
    await f.db.insert(heartbeatRuns).values(relatives.map(id => ({ id, companyId: f.companyId, agentId: environment.current.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.identity.normalizedSessionId, status: "failed", finishedAt: old })));
    await f.db.insert(nativeRunFinalizations).values(relatives.map(runId => ({ runId, companyId: f.companyId, issueId: f.issueId, phase: "terminal_failure" })));
    const remove = vi.spyOn(f.storage, "deleteObject");
    const result = await nativeHarnessBackupExpirationService(f.db, { storage: f.storage }).tickCheckpoints();
    expect(result.expiredCheckpoints).toBe(0); expect(remove).not.toHaveBeenCalled();
    expect((await f.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, f.runId)))[0].material)
      .toEqual({ retained: "original checkpoint" });
    expect(await f.db.select().from(nativeProviderArtifactReferences).where(eq(nativeProviderArtifactReferences.runId, f.runId))).toHaveLength(1);
  });
  it("keeps the last published backup when object storage fails", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const put = vi.spyOn(f.storage, "putFile").mockRejectedValue(new Error("storage unavailable"));
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("storage unavailable"); put.mockRestore();
    const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(rows.filter(row => row.status === "current").map(row => row.id)).toEqual([before.id]);
    expect(rows.filter(row => row.status === "pending")).toHaveLength(1);
    expect(await readFile(join(f.root, "manifest.json"), "utf8")).toContain("native-harness-backup");
  });
  async function commitWarmRun(f: Awaited<ReturnType<typeof fixture>>) {
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: run.completionContractId!, serverFingerprint: "completed-warm-turn", schemaStatus: "accepted",
      resultJson: { summary: "Retained provider history" }, canonicalSha256: "completed-warm-turn" }).returning();
    await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null,
      leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    return result;
  }
  async function releaseWhileSavingWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await commitWarmRun(f);
    await f.db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    return result;
  }
  async function inactiveFixture() {
    const [f] = await offlineFixtures(1);
    await commitWarmRun(f);
    await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: environment.current.successor.bootId });
    return { ...f, owner, inactiveSource: { normalizedSessionId: f.identity.normalizedSessionId,
      runnerInstanceId: f.runnerInstanceId, providerLeaseId: f.providerLeaseId } };
  }
  it("pre-copies released history and restores its bytes while an unrelated execution stays active", async () => {
    const f = await inactiveFixture(), active = await environment.seedRun(randomUUID());
    const input = { storage: f.storage, signal: AbortSignal.timeout(15_000) };
    expect(await prestageNativeHarnessBackups(f.db, input)).toEqual({ inspected: 1, published: 1, current: 0, deferred: {} });
    expect(await prestageNativeHarnessBackups(f.db, input)).toEqual({ inspected: 1, published: 0, current: 1, deferred: {} });
    await expect(migrateNativeHarnessBackups(f.db, { ...input, writersStopped: true })).rejects.toThrow("requires_offline_writers");
    expect((await active.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, active.runId)))[0].status).toBe("running");
    await removeNativeHarnessBackup(f.home);
    const replacement = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current", "codex-home", "sessions", "history.json"), "utf8"))).toEqual(f.identity);
  });
  it.each(["queued", "running"] as const)("defers pre-copy when the same task has a %s execution", async status => {
    const f = await inactiveFixture(), put = vi.spyOn(f.storage, "putFile");
    await f.db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: environment.current.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.identity.normalizedSessionId, status, runtimeMode: "native" });
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toEqual({ inspected: 1, published: 0, current: 0, deferred: { source_active: 1 } });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("native_harness_storage_prestage_source_active");
    expect(put).not.toHaveBeenCalled();
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toEqual([]);
  });
  it("defers failed history without treating pre-copy as offline authority", async () => {
    const [f] = await offlineFixtures(1);
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toEqual({ inspected: 1, published: 0, current: 0, deferred: { source_not_successful: 1 } });
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toEqual([]);
  });
  it("defers a source being replaced online while offline migration still refuses it", async () => {
    const f = await inactiveFixture();
    await writeFile(join(f.root, "runner", "runner-state.json"), JSON.stringify({ runId: f.runId, lifecycle: "running" }));
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toEqual({ inspected: 1, published: 0, current: 0, deferred: { source_unavailable: 1 } });
    await expect(migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) }))
      .rejects.toThrow("native_harness_migration_source_unsettled");
  });
  async function releasedFixtures() {
    const fixtures = await offlineFixtures(2);
    for (const f of fixtures) {
      await commitWarmRun(f);
      await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    }
    return fixtures;
  }
  async function damageSource(f: Awaited<ReturnType<typeof offlineFixture>>, kind: string) {
    if (kind === "unsafe") {
      await rename(f.root, f.root + "-retained");
      await symlink(f.root + "-retained", f.root);
    } else await writeFile(join(f.root, kind === "manifest" ? "manifest.json" : "runner/runner-state.json"), "{");
  }
  it.each(["source", "output"])("distinguishes %s ENOENT during archive capture after source preparation", async kind => {
    const [bad, good] = await releasedFixtures(), capture = backupArchive.captureNativeHarnessArchive;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = vi.spyOn(backupArchive, "captureNativeHarnessArchive").mockImplementation(async (root, target, signal, limit) => {
      if (root === bad.root) {
        if (kind === "source") await rename(root, root + "-retained");
        else target = join(target, "missing-parent", "archive");
      }
      return capture(root, target, signal, limit);
    });
    try {
      const preparation = prestageNativeHarnessBackups(bad.db, { storage: bad.storage, signal: AbortSignal.timeout(15_000) });
      if (kind === "source") {
        expect(await preparation).toEqual({ inspected: 2, published: 1, current: 0, deferred: { source_changed: 1 } });
        expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ scopeDigest: bad.scopeDigest,
          reason: "native_harness_migration_source_unavailable" });
        expect((await good.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, good.scopeDigest)))[0].status).toBe("current");
      } else {
        await expect(preparation).rejects.toMatchObject({ code: "ENOENT" });
        expect(warning).not.toHaveBeenCalled();
        expect(await good.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, good.scopeDigest))).toHaveLength(0);
      }
      expect(await bad.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, bad.scopeDigest))).toHaveLength(0);
    } finally { archive.mockRestore(); warning.mockRestore(); }
  });
  it.each(["manifest", "runner", "unsafe"])("defers a damaged %s source and still copies the next eligible backup", async kind => {
    const [bad, good] = await releasedFixtures(), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await damageSource(bad, kind);
      expect(await prestageNativeHarnessBackups(bad.db, { storage: bad.storage, signal: AbortSignal.timeout(15_000) }))
        .toEqual({ inspected: 2, published: 1, current: 0, deferred: { source_unavailable: 1 } });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(bad.scopeDigest));
      expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ scopeDigest: bad.scopeDigest,
        reason: kind === "unsafe" ? "native_harness_migration_unsafe_source" : "native_harness_migration_source_invalid_json" });
      expect(await bad.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, bad.scopeDigest))).toHaveLength(0);
      expect((await good.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, good.scopeDigest)))[0].status).toBe("current");
      await expect(migrateNativeHarnessBackups(bad.db, { storage: bad.storage, writersStopped: true, signal: AbortSignal.timeout(15_000) }))
        .rejects.toThrow(kind === "unsafe" ? "native_harness_migration_unsafe_source" : /JSON|json/);
    } finally { warning.mockRestore(); }
  });
  it.each(["manifest", "runner", "unsafe"])("defers %s damage at the publication fence and copies the next backup", async kind => {
    const [bad, good] = await releasedFixtures(), put = bad.storage.putFile.bind(bad.storage);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const upload = vi.spyOn(bad.storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (input.objectKey?.includes(bad.scopeDigest)) await damageSource(bad, kind);
      return result;
    });
    try {
      expect(await prestageNativeHarnessBackups(bad.db, { storage: bad.storage, signal: AbortSignal.timeout(15_000) }))
        .toEqual({ inspected: 2, published: 1, current: 0, deferred: { source_changed: 1 } });
      expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ scopeDigest: bad.scopeDigest,
        reason: kind === "unsafe" ? "native_harness_migration_unsafe_source" : "native_harness_migration_source_invalid_json" });
      expect((await bad.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, bad.scopeDigest))).some(row => row.status === "current")).toBe(false);
      expect((await good.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, good.scopeDigest)))[0].status).toBe("current");
    } finally { upload.mockRestore(); warning.mockRestore(); }
  });
  it("keeps a database SyntaxError fatal instead of deferring it as source damage", async () => {
    const fixtures = await releasedFixtures(), f = fixtures[0], failure = new SyntaxError("database result decoding failed");
    const transaction = vi.spyOn(f.db, "transaction").mockRejectedValueOnce(failure);
    try {
      await expect(prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) })).rejects.toBe(failure);
      for (const source of fixtures) expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, source.scopeDigest))).toHaveLength(0);
    } finally { transaction.mockRestore(); }
  });
  it("keeps cancellation fatal when a source also changes during upload", async () => {
    const [f] = await releasedFixtures(), cancellation = new AbortController(), failure = new Error("operator stopped");
    const put = f.storage.putFile.bind(f.storage);
    const upload = vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const result = await put(input); await damageSource(f, "manifest"); cancellation.abort(failure); return result;
    });
    try {
      await expect(prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: cancellation.signal })).rejects.toBe(failure);
      expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).some(row => row.status === "current")).toBe(false);
    } finally { upload.mockRestore(); }
  });
  it.each(["source_advanced", "queued_turn", "lease_revoked", "owner_changed", "run_failed"])("keeps the published source when %s happens during pre-copy upload", async change => {
    const f = await inactiveFixture(); await persistNativeHarnessBackup(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (change === "source_advanced") await writeFile(join(f.root, "manifest.json"), (await readFile(join(f.root, "manifest.json"), "utf8")) + "\n");
      if (change === "queued_turn") await f.db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId,
        agentId: environment.current.agentId, issueId: f.issueId, status: "queued" });
      if (change === "lease_revoked") await f.db.update(environmentLeases).set({ metadata: {} })
        .where(eq(environmentLeases.providerLeaseId, f.providerLeaseId));
      if (change === "owner_changed") await f.db.update(nativeRunFinalizations).set({ controllerGeneration: 2 })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (change === "run_failed") await f.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
      return result;
    });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow(change === "owner_changed" ? "native_runner_checkpoint_owner_lost"
      : change === "queued_turn" ? "native_harness_storage_prestage_source_active" : "native_harness_storage_prestage_source_changed");
    const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(rows.filter(row => row.status === "current").map(row => row.id)).toEqual([before.id]);
    expect(rows.filter(row => row.status === "pending")).toHaveLength(1);
    expect(await readFile(join(f.root, "manifest.json"), "utf8")).toContain("paperclip.native-harness-backup.v1");
  });
  it("publishes with the captured provider owner while an accepted result is still saving its workspace", async () => {
    const f = await fixture();
    const result = await releaseWhileSavingWorkspace(f);
    await expect(nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: f.owner.bootId })).rejects.toThrow("native_harness_storage_owner_missing");
    await persistNativeHarnessBackup(f);
    await removeNativeHarnessBackup(f.home);
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "restored-pending-workspace");
    ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current", "codex", "sessions", "history.json"), "utf8"))).toEqual(f.identity);
    const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "workspace_finalizing", resultId: result.id, leaseOwner: null,
      leaseExpiresAt: null, controllerBootId: f.owner.bootId, controllerGeneration: f.owner.generation });
  });
  it.each(["boot", "generation", "result", "successor"])("rejects a captured provider fence when its %s changes during upload", async change => {
    const f = await fixture();
    await persistNativeHarnessBackup(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    await releaseWhileSavingWorkspace(f);
    const put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const object = await put(input);
      if (change === "successor") {
        const nextRunId = randomUUID();
        await f.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId,
          agentId: environment.current.agentId, issueId: f.issueId, status: "running" });
        await f.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
      } else {
        await f.db.update(nativeRunFinalizations).set(change === "boot" ? { controllerBootId: randomUUID() }
          : change === "generation" ? { controllerGeneration: 2 } : { resultId: null })
          .where(eq(nativeRunFinalizations.runId, f.runId));
      }
      return object;
    });
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow(change === "successor"
      ? "native_harness_storage_owner_superseded" : "native_runner_checkpoint_owner_lost");
    const selected = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
      eq(nativeHarnessBackups.status, "current")));
    expect(selected.map(row => row.id)).toEqual([before.id]);
  });
  it.each(["idle", "preparing", "native"])("preserves a released committed warm session with a %s successor", async state => {
    const f = await fixture();
    const result = await commitWarmRun(f);
    let nextRunId: string | null = null;
    if (state !== "idle") {
      nextRunId = randomUUID();
      await f.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: environment.current.agentId,
        issueId: f.issueId, status: "running", runtimeMode: state === "native" ? "native" : "legacy", executionStage: "preparing",
        ...(state === "native" ? { nativeIssueId: f.issueId } : {}),
        controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 120_000) });
      if (state === "native") await f.db.insert(nativeRunFinalizations).values({ runId: nextRunId,
        companyId: f.companyId, issueId: f.issueId, phase: "observed", controllerBootId: environment.current.successor.bootId,
        controllerGeneration: 1, leaseOwner: "preparing-warm-successor", leaseExpiresAt: new Date(Date.now() + 120_000) });
    }
    await f.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: environment.current.successor.bootId });
    await persistNativeHarnessBackup({ ...f, owner });
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "restored-warm-session"); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current", "codex", "sessions", "history.json"), "utf8"))).toEqual(f.identity);
    const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null });
    const [task] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionRunId).toBe(nextRunId);
  });
  it.each(["unaccepted", "uncommitted", "wrong_boot"])("rejects a released warm owner with %s completion evidence", async state => {
    const f = await fixture(); await commitWarmRun(f);
    if (state === "unaccepted") await f.db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (state === "uncommitted") await f.db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      bootId: state === "wrong_boot" ? randomUUID() : environment.current.successor.bootId })).rejects.toThrow("native_harness_storage_owner_missing");
  });
  it("rejects an active predecessor after the task moves to a successor", async () => {
    const f = await fixture();
    const nextRunId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: environment.current.agentId,
      nativeIssueId: f.issueId, issueId: f.issueId, status: "running", runtimeMode: "native" });
    await f.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("native_harness_storage_owner_superseded");
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toEqual([]);
  });
  it.each(["foreign_preparation", "expired_preparation", "dispatching_successor", "foreign_native"])("keeps the selected backup when a released owner has a %s", async state => {
    const f = await fixture(); await persistNativeHarnessBackup(f); await commitWarmRun(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const nextRunId = randomUUID();
    await f.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: environment.current.agentId,
      issueId: f.issueId, status: "running", runtimeMode: state === "foreign_native" ? "native" : "legacy",
      ...(state === "foreign_native" ? { nativeIssueId: f.issueId } : {}),
      executionStage: state === "dispatching_successor" ? "dispatching" : "preparing",
      controllerBootId: state === "foreign_preparation" ? randomUUID() : legacyControllerBootId,
      controllerLeaseExpiresAt: state === "expired_preparation" ? new Date(0) : new Date(Date.now() + 120_000) });
    if (state === "foreign_native") await f.db.insert(nativeRunFinalizations).values({ runId: nextRunId,
      companyId: f.companyId, issueId: f.issueId, phase: "observed", controllerBootId: randomUUID(),
      controllerGeneration: 1, leaseOwner: "foreign-warm-successor", leaseExpiresAt: new Date(Date.now() + 120_000) });
    await f.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: environment.current.successor.bootId });
    await expect(persistNativeHarnessBackup({ ...f, owner })).rejects.toThrow("native_runner_checkpoint_owner_lost");
    expect((await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
      eq(nativeHarnessBackups.status, "current")))).map(row => row.id)).toEqual([before.id]);
  });
  it.each(["generation", "result", "phase"])("rechecks a released owner's %s after object upload", async state => {
    const f = await fixture(); await persistNativeHarnessBackup(f); await commitWarmRun(f);
    await f.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: environment.current.successor.bootId });
    const put = f.storage.putFile.bind(f.storage);
    f.storage.putFile = async input => {
      const result = await put(input);
      await f.db.update(nativeRunFinalizations).set(state === "generation" ? { controllerGeneration: 2 }
        : state === "result" ? { resultId: null } : { phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    };
    await expect(persistNativeHarnessBackup({ ...f, owner })).rejects.toThrow(state === "generation"
      ? "native_runner_checkpoint_owner_lost" : "native_harness_storage_owner_missing");
    expect((await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
      eq(nativeHarnessBackups.status, "current")))).map(row => row.id)).toEqual([before.id]);
  });
  it("cannot replace a newer conversation backup with a released predecessor's late upload", async () => {
    const f = await fixture(); await commitWarmRun(f);
    await f.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    const owner = await nativeHarnessBackupOwner(f.db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, bootId: environment.current.successor.bootId });
    const next = await fixture();
    const put = f.storage.putFile.bind(f.storage);
    f.storage.putFile = async input => {
      const result = await put(input);
      await persistNativeHarnessBackup({ ...next, scopeDigest: f.scopeDigest });
      return result;
    };
    await expect(persistNativeHarnessBackup({ ...f, owner })).rejects.toThrow("native_harness_storage_owner_superseded");
    const [current] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest),
      eq(nativeHarnessBackups.status, "current")));
    expect(current.runId).toBe(next.runId);
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "latest-conversation"); ownedHomes.push(replacement);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).toBe(true);
    expect(JSON.parse(await readFile(join(replacement, "current", "codex", "sessions", "history.json"), "utf8"))).toEqual(next.identity);
  });
  it("fences an old controller whose upload finishes after ownership changes", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const put = f.storage.putFile.bind(f.storage);
    f.storage.putFile = async input => {
      const result = await put(input);
      await f.db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerGeneration: 2 })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    };
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("native_runner_checkpoint_owner_lost");
    const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(rows.filter(row => row.status === "current").map(row => row.id)).toEqual([before.id]);
  });
  it("refuses publication after a pending upload was retired without demoting the current backup", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const [current] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const put = f.storage.putFile.bind(f.storage);
    f.storage.putFile = async input => {
      const result = await put(input);
      await f.db.update(nativeHarnessBackups).set({ status: "retired" }).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest), eq(nativeHarnessBackups.status, "pending")));
      return result;
    };
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("native_harness_storage_publication_retired");
    expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, current.id)))[0].status).toBe("current");
    const [retired] = await f.db.select().from(nativeHarnessBackups).where(and(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest), eq(nativeHarnessBackups.status, "retired")));
    expect(await deleteRetiredNativeHarnessBackup(f.db, f.storage, retired.id)).toBe(true);
  });
  it("rejects corrupt objects and cross-company lookups without publishing a local cache", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const replacement = join(environment.current.runtimeRoot, randomUUID(), "failover-backups");
    expect(await restoreDurableNativeHarnessBackup({ ...f, companyId: randomUUID(), backupRoot: replacement })).toBe(false);
    const [row] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    await f.storage.deleteObject(f.companyId, row.reference.objectKey as string);
    await f.storage.putFile({ companyId: f.companyId, namespace: "native-harness-backups", objectKey: row.reference.objectKey as string,
      originalFilename: null, contentType: "application/octet-stream", body: Buffer.from("corrupted") });
    await expect(restoreDurableNativeHarnessBackup({ ...f, backupRoot: replacement })).rejects.toThrow("hash_mismatch");
    await expect(stat(join(replacement, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  async function settle(f: { db: Awaited<ReturnType<typeof fixture>>["db"]; runId: string; issueId: string }, closedAt = new Date()) {
    await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: closedAt }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(issues).set({ status: "done", executionRunId: null, completedAt: closedAt }).where(eq(issues.id, f.issueId));
  }
  it("migrates a lease-verified local backup once and keeps its selected session intact", async () => {
    const f = await fixture("codex-home");
    const base = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(base); await mkdir(base);
    await rename(f.home, join(base, f.scopeDigest));
    const root = join(base, f.scopeDigest, "failover-backups", "current");
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    const runnerInstanceId = randomUUID(), providerLeaseId = randomUUID();
    const execution = { provider: { kind: "codex" }, binding: { companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, agentId: environment.current.agentId, executionWorkspaceId: randomUUID() },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.identity.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
    await chmod(join(root, "codex-home", "sessions"), 0o700);
    await symlink("history.json", join(root, "codex-home", "sessions", "history-link"));
    await chmod(join(root, "codex-home", "sessions"), 0o500);
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: f.identity.providerSessionId }, sourceProviderLeaseId: providerLeaseId });
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId: f.sessionScopeId,
      authorizedProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId, completedAt: manifest.completedAt });
    expect(verifyNativeHarnessBackupStamp(stamp, providerLeaseId)).toBe(true);
    expect(await verifyNativeHarnessBackupStampAsync(stamp, providerLeaseId, AbortSignal.timeout(10_000))).toBe(true);
    await expect(verifyNativeHarnessBackupStampAsync(stamp, providerLeaseId, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    await f.db.update(heartbeatRuns).set({ nativeSessionId: f.identity.normalizedSessionId, runnerInstanceId }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      providerLeaseId, status: "expired", metadata: { nativeHarnessBackup: stamp } });
    const [selected] = await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
      adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId,
      sessionParamsJson: { sessionId: f.identity.normalizedSessionId } }).returning();
    expect(await hasLocalNativeHarnessObligations(f.db)).toBe(true);
    await expect(migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(10_000) }))
      .rejects.toThrow("native_harness_migration_requires_offline_writers");
    const ownedRuns = await f.db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    for (const run of ownedRuns) await settle({ ...f, runId: run.id, issueId: run.issueId! });
    await f.db.update(nativeRunFinalizations).set({ recoveryState: "blocked" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [preservedOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [queued] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: environment.current.agentId,
      status: "queued", invocationSource: "on_demand", issueId: f.issueId }).returning();
    await f.db.update(issues).set({ executionRunId: queued.id }).where(eq(issues.id, f.issueId));
    expect(await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(10_000) })).toBe(1);
    expect(await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(10_000) })).toBe(1);
    expect(await hasLocalNativeHarnessObligations(f.db)).toBe(false);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toHaveLength(1);
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, selected.id)))[0]).toEqual(selected);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(preservedOwner);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0]).toEqual(queued);
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(queued.id);
    expect(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))).toEqual(manifest);
    const restored = join(base, "replacement");
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: restored })).toBe(true);
    expect(await readlink(join(restored, "current", "codex-home", "sessions", "history-link"))).toBe("history.json");
    const changedManifest = JSON.stringify({ ...manifest, completedAt: new Date(Date.now() + 1_000).toISOString() });
    await writeFile(join(root, "manifest.json"), changedManifest);
    await expect(migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(10_000) }))
      .rejects.toThrow("native_harness_migration_durable_source_conflict");
    expect(await readFile(join(root, "manifest.json"), "utf8")).toBe(changedManifest);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toHaveLength(1);
  });
  it("preserves orphaned local backup files without blocking other enrollment", async () => {
    const f = await fixture();
    const base = join(environment.current.runtimeRoot, randomUUID()); ownedHomes.push(base); await mkdir(base);
    await rename(f.home, join(base, f.scopeDigest));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    const root = join(base, f.scopeDigest, "failover-backups", "current");
    const orphan = JSON.stringify({ runId: randomUUID(), lifecycle: "suspended" });
    await writeFile(join(root, "runner", "runner-state.json"), orphan);
    const ownedRuns = await f.db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    for (const run of ownedRuns) await settle({ ...f, runId: run.id, issueId: run.issueId! });
    expect(await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal: AbortSignal.timeout(10_000) })).toBe(0);
    expect(await readFile(join(root, "runner", "runner-state.json"), "utf8")).toBe(orphan);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toHaveLength(0);
  });
  it("retains live work and retries an uncertain object deletion through the existing startup retention pass", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await f.db.update(nativeHarnessBackups).set({ createdAt: old }).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const retention = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await retention.tickCheckpoints()).expired).toBe(0);
    await settle(f, old);
    const drop = vi.spyOn(f.storage, "deleteObject").mockRejectedValueOnce(new Error("delete reply lost"));
    expect((await retention.tickCheckpoints()).failed).toBe(1);
    expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest)))[0].status).toBe("retired");
    expect((await retention.tickCheckpoints()).expired).toBe(1);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toHaveLength(0);
    expect(drop).toHaveBeenCalledTimes(2);
  });
  it("expires obsolete objects without clearing an open conversation or its exact lease backup", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const [obsolete] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    await writeFile(join(f.root, "manifest.json"), JSON.stringify({ revision: 2 }));
    await persistNativeHarnessBackup(f);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await f.db.update(nativeHarnessBackups).set({ createdAt: old, updatedAt: old }).where(eq(nativeHarnessBackups.id, obsolete.id));
    const [selected] = await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
      adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId }).returning();
    const [lease] = await f.db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, status: "pending_cleanup", metadata: { nativeHarnessBackup: {
        sessionScopeSha256: f.scopeDigest, manifestSha256: obsolete.manifestSha256 } } }).returning();
    const retention = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await retention.tickCheckpoints()).expired).toBe(0);
    await f.db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, lease.id));
    expect((await retention.tickCheckpoints({ dryRun: true })).expired).toBe(0);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, obsolete.id))).toHaveLength(1);
    expect((await retention.tickCheckpoints()).expired).toBe(1);
    const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe("current");
    expect((await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, selected.id)))[0]).toEqual(selected);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
  });
  it("retains an in-flight pending upload and removes it once its owner settles", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const put = vi.spyOn(f.storage, "putFile").mockRejectedValueOnce(new Error("upload unavailable"));
    await expect(persistNativeHarnessBackup(f)).rejects.toThrow("upload unavailable"); put.mockRestore();
    const rows = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const pending = rows.find(row => row.status === "pending")!;
    const old = new Date(Date.now() - 10 * 86_400_000);
    await f.db.update(nativeHarnessBackups).set({ createdAt: old, updatedAt: old }).where(eq(nativeHarnessBackups.id, pending.id));
    const retention = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await retention.tickCheckpoints()).expired).toBe(0);
    await settle(f);
    expect((await retention.tickCheckpoints()).expired).toBe(1);
    const remaining = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    expect(remaining).toHaveLength(1); expect(remaining[0].status).toBe("current");
  });
  it("keeps deleted-source objects unchanged during a retention dry run", async () => {
    const f = await fixture(); await persistNativeHarnessBackup(f);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await f.db.update(nativeHarnessBackups).set({ createdAt: old, runId: randomUUID() })
      .where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const [before] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    const retention = nativeHarnessBackupExpirationService(f.db, { storage: f.storage });
    expect((await retention.tickCheckpoints({ dryRun: true })).expired).toBe(0);
    expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, before.id)))[0]).toEqual(before);
    expect(await verifyDurableNativeHarnessBackup(f)).toBe(true);
    expect((await retention.tickCheckpoints()).expired).toBe(1);
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, before.id))).toHaveLength(0);
  });
});
