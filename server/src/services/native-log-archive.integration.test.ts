import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../__tests__/helpers/native-restart.js";
import { createMaintenanceS3Boundary } from "../__tests__/helpers/maintenance/s3-boundary.js";
import { withMaintenanceProvider } from "../__tests__/helpers/maintenance/server-harness.js";
import { migrateRunEvidence } from "./run-evidence-migration.js";
import { getRunLogStore } from "./run-log-store.js";
import { createObjectByteJournal } from "./object-byte-journal.js";
import { readRecoverableRunLog } from "./native-runtime/native-run-log-recovery.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import * as storage from "./run-evidence-storage.js";

function beforeUuid(id: string) {
  const hex = (BigInt(`0x${id.replaceAll("-", "")}`) - 1n).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describeEmbeddedPostgres("online native historical log preservation", () => {
  const environment = nativeRestartFixture();
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  async function fixture() {
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, paperclipHome } = environment.current;
    const ref = `${companyId}/${agentId}/${f.runId}.ndjson`, base = join(paperclipHome, `archive-test-${f.runId}`);
    const file = join(base, ref), bytes = Buffer.from('{"seq":1,"chunk":"surviving 再開 output"}\n{"partial":');
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
    await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), logStore: "local_file", logRef: ref,
      logBytes: null, logSha256: null, controllerLeaseExpiresAt: new Date(0), processPid: 123456,
      processStartedAt: new Date(0), errorCode: "native_run_log_source_integrity_error", error: "original warning" })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: null, recoveryState: "blocked" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const options = { apply: true, companyId, afterRunId: beforeUuid(f.runId), limit: 1,
      kinds: ["log"] as const, preserveSettledNativeFiles: true };
    const s3 = createMaintenanceS3Boundary();
    return { ...f, companyId, agentId, ref, base, file, bytes, options, s3 };
  }
  async function withSource(action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture();
    await withMaintenanceProvider(f.s3.server, async endpoint => {
      for (const [key, value] of Object.entries({ PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_ENDPOINT: endpoint,
        PAPERCLIP_STORAGE_S3_BUCKET: "maintenance-test", PAPERCLIP_STORAGE_S3_REGION: "us-east-1",
        PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true", PAPERCLIP_STORAGE_S3_PREFIX: "",
        AWS_ACCESS_KEY_ID: "fixture-only", AWS_SECRET_ACCESS_KEY: "fixture-only",
        RUN_LOG_S3_ENDPOINT: endpoint, RUN_LOG_S3_BUCKET: "maintenance-test", RUN_LOG_S3_REGION: "us-east-1",
        RUN_LOG_S3_FORCE_PATH_STYLE: "true", RUN_LOG_S3_PREFIX: "run-logs", RUN_LOG_BASE_PATH: f.base,
        PAPERCLIP_EPHEMERAL_MIGRATION: "false" })) vi.stubEnv(key, value);
      await action(f);
      expect(f.s3.snapshot().errors).toEqual([]);
    });
  }

  it("archives a settled failed source while unrelated work runs and preserves its original failure", async () => {
    await withSource(async f => {
      const unrelated = await environment.seedRun(randomUUID());
      const [before] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [ownerBefore] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const result = await migrateRunEvidence(f.db, f.options);
      expect(result.items).toMatchObject([{ id: f.runId, state: "migrated", historicalArchive: true,
        bytes: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") }]);
      const [after] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(after).toEqual({ ...before, logStore: "s3_archive", logRef: `${f.companyId}/${f.agentId}/${f.runId}.archive` });
      expect((await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(ownerBefore);
      expect((await unrelated.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.runId)))[0].status).toBe("running");
      expect(await readFile(f.file)).toEqual(f.bytes);
      await rm(f.file);
      const store = getRunLogStore(), handle = { store: "s3_archive" as const, logRef: after.logRef! };
      expect((await readRecoverableRunLog(f.db, store, handle)).content).toBe(f.bytes.toString());
      expect(() => store.begin({ companyId: f.companyId, agentId: f.agentId, runId: f.runId, previousStore: "s3_archive" })).toThrow("read-only");
    });
  });

  it("preserves a committed successful run without changing its result or completeness metadata", async () => {
    await withSource(async f => {
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await f.db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: run.completionContractId!, serverFingerprint: f.runId, schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: f.runId }).returning();
      await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, recoveryState: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "migrated", historicalArchive: true }]);
      expect((await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.id, result.id)))[0]).toEqual(result);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ status: "succeeded", logBytes: null, logSha256: null, error: "original warning" });
    });
  });

  it("preserves exact bytes across the bounded archive segment boundary", async () => {
    await withSource(async f => {
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 7, 97);
      await writeFile(f.file, bytes);
      expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "migrated", bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") }]);
      await rm(f.file);
      const archive = createObjectByteJournal({ provider: storage.resolveRunEvidenceStorage()!.provider,
        prefix: `run-logs/segments-v1/${f.companyId}/${f.agentId}/${f.runId}.archive` });
      const head = (await archive.head())!.head;
      expect(head).toMatchObject({ closed: true, sourceCursor: 0 });
      expect(Buffer.concat([await archive.readRange(head, 0, 4 * 1024 * 1024),
        await archive.readRange(head, 4 * 1024 * 1024, 7)])).toEqual(bytes);
    });
  });

  it.each(["expired_owner", "pending_attempt", "pending_recovery", "allocation", "process_group", "physical_owner", "task_bound"])("refuses unresolved source authority: %s", async kind => {
    await withSource(async f => {
      if (kind === "expired_owner") await f.db.update(nativeRunFinalizations).set({ leaseOwner: "not-a-stop-proof", leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (kind === "pending_attempt") await f.db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (kind === "pending_recovery") await f.db.update(nativeRunFinalizations).set({ recoveryState: "awaiting_runner_reattach" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (kind === "allocation") await f.db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.runId, providerLeaseId: f.runId, status: "active" });
      if (kind === "process_group") await f.db.update(heartbeatRuns).set({ processGroupId: 999999 }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "physical_owner") await f.db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: { token: "unknown-owner" } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (kind === "task_bound") await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "blocked", reason: "native_log_archive_source_unsettled" }]);
      expect(f.s3.snapshot().requests).toEqual([]);
      expect(await readFile(f.file)).toEqual(f.bytes);
    });
  });

  it("honors the physical native finalizer lock and permits a read-only dry run", async () => {
    await withSource(async f => {
      let release!: () => void, ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const owner = f.db.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.runId })).toBe(true);
        ready(); await held;
      });
      try {
        await acquired;
        expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "blocked", reason: "native_log_archive_source_busy" }]);
      } finally { release(); await owner; }
      const result = await f.db.transaction(tx => migrateRunEvidence(tx as unknown as Db, { ...f.options, apply: false }), { accessMode: "read only" });
      expect(result.items).toMatchObject([{ state: "inventoried", historicalArchive: true }]);
      expect(f.s3.snapshot().requests).toEqual([]);
    });
  });

  it.each(["owner", "file"])("rechecks %s after the remote archive closes", async kind => {
    await withSource(async f => {
      const config = storage.resolveRunEvidenceStorage()!;
      vi.spyOn(storage, "resolveRunEvidenceStorage").mockReturnValue(config);
      const original = config.provider.putObjectConditional!.bind(config.provider); let changed = false;
      vi.spyOn(config.provider, "putObjectConditional").mockImplementation(async input => {
        const result = await original(input);
        if (!changed && input.objectKey.endsWith("/head.json") && Buffer.isBuffer(input.body) && JSON.parse(input.body.toString()).closed) {
          changed = true;
          if (kind === "file") await appendFile(f.file, "late source bytes");
          else await f.db.update(nativeRunFinalizations).set({ controllerGeneration: sql`${nativeRunFinalizations.controllerGeneration} + 1` })
            .where(eq(nativeRunFinalizations.runId, f.runId));
        }
        return result;
      });
      expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "blocked" }]);
      expect(changed).toBe(true);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].logStore).toBe("local_file");
      expect(f.s3.snapshot().objects.length).toBeGreaterThan(0);
    });
  });

  it.each(["symlink", "hardlink"])("refuses aliased source files: %s", async kind => {
    await withSource(async f => {
      const other = join(f.base, "other");
      if (kind === "hardlink") await link(f.file, other);
      else { await writeFile(other, f.bytes); await rm(f.file); await symlink(other, f.file); }
      expect((await migrateRunEvidence(f.db, f.options)).items).toMatchObject([{ state: "blocked" }]);
      expect(f.s3.snapshot().requests).toEqual([]);
    });
  });
});
