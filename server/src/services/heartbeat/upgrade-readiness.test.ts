import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, environmentLeases, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { nativeRunnerCheckpointWriter } from "../native-runtime/native-runner-checkpoint.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { readUpgradeReadiness, summarizeUpgradeReadiness } from "./upgrade-readiness.js";
const idle = { activeRuns: 0, pendingWakes: 0, draining: false };
const report = (patch: Partial<Parameters<typeof summarizeUpgradeReadiness>[0]> = {}) =>
  summarizeUpgradeReadiness({ rows: [{ id: "remote", recoverable: true }],
    before: { ...idle, activeRuns: 1 }, after: { ...idle, activeRuns: 1 },
    activeRunIds: ["remote"], controllerBootId: "this-boot", ...patch });
describe("upgrade readiness", () => {
  it("allows a known recoverable execution without stopping admission", () => {
    expect(report()).toMatchObject({ ready: true, activeRuns: 1, recoverableRuns: 1, blockingRuns: 0, draining: false });
  });
  it("retains an execution without positive recovery evidence as a blocker", () => {
    expect(report({ rows: [{ id: "remote", recoverable: false }] })).toMatchObject({ ready: false, blockingRuns: 1 });
  });
  it("blocks a new execution that appears while the query is in flight", () => {
    expect(report({ activeRunIds: ["remote", "new"], after: { ...idle, activeRuns: 2 } })).toMatchObject({ ready: false, activeRuns: 2, blockingRuns: 1 });
  });
  it("blocks an untracked execution promise and pending admission", () => {
    expect(report({ after: { ...idle, activeRuns: 2 } }).ready).toBe(false);
    expect(report({ after: { ...idle, activeRuns: 1, pendingWakes: 1 } }).ready).toBe(false);
    expect(report({ before: { ...idle, activeRuns: 1, draining: true } }).ready).toBe(false);
  });
  it("never treats a truncated census as complete", () => {
    const rows = Array.from({ length: 1_001 }, (_, i) => ({ id: String(i), recoverable: true }));
    expect(report({ rows, activeRunIds: [] })).toMatchObject({ ready: false, truncated: true });
  });
});

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_UPGRADE_READINESS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const postgresTests = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Upgrade readiness SQL tests unavailable: ${support.reason}`);
postgresTests("upgrade readiness persisted execution evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} };
    } else database = await startEmbeddedPostgresTestDatabase("paperclip-upgrade-readiness-");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });
  it("requires a bound checkpoint and current owner rather than a native label or live process alone", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const owner = await currentNativeControllerIdentity();
    await db.insert(companies).values({ id: companyId, name: "Upgrade", issuePrefix: `U${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Upgrade", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic upgrade", status: "in_progress", assigneeAgentId: agentId });
    const workspace = { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId: randomUUID(),
      leaseId: randomUUID(), providerLeaseId: "synthetic-sandbox", remoteCwd: "/workspace" };
    const execution = { runnerProfileJson: { nativeWorkspaceSync: workspace }, runtimeMode: "native", runnerInstanceId: randomUUID(), nativeSessionId: randomUUID(), processPid: process.pid, processStartedAt: new Date() };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "running", ...execution });
    const lease = { controllerBootId: owner.bootId, leaseOwner: "current-lease", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 60_000) };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", ...lease });
    const input = { activeRunIds: new Set([runId]), counters: () => ({ ...idle, activeRuns: 1 }) };
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    const binding = { runId, companyId, issueId };
    await db.insert(nativeRunnerCheckpoints).values({ ...binding, part: "header", material: {} });
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "upgrade-checkpoint-"));
    const core = new DurablePrpControlPlane({ stateDirectory: root,
      identity: { runId, runnerInstanceId: execution.runnerInstanceId, normalizedSessionId: execution.nativeSessionId,
        environmentLeaseId: workspace.workspaceId, turnId: "turn", itemId: "item" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    let header = "";
    const writer = nativeRunnerCheckpointWriter(db, { ...binding, ...lease, bootId: owner.bootId,
      authorityRunId: runId, generation: lease.controllerGeneration });
    core.setCheckpointPersistence(async checkpoint => {
      header = checkpoint.records.get("header")!;
      await writer(checkpoint);
    });
    try { core.issueBootstrapTicket(); await core.flushCheckpoint(); }
    finally { await core.stop(); await rm(root, { recursive: true, force: true }); }
    expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: true, recoverableRuns: 1 });
    const cipher = createLocalEncryptedCipher("write");
    // Real staging headers contain retained launch metadata around 113 KiB.
    const representativeHeader = JSON.stringify({ ...JSON.parse(header), padding: "x".repeat(100_000) });
    await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: representativeHeader })) })
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    for (const contents of ["{", "{}", JSON.stringify({ ...JSON.parse(header), schema: "paperclip.runner.controller-checkpoint.v1" }),
      JSON.stringify({ ...JSON.parse(header), padding: "x".repeat(400_000) }),
      JSON.stringify({ ...JSON.parse(header), state: { ...JSON.parse(header).state, identity: { ...JSON.parse(header).state.identity, runId: randomUUID() } } })]) {
      await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents })) })
        .where(eq(nativeRunnerCheckpoints.runId, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    }
    for (const field of ["runnerInstanceId", "normalizedSessionId", "environmentLeaseId"]) {
      const mismatch = JSON.stringify({ ...JSON.parse(header), state: { ...JSON.parse(header).state,
        identity: { ...JSON.parse(header).state.identity, [field]: randomUUID() } } });
      await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: mismatch })) })
        .where(eq(nativeRunnerCheckpoints.runId, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    }
    await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: header })) })
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    for (const patch of [{ runnerProfileJson: {} }, { runnerProfileJson: { nativeWorkspaceSync: {} } }, { runtimeMode: "legacy" }, { runnerInstanceId: null }, { nativeSessionId: null }, { processPid: null }, { processStartedAt: null }]) {
      await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
      await db.update(heartbeatRuns).set(execution).where(eq(heartbeatRuns.id, runId));
    }
    for (const patch of [{ leaseOwner: null }, { controllerGeneration: 0 }, { controllerBootId: "foreign" }, { leaseExpiresAt: new Date(0) }, { failureCode: "uncertain" }]) {
      await db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
      await db.update(nativeRunFinalizations).set({ ...lease, failureCode: null }).where(eq(nativeRunFinalizations.runId, runId));
    }
    // Plugin task admission owns an environment lease identity and deliberately has no workspace-sync record.
    const pluginLeaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: pluginLeaseId, companyId, heartbeatRunId: runId, issueId,
      provider: "plugin", providerLeaseId: "synthetic-task", metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: true } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false); // workspace identity is not plugin task authority
    const pluginHeader = JSON.stringify({ ...JSON.parse(header), state: { ...JSON.parse(header).state,
      identity: { ...JSON.parse(header).state.identity, environmentLeaseId: pluginLeaseId } } });
    await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: pluginHeader })) })
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    for (const patch of [{ status: "released" }, { expiresAt: new Date(0) }, { releasedAt: new Date() },
      { cleanupStatus: "pending" }, { metadata: { agentId: randomUUID(), runnerTaskLease: true, runnerTaskDispatched: true } }, { metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: false } },
      { metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskExecutionStopped: true } }]) {
      await db.update(environmentLeases).set(patch).where(eq(environmentLeases.id, pluginLeaseId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
      await db.update(environmentLeases).set({ status: "active", expiresAt: null, releasedAt: null, cleanupStatus: null, metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: true } }).where(eq(environmentLeases.id, pluginLeaseId));
    }
    await db.delete(environmentLeases).where(eq(environmentLeases.id, pluginLeaseId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: execution.runnerProfileJson }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: header })) })
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false); // the in-flight local tail is still unknown
    expect(await readUpgradeReadiness(db, { activeRunIds: new Set(), counters: () => idle })).toMatchObject({ ready: true, activeRuns: 0 });
  });
  it("cancels a locked probe within its SQL budget and releases its connection", async () => {
    const probeDb = createDb(database.connectionString, { maxConnections: 1 });
    const lock = await db.$client.reserve();
    try {
      await lock.unsafe("begin");
      await lock.unsafe("lock table native_runner_checkpoints in access exclusive mode");
      const started = performance.now();
      const result = readUpgradeReadiness(probeDb, { activeRunIds: new Set(), counters: () => idle })
        .then(() => null, error => error);
      const unrelatedStarted = performance.now();
      expect(await db.execute(sql`select 1 as value`)).toMatchObject([{ value: 1 }]);
      expect(performance.now() - unrelatedStarted).toBeLessThan(1_000);
      const failure = await result;
      expect(failure?.cause?.code ?? failure?.code).toBe("57014");
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_800);
      expect(performance.now() - started).toBeLessThan(5_000);
      // maxConnections=1 means this cannot pass if the cancelled transaction keeps its connection.
      expect(await probeDb.execute(sql`show statement_timeout`)).toMatchObject([{ statement_timeout: "0" }]);
      expect(await probeDb.execute(sql`select 1 as value`)).toMatchObject([{ value: 1 }]);
    } finally {
      await lock.unsafe("rollback"); lock.release(); await probeDb.$client.end();
    }
  });

});
