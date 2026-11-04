import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agentTaskSessions, environmentLeases, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup,
  verifyDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { buildNativeHarnessBackupManifest } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { hasLocalNativeHarnessObligations, migrateNativeHarnessBackups } from "./native-harness-backup-migration.js";
import { nativeHarnessBackupExpirationService } from "./native-harness-backup-expiration.js";

describeEmbeddedPostgres("durable native provider backups", () => {
  const environment = nativeRestartFixture();
  const ownedHomes: string[] = [];
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
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: f.identity.providerSessionId }, sourceProviderLeaseId: providerLeaseId });
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId: f.sessionScopeId,
      authorizedProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId, completedAt: manifest.completedAt });
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
