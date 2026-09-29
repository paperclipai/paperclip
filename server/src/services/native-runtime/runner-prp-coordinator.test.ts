import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeAuthorityRecords,
  nativeSessionAuthorities,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "@paperclipai/paperclip-runner";
import { DurablePrpControlPlane, NativeSessionProtocolIntegrityError } from "../../vendor/paperclip-runner/index.js";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { createNativePostgresAuthorityStore, PostgresAuthorityStore } from "./postgres-authority-store.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { runnerPrpCoordinator } from "./runner-prp-coordinator.js";
import { PaperclipRunnerSemanticAuthority } from "./runner-semantic-authority.js";
import { nativeSha256 } from "./canonical.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { startNativeLegacyMigrationLease } from "./native-legacy-migration.js";
import { HistoryPayloadStore } from "./history-payload-store.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runner coordinator tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface SeededNativeRun {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  runnerInstanceId: string;
  sessionId: string;
  completionContractId: string;
  completionContractSha256: string;
}

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "The hidden runner completed the bounded task.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "coordinator test", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

function runnerEvent(seed: SeededNativeRun, sourceSeq = 1): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `event-${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: seed.runnerInstanceId,
    sourceKind: "runner",
    runId: seed.runId,
    normalizedSessionId: seed.sessionId,
    turnId: "turn-1",
    itemId: "item-1",
    eventType: "turn.started",
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-25T18:00:00.000Z",
    payload: {},
  };
}

describeEmbeddedPostgres("hidden runner PRP coordinator", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const scratchDirectories: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-runner-coordinator-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await db.delete(nativeAuthorityRecords);
    await db.delete(nativeSessionAuthorities);
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retains a migration beyond its original lease and cancels when its exact owner changes", async () => {
    const seed = await seedNativeRun();
    const controller = await currentNativeControllerIdentity();
    const leaseOwner = randomUUID();
    await db.insert(nativeRunFinalizations).values({ companyId: seed.companyId, issueId: seed.issueId, runId: seed.runId,
      phase: "observed", attempt: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 10_000),
      controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt });
    const maintenance = await startNativeLegacyMigrationLease({ db,
      owner: { companyId: seed.companyId, issueId: seed.issueId, runId: seed.runId,
        normalizedSessionId: seed.sessionId, runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1" },
      lease: { owner: leaseOwner, attempt: 1 }, assertStoppedProcessTree: async () => {},
    }, { leaseMs: 2_000, intervalMs: 100, timeoutMs: 500 });
    try {
      await new Promise(resolve => setTimeout(resolve, 4_500));
      await maintenance.assertLease();
      const [retained] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId));
      expect(retained?.leaseOwner).toBe(leaseOwner);
      expect(retained?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
      await db.update(nativeRunFinalizations).set({ leaseOwner: "replacement-owner" }).where(eq(nativeRunFinalizations.runId, seed.runId));
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("migration staging was not cancelled")), 3_000);
        const cancelled = () => { clearTimeout(deadline); resolve(); };
        if (maintenance.signal.aborted) cancelled();
        else maintenance.signal.addEventListener("abort", cancelled, { once: true });
      });
      await expect(maintenance.assertLease()).rejects.toThrow("native_legacy_migration_lease_lost");
      const [replaced] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId));
      expect(replaced?.leaseOwner).toBe("replacement-owner");
    } finally { await maintenance.stop(); }
  }, 15_000);

  it("uses wall-clock migration expiry inside a transaction and never waits on its own renewal lock", async () => {
    const seed = await seedNativeRun();
    const controller = await currentNativeControllerIdentity();
    const leaseOwner = randomUUID();
    await db.insert(nativeRunFinalizations).values({ companyId: seed.companyId, issueId: seed.issueId, runId: seed.runId,
      phase: "observed", attempt: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 10_000),
      controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt });
    const maintenance = await startNativeLegacyMigrationLease({ db,
      owner: { companyId: seed.companyId, issueId: seed.issueId, runId: seed.runId,
        normalizedSessionId: seed.sessionId, runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1" },
      lease: { owner: leaseOwner, attempt: 1 }, assertStoppedProcessTree: async () => {},
    }, { leaseMs: 3_000, intervalMs: 50, timeoutMs: 1_000 });
    try {
      await db.transaction(async tx => {
        await maintenance.assertLease(tx);
        // The timer's other connection now waits for our row lock. Rechecking
        // through this transaction must not await that blocked connection.
        await tx.execute(sql`select pg_sleep(0.2)`);
        await maintenance.assertLease(tx);
      });
      await maintenance.assertLease();
      await maintenance.stop();
      await expect(db.transaction(async tx => {
        await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() + interval '100 milliseconds'` })
          .where(eq(nativeRunFinalizations.runId, seed.runId));
        await tx.execute(sql`select pg_sleep(0.2)`);
        await maintenance.assertLease(tx);
      })).rejects.toThrow("native_legacy_migration_lease_lost");
    } finally { await maintenance.stop(); }
  }, 15_000);

  it.each([0, 1, 260])("requires retirement of indexed owners without replaying historical provider events (owners: %s)", async (ownerCount) => {
    const seed = await seedNativeRun();
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, seed.agentId));
    await db.insert(nativeRunFinalizations).values({ companyId: seed.companyId, issueId: seed.issueId, runId: seed.runId, phase: "observed" });
    const identity = { runId: seed.runId, normalizedSessionId: seed.sessionId, runnerInstanceId: seed.runnerInstanceId,
      environmentLeaseId: "environment-1", turnId: "turn-1", itemId: "item-1" };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      identity: { companyId: seed.companyId, issueId: seed.issueId, agentId: seed.agentId, runId: seed.runId, sessionId: seed.sessionId },
    } } }).where(eq(heartbeatRuns.id, seed.runId));
    // A former transcript PID is deliberately live and has no start identity.
    // It is history, not the new format's unresolved ownership authority.
    await db.insert(heartbeatRunEvents).values({ companyId: seed.companyId, runId: seed.runId, agentId: seed.agentId,
      seq: 1, eventType: "session.started", stream: "system", level: "info", payload: { prpEvent: { payload: { processId: process.pid } } } });
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    const authority = new PostgresAuthorityStore(db, owner, async () => {});
    const state = { identity, indexedState: { processOwnerIndexVersion: 1, providerEverStarted: true } };
    let generation = await authority.commit({ expectedGeneration: "0", state, records: [] });
    if (ownerCount) {
      for (let offset = 0; offset < ownerCount; offset += 128) {
        const work = Array.from({ length: Math.min(128, ownerCount - offset) }, (_, ordinal) => {
          const index = offset + ordinal, launchId = `launch-${String(index).padStart(5, "0")}`;
          return { collection: "process-owner" as const, id: launchId, expectedSha256: null,
            body: { schema: "paperclip.process-owner.v1", identity, sourceSeq: index + 1, sourceEventId: `owner-${index}`,
              // No recorded PID survives. This does not prove descendants
              // stopped, so the launch still prevents replacement admission.
              startup: { launchId, processTreeRetired: false, phase: "spawned", processId: 2147483647, processGroupId: 2147483647 } } };
        });
        generation = await authority.commit({ expectedGeneration: generation, state, records: [], work });
      }
    }
    const result = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [seed.runId] });
    expect(result).toMatchObject([ownerCount ? { kind: "blocked", reason: "provider_process_tree_retirement_unproven" } : { kind: "resume_dead_runner" }]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.status).toBe(ownerCount ? "failed" : "running");
  });

  it("commits current owner rows with authority and rolls them back with a failed event", async () => {
    const seed = await seedNativeRun();
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    const authority = new PostgresAuthorityStore(db, owner, async () => { throw new Error("event commit failed"); });
    const start = { collection: "process-owner" as const, id: "launch-1", expectedSha256: null, body: { phase: "spawned", processId: 9001 } };
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { owners: 1 }, records: [], work: [start] });
    const work = (await authority.getWork("process-owner", "launch-1"))!;
    expect((await authority.readWorkPage("process-owner", "", 1, gen1)).records).toEqual([work]);
    await expect(authority.commit({ expectedGeneration: gen1, state: { owners: 0 }, records: [{ epoch: seed.runId, kind: "event", id: "stop", sequence: "1", body: { stopped: true } }],
      work: [{ ...start, expectedSha256: work.sha256, body: null }] })).rejects.toThrow("event commit failed");
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { owners: 1 } });
    expect(await authority.getWork("process-owner", "launch-1")).toEqual(work);
    expect(await authority.getRecord(seed.runId, "event", "stop")).toBeNull();
    await expect(authority.commit({ expectedGeneration: gen1, state: {}, records: [], work: [{ ...start, expectedSha256: "0".repeat(64), body: null }] })).rejects.toThrow("stale_authority");
    const otherCompany = new PostgresAuthorityStore(db, { ...owner, companyId: randomUUID() }, async () => {});
    expect(await otherCompany.getWork("process-owner", "launch-1")).toBeNull();
    const gen2 = await authority.commit({ expectedGeneration: gen1, state: { owners: 0 }, records: [{ epoch: seed.runId, kind: "effect", id: "stop", sequence: "1", body: { stopped: true } }], work: [{ ...start, expectedSha256: work.sha256, body: null }] });
    await expect(authority.readWorkPage("process-owner", "", 1, gen1)).rejects.toThrow("stale_authority");
    expect((await authority.readWorkPage("process-owner", "", 128, gen2)).records).toEqual([]);
  });

  it("keeps the same controller writable after a PostgreSQL capacity rejection proves rollback", async () => {
    const seed = await seedNativeRun();
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-pg-capacity-"));
    scratchDirectories.push(root);
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    let full = false;
    const authority = new PostgresAuthorityStore(db, owner, async () => {}, async tx => {
      if (full) await tx.execute(sql`do $$begin raise exception 'qualified capacity fault' using errcode = '53100'; end$$`);
    });
    const core = await DurablePrpControlPlane.open({ stateDirectory: root, authorityStore: authority,
      identity: { runId: seed.runId, normalizedSessionId: seed.sessionId, runnerInstanceId: seed.runnerInstanceId,
        environmentLeaseId: "environment-1", turnId: "turn-1", itemId: "item-1" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      const before = await authority.load();
      full = true;
      await expect(core.issueBootstrapTicket()).rejects.toMatchObject({ code: "storage_pressure" });
      expect(await authority.load()).toEqual(before);
      expect(Object.keys(core.store.state.tickets)).toHaveLength(0);
      full = false;
      expect(await core.issueBootstrapTicket()).toBeTruthy();
      expect(Object.keys(core.store.state.tickets)).toHaveLength(1);
      const after = (await authority.load())!;
      expect(after.committedFrom).toBe(before!.generation);
      expect(after.generation).not.toBe(before!.generation);
      expect(after.generation).toMatch(/^r:/);
    } finally { await core.stop(); }
  });

  it("rolls back raw receipts and cursors on a PostgreSQL capacity error after their writes", async () => {
    const seed = await seedNativeRun();
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    let full = true;
    const authority = new PostgresAuthorityStore(db, owner, async tx => {
      if (full) await tx.execute(sql`do $$begin raise exception 'qualified capacity fault' using errcode = '53100'; end$$`);
    });
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 0 }, records: [] });
    const next = { expectedGeneration: gen1, state: { cursor: 1 }, records: [{ epoch: seed.runId, kind: "event" as const,
      id: "event-1", sequence: "1", body: { original: true } }] };
    await expect(authority.commit(next)).rejects.toMatchObject({ code: "storage_pressure" });
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { cursor: 0 } });
    expect(await authority.getRecord(seed.runId, "event", "event-1")).toBeNull();
    full = false;
    const gen2 = await authority.commit(next);
    expect(await authority.load()).toEqual({ generation: gen2, committedFrom: gen1, state: { cursor: 1 } });
    expect(await authority.getRecord(seed.runId, "event", "event-1")).toEqual(next.records[0]);
  });

  it("commits indexed authority, exact receipts and native events in one Postgres transaction", async () => {
    const seed = await seedNativeRun();
    const native = store(seed);
    const owner = {
      companyId: seed.companyId, issueId: seed.issueId,
      normalizedSessionId: seed.sessionId, runnerInstanceId: seed.runnerInstanceId,
      environmentLeaseId: "environment-1", runId: seed.runId,
    };
    let rejectCommit = false;
    const authority = new PostgresAuthorityStore(db, owner, async (tx, records) => {
      for (const record of records) await native.appendEventInTransaction(tx, record.body as unknown as PrpEvent);
      if (rejectCommit) throw new Error("injected failure before transaction commit");
    });
    const record = (seq: number) => ({ epoch: seed.runId, kind: "event" as const, id: `event-${seq}`, sequence: String(seq), body: runnerEvent(seed, seq) as unknown as Record<string, unknown> });
    expect(await authority.load()).toBeNull();
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 1 }, records: [record(1)] });
    rejectCommit = true;
    await expect(authority.commit({ expectedGeneration: gen1, state: { cursor: 2 }, records: [record(2)] })).rejects.toThrow("injected failure");
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { cursor: 1 } });
    expect(await authority.getRecord(seed.runId, "event", "event-2")).toBeNull();
    expect((await db.select().from(heartbeatRunEvents)).length).toBe(1);
    rejectCommit = false;
    await expect(authority.commit({ expectedGeneration: "0", state: {}, records: [] })).rejects.toThrow("stale_authority");
    await expect(authority.commit({ expectedGeneration: gen1, state: {}, records: [{ ...record(1), body: { ...record(1).body, payload: { changed: true } } }] })).rejects.toThrow("receipt_conflict");
    await expect(authority.commit({ expectedGeneration: gen1, state: {}, records: [{ ...record(1), id: "another-event" }] })).rejects.toThrow("receipt_conflict");
    const gen2 = await authority.commit({ expectedGeneration: gen1, state: { cursor: 2 }, records: [record(2)] });
    expect(await authority.load()).toEqual({ generation: gen2, committedFrom: gen1, state: { cursor: 2 } });
    const reopened = new PostgresAuthorityStore(db, owner, async () => {});
    expect(await reopened.getRecord(seed.runId, "event", "event-1")).toEqual(record(1));
    expect((await reopened.readEvents(seed.runId, "1", 128, 1048576)).records).toEqual([record(2)]);
    await expect(new PostgresAuthorityStore(db, { ...owner, issueId: randomUUID() }, async () => {}).load()).rejects.toThrow("binding/digest mismatch");
    expect(await new PostgresAuthorityStore(db, { ...owner, companyId: randomUUID() }, async () => {}).load()).toBeNull();
  });

  it("externalizes large immutable receipts without advancing authority on upload or transaction failure", async () => {
    const seed = await seedNativeRun();
    const root = mkdtempSync(resolve(tmpdir(), "paperclip-authority-payloads-"));
    scratchDirectories.push(root);
    const provider = createLocalDiskStorageProvider(root), payloads = new HistoryPayloadStore(provider);
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    let failCommit = false;
    const authority = new PostgresAuthorityStore(db, owner, async () => { if (failCommit) throw new Error("commit interrupted"); }, undefined, () => payloads);
    const record = (n: number) => ({ epoch: seed.runId, kind: "event" as const, id: `large-${n}`, sequence: String(n), body: { ordinal: n, text: "λ".repeat(300_000) } });
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 0 }, records: [] });
    failCommit = true;
    await expect(authority.commit({ expectedGeneration: gen1, state: { cursor: 1 }, records: [record(1)] })).rejects.toThrow("commit interrupted");
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { cursor: 0 } });
    expect(await authority.getRecord(seed.runId, "event", "large-1")).toBeNull();
    failCommit = false;
    const gen2 = await authority.commit({ expectedGeneration: gen1, state: { cursor: 2 }, records: [record(1), record(2)] });
    const rows = await db.select().from(nativeAuthorityRecords).orderBy(nativeAuthorityRecords.sequence);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.bodyEncoding === "object.v1" && row.body.length < 1024 && row.bodyBytes! > 600_000)).toBe(true);
    const reopened = new PostgresAuthorityStore(db, owner, async () => {}, undefined, () => new HistoryPayloadStore(provider));
    expect(await reopened.getRecord(seed.runId, "event", "large-1")).toEqual(record(1));
    const first = await reopened.readEvents(seed.runId, "0", 128, 1024 * 1024);
    expect(first.records).toEqual([record(1)]);
    expect((await reopened.readEvents(seed.runId, first.nextAfter!, 128, 1024 * 1024)).records).toEqual([record(2)]);
    const gen3 = await authority.commit({ expectedGeneration: gen2, state: { cursor: 2 }, records: [record(1)] });
    await expect(authority.commit({ expectedGeneration: gen3, state: {}, records: [{ ...record(1), body: record(2).body }] })).rejects.toThrow("receipt_conflict");
    const ref = JSON.parse(rows[0]!.body);
    writeFileSync(resolve(root, ref.objectKey), "corrupt");
    await expect(reopened.getRecord(seed.runId, "event", "large-1")).rejects.toThrow("history_payload_length_mismatch");
    // A failed immutable upload does not publish the next cursor or its receipt.
    const failed = new HistoryPayloadStore({ ...provider, putObject: async () => { throw new Error("storage pressure"); } });
    const pressured = new PostgresAuthorityStore(db, owner, async () => {}, undefined, () => failed);
    await expect(pressured.commit({ expectedGeneration: gen3, state: { cursor: 3 }, records: [record(3)] })).rejects.toThrow("storage pressure");
    expect(await authority.load()).toEqual({ generation: gen3, committedFrom: gen2, state: { cursor: 2 } });
    expect(await authority.getRecord(seed.runId, "event", "large-3")).toBeNull();
  });

  it("keeps raw transport receipts separate from translated run-log sequences", async () => {
    const seed = await seedNativeRun();
    const authority = createNativePostgresAuthorityStore(db, {
      companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId,
    }, seed.agentId);
    const event = runnerEvent(seed);
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 1 }, records: [{ epoch: seed.runId, kind: "event", id: event.sourceEventId, sequence: "1", body: { envelope: { payload: event } } }] });
    expect(await db.select().from(heartbeatRunEvents)).toHaveLength(0);
    const translated = { ...event, eventType: "session.started", payload: { providerSessionId: "translated-session" } } as PrpEvent;
    expect((await store(seed).appendEvent(translated)).disposition).toBe("committed");
    expect((await authority.getRecord(seed.runId, "event", event.sourceEventId))?.body).toEqual({ envelope: { payload: event } });
    expect((await store(seed).appendEvent(translated)).disposition).toBe("duplicate");
  });

  it("checks migration ownership inside the authority transaction and preserves receipts after lease loss", async () => {
    const seed = await seedNativeRun();
    await db.insert(nativeRunFinalizations).values({ runId: seed.runId, companyId: seed.companyId, issueId: seed.issueId, phase: "observed", leaseOwner: "migration-owner" });
    const authority = createNativePostgresAuthorityStore(db, {
      companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId,
    }, seed.agentId, async tx => {
      const [row] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId)).for("update");
      if (row?.leaseOwner !== "migration-owner") throw new Error("migration lease lost");
    });
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { phase: "prepared" }, records: [] });
    let stale: Promise<unknown> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.update(nativeRunFinalizations).set({ leaseOwner: "successor-owner" }).where(eq(nativeRunFinalizations.runId, seed.runId));
        // The new lease is still uncommitted when this old writer starts.
        // Its transaction must wait and reject, rather than trusting an
        // earlier application-level lease check.
        const event = runnerEvent(seed);
        stale = authority.commit({ expectedGeneration: gen1, state: { phase: "active" }, records: [{ epoch: seed.runId, kind: "event", id: event.sourceEventId, sequence: "1", body: { envelope: { payload: event } } }] })
          .then(() => { throw new Error("stale authority was published"); }, error => { expect(error.message).toContain("migration lease lost"); });
      });
      await stale;
      expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { phase: "prepared" } });
      expect(await authority.getRecord(seed.runId, "event", runnerEvent(seed).sourceEventId)).toBeNull();
    } finally { await stale; }
  });

  it.each(["40P01", "40001"])("retries a PostgreSQL-aborted %s transaction without exposing partial receipts", async (code) => {
    const seed = await seedNativeRun();
    const native = store(seed);
    let calls = 0;
    const authority = new PostgresAuthorityStore(db, {
      companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId,
    }, async (tx, records) => {
      for (const record of records) await native.appendEventInTransaction(tx, record.body as unknown as PrpEvent);
      if (++calls === 1) await tx.execute(sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'qualification rollback' USING ERRCODE = '${code}'; END $$;`));
    });
    const event = runnerEvent(seed);
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 1 }, records: [{ epoch: seed.runId, kind: "event", id: event.sourceEventId, sequence: "1", body: event as unknown as Record<string, unknown> }] });
    expect(calls).toBe(2);
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { cursor: 1 } });
    expect(await db.select().from(nativeAuthorityRecords)).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents)).toHaveLength(1);
  });

  it("waits for the run lock before acquiring current authority during concurrent ingestion", async () => {
    const seed = await seedNativeRun();
    const authority = createNativePostgresAuthorityStore(db, {
      companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId,
    }, seed.agentId);
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 0 }, records: [] });
    let writer: Promise<string> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)).for("update");
        const [{ pid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
        const event = runnerEvent(seed);
        writer = authority.commit({ expectedGeneration: gen1, state: { cursor: 1 }, records: [{ epoch: seed.runId, kind: "event", id: event.sourceEventId, sequence: "1", body: { envelope: { payload: event } } }] });
        // Observe the actual lock wait, rather than assuming a sleep allowed
        // the writer to reach it. The old ordering held current authority here.
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const rows = await tx.execute(sql`select pid from pg_locks where not granted and ${Number(pid)} = any(pg_blocking_pids(pid))`);
          blocked = rows.length > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        const rows = await tx.select().from(nativeSessionAuthorities).where(eq(nativeSessionAuthorities.runId, seed.runId)).for("update", { noWait: true });
        expect(rows[0]?.generation).toBe(gen1);
      });
      const gen2 = await writer;
      expect(await authority.load()).toEqual({ generation: gen2, committedFrom: gen1, state: { cursor: 1 } });
    } finally {
      await writer?.catch(() => undefined);
    }
  });

  it("crosses the old maximum revision without replacing the run or losing exact receipts", async () => {
    const seed = await seedNativeRun();
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    const authority = new PostgresAuthorityStore(db, owner, async () => {});
    const original = { epoch: seed.runId, kind: "event" as const, id: "original", sequence: "1", body: { exact: "original receipt" } };
    await authority.commit({ expectedGeneration: "0", state: { cursor: 1 }, records: [original] });
    // Seed a retained v1 revision at its actual database boundary. Migration
    // preserves these decimals, and the first v2 write must not increment it.
    const maximum = "9223372036854775807";
    await db.update(nativeSessionAuthorities).set({ generation: maximum, committedFrom: null }).where(eq(nativeSessionAuthorities.runId, seed.runId));
    expect(await authority.load()).toEqual({ generation: maximum, state: { cursor: 1 } });
    const gen1 = await authority.commit({ expectedGeneration: maximum, state: { cursor: 2 }, records: [] });
    expect(gen1).toMatch(/^r:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: maximum, state: { cursor: 2 } });
    const gen2 = await authority.commit({ expectedGeneration: gen1, state: { cursor: 3 }, records: [original] });
    expect(gen2).not.toBe(gen1);
    await expect(authority.commit({ expectedGeneration: maximum, state: { stale: true }, records: [] })).rejects.toThrow("stale_authority");
    await expect(authority.commit({ expectedGeneration: gen1, state: { stale: true }, records: [] })).rejects.toThrow("stale_authority");
    const reopened = new PostgresAuthorityStore(db, owner, async () => {});
    expect(await reopened.load()).toEqual({ generation: gen2, committedFrom: gen1, state: { cursor: 3 } });
    expect(await reopened.getRecord(seed.runId, "event", "original")).toEqual(original);
    const rows = await db.select().from(nativeSessionAuthorities).where(eq(nativeSessionAuthorities.runId, seed.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: seed.runId, normalizedSessionId: seed.sessionId, successorRunId: null });
  });

  it("stores multiple unordered effects while preserving ordered receipts and old effect identities", async () => {
    const seed = await seedNativeRun();
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    const authority = new PostgresAuthorityStore(db, owner, async () => {});
    expect(authority.unorderedEffectReceipts).toBe(true);
    const old = { epoch: seed.runId, kind: "effect" as const, id: "old", sequence: "9223372036854775807", body: { exact: "old" } };
    const first = { ...old, id: "first", sequence: "0", body: { exact: "first" } };
    const second = { ...first, id: "second", body: { exact: "second" } };
    const event = { ...first, kind: "event" as const, id: "event", sequence: "1" };
    const generation = await authority.commit({ expectedGeneration: "0", state: { settled: true }, records: [old, first, second, event] });
    const reopened = new PostgresAuthorityStore(db, owner, async () => {});
    for (const receipt of [old, first, second]) expect(await reopened.getSessionEffect(receipt.id)).toEqual(receipt);
    for (const conflicting of [{ ...first, body: { exact: "changed" } }, { ...old, sequence: "0" }, { ...event, id: "event-alias" }]) {
      await expect(reopened.commit({ expectedGeneration: generation, state: {}, records: [conflicting] })).rejects.toThrow("receipt_conflict");
    }
    expect(await reopened.load()).toMatchObject({ generation, state: { settled: true } });
    expect(await reopened.getRecord(seed.runId, "event", "event-alias")).toBeNull();
  });

  it.each(["command", "event"] as const)("indexes %s ordinals within renewable epochs while keeping exact identity", async kind => {
    const seed = await seedNativeRun();
    const owner = { companyId: seed.companyId, issueId: seed.issueId, normalizedSessionId: seed.sessionId,
      runnerInstanceId: seed.runnerInstanceId, environmentLeaseId: "environment-1", runId: seed.runId };
    const authority = new PostgresAuthorityStore(db, owner, async () => {});
    expect(authority.commandEpochs).toBe(true);
    const original = { epoch: seed.runId, kind, id: "original", sequence: "1", body: { exact: true } };
    const next = { ...original, id: "next", sequenceEpoch: randomUUID() };
    const third = { ...next, id: "third", sequenceEpoch: randomUUID() };
    const generation = await authority.commit({ expectedGeneration: "0", state: {}, records: [original, next, third] });
    const reopened = new PostgresAuthorityStore(db, owner, async () => {});
    for (const record of [original, next, third]) expect(await reopened.getRecord(seed.runId, kind, record.id)).toEqual(record);
    for (const record of [{ ...original, sequenceEpoch: randomUUID() }, { ...next, id: "alias" }]) {
      await expect(reopened.commit({ expectedGeneration: generation, state: {}, records: [record] })).rejects.toThrow("receipt_conflict");
    }
    if (kind === "event") {
      for (const record of [original, next, third]) expect((await reopened.readEvents(seed.runId, "0", 128, 1024 * 1024, "sequenceEpoch" in record && typeof record.sequenceEpoch === "string" ? record.sequenceEpoch : undefined)).records).toEqual([record]);
    }
    expect((await reopened.load())?.generation).toBe(generation);
  });

  async function seedNativeRun(): Promise<SeededNativeRun> {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const runnerInstanceId = randomUUID();
    const sessionId = randomUUID();
    const completionContractId = randomUUID();
    const completionContractSha256 = `sha256:${"c".repeat(64)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Runner Test Company",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex runner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RUN-${runId.slice(0, 8)}`,
      title: "Exercise the hidden native coordinator",
      description: "Verify transport and durable server boundaries.",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: completionContractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "policy-v1",
      risk: "low",
      completionAuthority: "runner",
      incompleteCriteriaPolicy: "fail_closed",
      contractJson: { criteria: [] },
      canonicalSha256: completionContractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      runnerInstanceId,
      nativeSessionId: sessionId,
      driverKind: "codex",
      driverVersion: "0.3.0",
      completionContractId,
      completionContractSha256,
      nativePhase: "observed",
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    return {
      companyId,
      issueId,
      agentId,
      runId,
      runnerInstanceId,
      sessionId,
      completionContractId,
      completionContractSha256,
    };
  }

  function store(seed: SeededNativeRun): NativeRunCoordinatorStore {
    return new NativeRunCoordinatorStore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      runId: seed.runId,
      agentId: seed.agentId,
      normalizedSessionId: seed.sessionId,
      runnerSourceInstanceId: seed.runnerInstanceId,
      completionContractId: seed.completionContractId,
      completionContractSha256: seed.completionContractSha256,
      completionContractRevision: "1",
      completionContractCriterionIds: [],
    });
  }

  it("registers only an exact Codex native binding and exposes read-only tools", async () => {
    const seed = await seedNativeRun();
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3213" });
    const stateRoot = mkdtempSync(resolve(tmpdir(), "paperclip-runner-state-"));
    scratchDirectories.push(stateRoot);
    const coordinator = runnerPrpCoordinator(db, { stateRoot });
    await expect(
      coordinator.prepare({
        ...seed,
        companyId: randomUUID(),
        normalizedSessionId: seed.sessionId,
        environmentLeaseId: "environment-lease-1",
        turnId: "turn-1",
        itemId: "item-1",
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow("runner_prp_run_not_authorized");
    const prepared = await coordinator.prepare({
      ...seed,
      normalizedSessionId: seed.sessionId,
      environmentLeaseId: "environment-lease-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerVersion: "0.3.0",
      runnerDigest: `sha256:${"a".repeat(64)}`,
    });

    expect(prepared.connectUrl).toBe(
      `ws://127.0.0.1:3213/api/runner/v1/connect/${seed.runId}`,
    );
    expect(prepared.bootstrapTicket).toMatch(/^bootstrap_/);
    expect(prepared.semanticTools.map((tool) => tool.name)).toEqual([
      "get_task_context",
      "get_task_history",
      "list_documents",
      "read_document",
      "list_document_revisions",
    ]);
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: seed.companyId,
        runId: seed.runId,
      }),
    ).toBe(true);
    await expect(
      coordinator.prepare({
        ...seed,
        normalizedSessionId: seed.sessionId,
        environmentLeaseId: "environment-lease-1",
        turnId: "turn-1",
        itemId: "item-1",
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow("runner_prp_authority_already_registered");
    await prepared.release();
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: seed.companyId,
        runId: seed.runId,
      }),
    ).toBe(false);
    server.close();
  });

  it("rechecks task ownership and returns semantic receipts", async () => {
    const seed = await seedNativeRun();
    const authority = new PaperclipRunnerSemanticAuthority(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      runId: seed.runId,
      agentId: seed.agentId,
    });
    const call = {
      callId: "call-1",
      operationId: "get_task_context",
      correlation: {
        runId: seed.runId,
        normalizedSessionId: seed.sessionId,
        turnId: "turn-1",
        itemId: "item-1",
      },
      input: {},
    };
    const allowed = await authority.dispatch(call);
    expect(allowed).toMatchObject({
      ok: true,
      operationId: "get_task_context",
      value: { activeTask: { id: seed.issueId }, run: { id: seed.runId } },
      inputReceipt: { phase: "input" },
      resultReceipt: { phase: "result" },
    });

    await db
      .update(issues)
      .set({ assigneeAgentId: null })
      .where(eq(issues.id, seed.issueId));
    const denied = await authority.dispatch({ ...call, callId: "call-2" });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "task_ownership_denied", retryable: false },
      resultReceipt: { phase: "result" },
    });
  });

  it("persists NUL-containing command output without changing replay identity", async () => {
    const seed = await seedNativeRun();
    const nativeStore = store(seed);
    const output = "transforming (6) ../\u0000virtual:/@storybook/builder-vite/storybook-stories.js";
    const payload = {
      schema: "paperclip.tool.execution.v1",
      executionId: "storybook-build",
      transport: "process",
      operation: "execute",
      status: "completed",
      output,
      outputBytes: Buffer.byteLength(output),
      outputTruncated: false,
      outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
      exitCode: 0,
    };
    const event: PrpEvent = {
      ...runnerEvent(seed),
      eventType: "tool.execution.completed",
      payload,
    };

    // The provider's valid JSON cannot be inserted directly into PostgreSQL JSONB.
    await expect(db.execute(sql`select ${JSON.stringify(event)}::jsonb`))
      .rejects.toMatchObject({ cause: { code: "22P05" } });
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "committed",
      cursor: 1,
    });
    const [row] = await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(row.payload).toEqual({ prpEvent: event });
    expect(row.sourcePayloadSha256).toBe(`sha256:${nativeSha256(row.payload?.prpEvent)}`);

    // Existing SQL selectors still see the event's ordinary routing fields.
    const [projection] = await db.select({
      sourceKind: sql<string>`${heartbeatRunEvents.payload}->'prpEvent'->>'sourceKind'`,
    }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.runId));
    expect(projection.sourceKind).toBe("runner");
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      cursor: 1,
    });
    await expect(nativeStore.appendEvent({
      ...event,
      payload: { ...payload, output: output.replaceAll("\u0000", "\\u0000") },
    })).rejects.toBeInstanceOf(NativeSessionProtocolIntegrityError);
    await expect(nativeStore.appendEvent(runnerEvent(seed, 2))).resolves.toMatchObject({
      disposition: "committed",
      cursor: 2,
    });
  });

  it("settles the exact earlier turn across source/public epochs and rejects conflicting old replay", async () => {
    const seed = await seedNativeRun();
    const nativeStore = store(seed);
    const first = runnerEvent(seed);
    await nativeStore.appendEvent(first);
    const proposed: PrpEvent = { ...runnerEvent(seed, 2), eventType: "run.result.proposed", payload: result };
    await nativeStore.appendEvent(proposed);
    const sourceEpoch = randomUUID();
    const terminalEvent: PrpEvent = { ...runnerEvent(seed, 1), sourceEpoch, sourceEventId: `terminal-${sourceEpoch}`,
      sourceEpochTransition: { schema: "paperclip.prp.event-epoch.v1", runId: seed.runId, transitionId: randomUUID(), fromEpoch: null, nextEpoch: sourceEpoch, finalOrdinal: 2 },
      eventType: "run.terminal", payload: terminal };
    await db.update(heartbeatRuns).set({ nextEventSeq: 1_000_001 }).where(eq(heartbeatRuns.id, seed.runId));
    const accepted = await nativeStore.appendEvent(terminalEvent);
    expect(accepted).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1, highestContiguousSourceEpoch: sourceEpoch });
    expect(accepted.cursor).toMatch(/^e:/);
    expect(await store(seed).appendEvent(first)).toMatchObject({ disposition: "duplicate", cursor: 1, highestContiguousSourceSeq: 1, highestContiguousSourceEpoch: sourceEpoch });
    await expect(nativeStore.appendEvent({ ...terminalEvent, priority: 2 })).rejects.toBeInstanceOf(NativeSessionProtocolIntegrityError);
    // A later proposal must not replace the result selected by the old terminal.
    await nativeStore.appendEvent({ ...runnerEvent(seed, 2), sourceEpoch, sourceEventId: `later-${sourceEpoch}`, eventType: "run.result.proposed", payload: { ...result, summary: "later" } });
    expect(await store(seed).reconcileTerminalEvent(terminalEvent)).toMatchObject({ disposition: "committed" });
    expect((await store(seed).readCompletedRun())?.result.summary).toBe(result.summary);
  });

  it("persists events and results idempotently and leases finalization", async () => {
    const seed = await seedNativeRun();
    const nativeStore = store(seed);
    await expect(nativeStore.completeRun({
      result: {
        ...result,
        completionClaim: { ...result.completionClaim, contractRevision: "2" },
      },
      terminal,
    })).rejects.toThrow("native_result_completion_contract_mismatch");
    await expect(nativeStore.completeRun({
      result: {
        ...result,
        completionClaim: {
          ...result.completionClaim,
          criteria: [{
            criterionId: "not-bound",
            status: "satisfied",
            evidenceRefs: [],
          }],
        },
      },
      terminal,
    })).rejects.toThrow("native_result_completion_contract_mismatch");
    const event = runnerEvent(seed);
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "committed",
      cursor: 1,
      highestContiguousSourceSeq: 1,
    });
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      cursor: 1,
    });
    await expect(
      nativeStore.appendEvent({ ...event, priority: 2 }),
    ).rejects.toBeInstanceOf(NativeSessionProtocolIntegrityError);
    await expect(nativeStore.appendEvent(runnerEvent(seed, 3))).rejects.toThrow(
      "native_event_source_gap",
    );

    const resultEvent = {
      ...runnerEvent(seed, 2),
      eventType: "run.result.proposed",
      payload: result,
    } as PrpEvent;
    const terminalEvent = {
      ...runnerEvent(seed, 3),
      eventType: "run.terminal",
      payload: terminal,
    } as PrpEvent;
    await nativeStore.appendEvent(resultEvent);
    await nativeStore.appendEvent(terminalEvent);
    const firstResult = await nativeStore.reconcileTerminalEvent(terminalEvent);
    if (!firstResult)
      throw new Error("terminal reconciliation returned no result");
    expect(firstResult.disposition).toBe("committed");
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      highestContiguousSourceSeq: 3,
    });
    await expect(
      nativeStore.completeRun({
        result,
        terminal,
        turnId: "turn-1",
        callerDedupeKey: "result-1",
      }),
    ).resolves.toEqual({ ...firstResult, disposition: "duplicate" });
    await expect(
      nativeStore.completeRun({
        result: { ...result, summary: "Conflicting retry" },
        terminal,
        turnId: "turn-1",
        callerDedupeKey: "result-1",
      }),
    ).rejects.toThrow("native_result_replay_conflict");

    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-1" }),
    ).resolves.toMatchObject({ attempt: 1, resultId: firstResult.resultId });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-1" }),
    ).resolves.toMatchObject({ attempt: 1, resultId: firstResult.resultId });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).rejects.toThrow("native_finalization_lease_conflict");
    await nativeStore.markFinalizationRetry({
      leaseOwner: "server-1",
      failureCode: "workspace_busy",
      retryAfterMs: 1_000,
    });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).rejects.toThrow("native_finalization_retry_not_due");
    await db
      .update(nativeRunFinalizations)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, seed.runId));
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).resolves.toMatchObject({ attempt: 2, resultId: firstResult.resultId });
  });
});
