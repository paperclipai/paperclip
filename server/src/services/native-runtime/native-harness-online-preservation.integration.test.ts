import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agentTaskSessions, createDb, environmentLeases, heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { buildNativeHarnessBackupManifest } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { migrateNativeHarnessBackups, prestageNativeHarnessBackups } from "./native-harness-backup-migration.js";
import { persistNativeHarnessBackup, restoreDurableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { settledNativeHarnessBackupOwner } from "./native-harness-preservation-source.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import * as backupStamp from "./native-harness-backup-stamp.js";
import * as independence from "./native-harness-filesystem-independence.js";
import { nativeHarnessPrestageDatabaseUrl } from "../../maintenance/native-harness-prestage-runtime.js";

describeEmbeddedPostgres("online preservation of settled legacy harness backups", () => {
  const environment = nativeRestartFixture();
  const homes: string[] = [];
  afterEach(async () => { for (const home of homes.splice(0)) await removeNativeHarnessBackup(home); vi.unstubAllEnvs(); });
  async function fixture(options: { base?: string; scopeId?: string; unsafeLink?: boolean } = {}) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, runtimeRoot } = environment.current;
    const base = options.base ?? join(runtimeRoot, randomUUID());
    if (!options.base) { homes.push(base); await mkdir(base); }
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    const sessionScopeId = options.scopeId ?? randomUUID(), scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const root = join(base, scopeDigest, "failover-backups", "current");
    await mkdir(join(root, "codex-home", "sessions"), { recursive: true }); await mkdir(join(root, "runner"));
    const saved = { providerSessionId: randomUUID(), history: "surviving failed provider history" };
    await writeFile(join(root, "codex-home", "sessions", "history.json"), JSON.stringify(saved), { mode: 0o600 });
    if (options.unsafeLink) await symlink("/outside-owned-backup", join(root, "codex-home", "outside-link"));
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ runId: f.runId, lifecycle: "suspended" }));
    const normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID(), providerLeaseId = randomUUID();
    const execution = { provider: { kind: "codex" }, binding: { companyId, issueId: f.issueId, runId: f.runId,
      agentId, executionWorkspaceId: randomUUID() }, workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: saved.providerSessionId }, sourceProviderLeaseId: providerLeaseId });
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId,
      authorizedProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId, completedAt: manifest.completedAt });
    await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), nativeSessionId: normalizedSessionId,
      runnerInstanceId, processPid: 123456, processStartedAt: new Date(1) }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      recoveryState: "original_failure_retained" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(issues).set({ status: "done", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    await f.db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId });
    await f.db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId, providerLeaseId,
      status: "expired", metadata: { nativeHarnessBackup: stamp } });
    const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
    return { ...f, companyId, base, root, scopeDigest, storage, saved, stamp, normalizedSessionId, runnerInstanceId, providerLeaseId };
  }
  it("preserves failed backup bytes online while retaining failure and unrelated active work", async () => {
    const f = await fixture(), active = await environment.seedRun(randomUUID());
    const [before] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toEqual({ inspected: 1, published: 1, current: 0, deferred: {} });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(coordinator);
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, active.runId)))[0].status).toBe("running");
    expect(await readFile(join(f.root, "codex-home", "sessions", "history.json"), "utf8")).toBe(JSON.stringify(f.saved));
    const restored = join(environment.current.runtimeRoot, randomUUID()); homes.push(restored);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: restored })).toBe(true);
    expect(JSON.parse(await readFile(join(restored, "current", "codex-home", "sessions", "history.json"), "utf8"))).toEqual(f.saved);
    expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest)))[0].status).toBe("current");
  });
  it.each([["failed", "committed"], ["cancelled", "terminal_failure"], ["cancelled", "committed"]])("preserves %s source bytes with %s ownership without changing its status", async (status, phase) => {
    const f = await fixture();
    await f.db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    if (phase === "committed") {
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: run.completionContractId!, serverFingerprint: "settled-historical-result", schemaStatus: "accepted",
        resultJson: { summary: "Original settled result" }, canonicalSha256: "settled-historical-result" }).returning();
      await f.db.update(nativeRunFinalizations).set({ phase, resultId: result.id }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 1, deferred: {} });
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe(status);
  });
  it("never takes a nonnull expired coordinator or durable physical owner", async () => {
    const f = await fixture(), put = vi.spyOn(f.storage, "putFile");
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "original-owner", leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 0, deferred: { source_coordinator_unsettled: 1 } });
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, nativeWorkspaceFinalizationOwner: { token: "physical-owner" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 0, deferred: { source_changed: 1 } });
    expect(put).not.toHaveBeenCalled();
  });
  it.each([
    ["running", "source_run_active"],
    ["scheduled_retry", "source_run_active"],
    ["failed_unfinished", "source_run_unfinished"],
    ["coordinator_missing", "source_coordinator_missing"],
  ])("names why a %s source stays local", async (kind, outcome) => {
    const f = await fixture(), put = vi.spyOn(f.storage, "putFile");
    if (kind === "running" || kind === "scheduled_retry") await f.db.update(heartbeatRuns).set({ status: kind, finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "failed_unfinished") await f.db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "coordinator_missing") await f.db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 0, deferred: { [outcome]: 1 } });
    expect(put).not.toHaveBeenCalled();
  });
  it.each(["unselected", "ambiguous"])("preserves a settled source whose session is %s, as the offline migration does", async selection => {
    const f = await fixture();
    if (selection === "unselected") await f.db.delete(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, f.runId));
    else await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
      adapterType: "paperclip_runner", taskKey: `${f.issueId}:second`, lastRunId: f.runId });
    const sessions = await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, f.runId));
    const [before] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const result = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) });
    expect(result.published).toBe(1);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(environment.current.runtimeRoot, randomUUID()));
    const leftover = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) });
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", f.base);
    expect(leftover).toMatchObject({ inspected: 0, published: 0 });
    expect(result.deferred).toEqual(leftover.deferred);
    expect((await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest)))[0].status).toBe("current");
    expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    expect(await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, f.runId))).toEqual(sessions);
    expect(await readFile(join(f.root, "codex-home", "sessions", "history.json"), "utf8")).toBe(JSON.stringify(f.saved));
    const restored = join(environment.current.runtimeRoot, randomUUID()); homes.push(restored);
    expect(await restoreDurableNativeHarnessBackup({ ...f, backupRoot: restored })).toBe(true);
    expect(JSON.parse(await readFile(join(restored, "current", "codex-home", "sessions", "history.json"), "utf8"))).toEqual(f.saved);
  });
  it("keeps the source local when its session selection changes before publication", async () => {
    const f = await fixture(), put = f.storage.putFile.bind(f.storage);
    await f.db.delete(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, f.runId));
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      await f.db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: environment.current.agentId,
        adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId });
      return result;
    });
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 0, deferred: { source_changed: 1 } });
    expect(await f.db.select({ status: nativeHarnessBackups.status }).from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest)))
      .toEqual([{ status: "pending" }]);
  });
  it("names a selected session whose backup source is not on this disk", async () => {
    const f = await fixture(), signal = AbortSignal.timeout(15_000);
    await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const present = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    expect(present.deferred.source_run_active).toBe(1);
    await rm(join(f.base, f.scopeDigest), { recursive: true });
    const absent = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    expect(absent.deferred.source_run_active).toBeUndefined();
    expect(absent.deferred.selected_source_absent).toBe((present.deferred.selected_source_absent ?? 0) + 1);
    expect(absent).toMatchObject({ inspected: 0, published: 0 });
  });
  it.each(["online", "offline"])("records a settled selected session whose backup source is gone and moves %s", async path => {
    const f = await fixture(), signal = AbortSignal.timeout(15_000);
    await f.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const baseline = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await rm(join(f.base, f.scopeDigest), { recursive: true });
    if (path === "online") {
      const outcomes: string[] = [];
      const result = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal, onOutcome: outcome => outcomes.push(outcome) });
      expect(result.sourceGone).toBe(1);
      expect(result.deferred.selected_source_absent).toBe(baseline.deferred.selected_source_absent);
      expect(outcomes.filter(outcome => outcome === "source_gone_recorded")).toHaveLength(1);
    } else await migrateNativeHarnessBackups(f.db, { storage: f.storage, writersStopped: true, signal });
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("failed");
    expect(run.runnerProfileJson?.nativeHarnessBackupSourceAbsent).toMatchObject({
      scopes: { [f.scopeDigest]: { manifestSha256s: [f.stamp.manifestSha256] } } });
    expect(await f.db.select().from(activityLog).where(and(eq(activityLog.runId, f.runId),
      eq(activityLog.action, "native_harness_backup_source_gone_recorded")))).toHaveLength(1);
    expect(await f.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.lastRunId, f.runId))).toHaveLength(1);
    expect((await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal })).sourceGone).toBeUndefined();
    const newer = `sha256:${"e".repeat(64)}`;
    await f.db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      providerLeaseId: randomUUID(), status: "expired", metadata: { nativeHarnessBackup: { ...f.stamp, manifestSha256: newer } } });
    expect((await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal })).sourceGone).toBe(1);
    const [again] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(again.runnerProfileJson?.nativeHarnessBackupSourceAbsent).toMatchObject({
      scopes: { [f.scopeDigest]: { manifestSha256s: [f.stamp.manifestSha256, newer].sort() } } });
  });
  it.each([
    ["active", "selected_source_absent"],
    ["retiring", "selected_source_retiring"],
    ["previous", "selected_source_unsettled"],
  ])("keeps a gone backup source blocked while the session is %s", async (kind, outcome) => {
    const f = await fixture(), signal = AbortSignal.timeout(15_000);
    const baseline = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    await f.db.delete(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    await rm(join(f.base, f.scopeDigest), { recursive: true });
    if (kind === "active") await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    else await mkdir(join(f.base, f.scopeDigest, "failover-backups", kind === "previous" ? "previous" : `.retiring-${randomUUID()}`), { recursive: true });
    const result = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    expect(result.deferred[outcome]).toBe((baseline.deferred[outcome] ?? 0) + 1);
    expect(result.sourceGone).toBeUndefined();
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.runnerProfileJson?.nativeHarnessBackupSourceAbsent).toBeUndefined();
  });
  it("names a gone backup source whose run row is busy and records it on the next pass", async () => {
    const f = await fixture(), signal = AbortSignal.timeout(15_000);
    const baseline = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
    await f.db.delete(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest));
    await rm(join(f.base, f.scopeDigest), { recursive: true });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const holder = f.db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update"); entered(); await gate;
    });
    try {
      await ready;
      const busy = await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal });
      expect(busy.deferred.selected_source_busy).toBe((baseline.deferred.selected_source_busy ?? 0) + 1);
    } finally { release(); await holder; }
    expect((await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal })).sourceGone).toBe(1);
  });
  it("stops the selected-source scan once the pass is cancelled", async () => {
    const f = await fixture(), controller = new AbortController();
    await rm(join(f.base, f.scopeDigest), { recursive: true });
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, nativeHarnessFilesystemIndependence: {} } })
      .where(eq(heartbeatRuns.id, f.runId));
    const check = vi.spyOn(independence, "hasValidNativeHarnessFilesystemIndependence");
    const execute = f.db.execute.bind(f.db);
    const scan = vi.spyOn(f.db, "execute").mockImplementation(((query: Parameters<typeof execute>[0]) => {
      controller.abort(new Error("budget spent"));
      return execute(query);
    }) as typeof f.db.execute);
    const outcomes: string[] = [];
    await expect(prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: controller.signal,
      onOutcome: outcome => outcomes.push(outcome) })).rejects.toThrow("budget spent");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });
  it("respects the physical advisory lock while unrelated work stays active", async () => {
    const f = await fixture(), put = vi.spyOn(f.storage, "putFile");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const holder = f.db.transaction(async tx => { expect(await tryLockNativeWorkspaceFinalization(tx as never, f)).toBe(true); entered(); await gate; });
    try {
      await ready;
      expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
        .toMatchObject({ published: 0, deferred: { source_changed: 1 } });
      expect(put).not.toHaveBeenCalled();
    } finally { release(); await holder; }
  });
  it.each(["owner", "payload"])("retains the uploaded pending receipt when %s changes before publication", async change => {
    const f = await fixture(), put = f.storage.putFile.bind(f.storage);
    vi.spyOn(f.storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (change === "owner") await f.db.update(nativeRunFinalizations).set({ leaseOwner: "new-owner", leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      else await writeFile(join(f.root, "codex-home", "sessions", "history.json"), "newer surviving files");
      return result;
    });
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 0, deferred: { source_changed: 1 } });
    expect(await f.db.select({ status: nativeHarnessBackups.status }).from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest)))
      .toEqual([{ status: "pending" }]);
    if (change === "owner") expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].leaseOwner).toBe("new-owner");
    else expect(await readFile(join(f.root, "codex-home", "sessions", "history.json"), "utf8")).toBe("newer surviving files");
  });
  it("does not authenticate a changed current payload from an intact previous backup", async () => {
    const f = await fixture(), previous = join(f.root, "..", "previous");
    await cp(f.root, previous, { recursive: true });
    await writeFile(join(f.root, "codex-home", "sessions", "history.json"), "changed current payload");
    const signal = AbortSignal.timeout(15_000);
    expect(await verifyNativeHarnessBackupStampAsync(f.stamp, f.providerLeaseId, signal)).toBe(true);
    expect(await verifyNativeHarnessBackupStampAsync(f.stamp, f.providerLeaseId, signal, f.root)).toBe(false);
    expect(await prestageNativeHarnessBackups(f.db, { storage: f.storage, signal })).toMatchObject({ published: 0 });
    expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, f.scopeDigest))).toEqual([]);
  });
  it("binds the archive payload and scope to the checked preservation owner", async () => {
    const f = await fixture(), signal = AbortSignal.timeout(15_000);
    const { owner } = await settledNativeHarnessBackupOwner(f.db, { ...f, sessionId: f.normalizedSessionId,
      manifestSha256: f.stamp.manifestSha256, signal });
    expect(owner).not.toBeNull();
    const put = vi.spyOn(f.storage, "putFile");
    await expect(persistNativeHarnessBackup({ ...f, owner: owner!, root: join(f.root, "..", "previous"), signal }))
      .rejects.toThrow("preservation_source_changed");
    await expect(persistNativeHarnessBackup({ ...f, owner: owner!, scopeDigest: "f".repeat(64), signal }))
      .rejects.toThrow("preservation_source_changed");
    expect(put).not.toHaveBeenCalled();
  });
  it("keeps the command transaction alive while exact payload verification exceeds thirty seconds", async () => {
    const f = await fixture(), db = createDb(nativeHarnessPrestageDatabaseUrl(environment.current.temporary.connectionString));
    const original = backupStamp.verifyNativeHarnessBackupStampAsync;
    let slowed = false;
    const spy = vi.spyOn(backupStamp, "verifyNativeHarnessBackupStampAsync").mockImplementation(async (...args) => {
      if (args[3] !== undefined && !slowed) { slowed = true; await new Promise(resolve => setTimeout(resolve, 32_000)); }
      return original(...args);
    });
    try {
      expect((await db.$client.unsafe("show idle_in_transaction_session_timeout"))[0].idle_in_transaction_session_timeout).toBe("30s");
      expect(await prestageNativeHarnessBackups(db, { storage: f.storage, signal: AbortSignal.timeout(60_000) }))
        .toMatchObject({ published: 1, deferred: {} });
      expect(slowed).toBe(true);
    } finally { spy.mockRestore(); await db.$client.end({ timeout: 1 }); }
  }, 60_000);
  it("defers a stamped archive-invalid source and preserves the next eligible source", async () => {
    const bad = await fixture({ scopeId: "b", unsafeLink: true });
    const good = await fixture({ base: bad.base, scopeId: "a" });
    expect(bad.scopeDigest < good.scopeDigest).toBe(true);
    expect(await prestageNativeHarnessBackups(bad.db, { storage: bad.storage, signal: AbortSignal.timeout(15_000) }))
      .toMatchObject({ published: 1, deferred: { source_changed: 1 } });
    expect(await bad.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, bad.scopeDigest))).toEqual([]);
    expect((await good.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, good.scopeDigest)))[0].status).toBe("current");
  });
});
