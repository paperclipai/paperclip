import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues, environmentLeases, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
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
    expect(report({ rows: rows.map(row => ({ ...row, recoverable: false, retainedUnowned: true })),
      before: idle, after: idle, activeRunIds: [] })).toMatchObject({ ready: false, truncated: true, activeRuns: 0 });
  });
  it("keeps current execution and admission barriers with retained recovery work", () => {
    const rows = [{ id: "retained", recoverable: false, retainedUnowned: true }, { id: "remote", recoverable: true }];
    expect(report({ rows })).toMatchObject({ ready: true, activeRuns: 1, recoverableRuns: 1, retainedBlockedRuns: 1 });
    expect(report({ rows, activeRunIds: ["remote", "retained"], after: { ...idle, activeRuns: 2 } }))
      .toMatchObject({ ready: false, activeRuns: 2, blockingRuns: 1, retainedBlockedRuns: 0 });
    for (const before of [{ ...idle, activeRuns: 2 }, { ...idle, pendingWakes: 1 }, { ...idle, draining: true }]) {
      expect(report({ rows, before }).ready).toBe(false);
    }
  });
  describe("handoff verdict", () => {
    const busy = (rows: Parameters<typeof summarizeUpgradeReadiness>[0]["rows"], pendingWakes = 0, unsavedWakes = 0) => report({ rows,
      activeRunIds: rows.map(row => row.id), before: { ...idle, activeRuns: rows.length, pendingWakes, unsavedWakes },
      after: { ...idle, activeRuns: rows.length, pendingWakes, unsavedWakes } });
    it("agrees with the version 1 verdict when every execution is recoverable", () => {
      expect(busy([{ id: "a", recoverable: true }, { id: "b", recoverable: true }])).toMatchObject({ version: 1, ready: true,
        blockingRuns: 0, handoff: { version: 1, ready: true, recoverableRuns: 2, restartableRuns: 0, blockingRuns: 0, pendingWakes: 0, unsavedWakes: 0 } });
    });
    it("is ready with unlaunched runs and saved pending wakes, and leaves the version 1 fields unchanged", () => {
      const rows = [{ id: "live", recoverable: true }, { id: "preparing", recoverable: false, restartable: true },
        { id: "launching", recoverable: false, restartable: true }];
      expect(busy(rows, 2)).toMatchObject({ version: 1, ready: false, activeRuns: 3, recoverableRuns: 1, blockingRuns: 2,
        pendingWakes: 2, handoff: { version: 1, ready: true, recoverableRuns: 1, restartableRuns: 2, blockingRuns: 0, pendingWakes: 2, unsavedWakes: 0 } });
    });
    it("is not ready while a pending wake has not saved its wake and run", () => {
      const rows = [{ id: "live", recoverable: true }];
      expect(busy(rows, 2, 1).handoff).toMatchObject({ ready: false, blockingRuns: 0, pendingWakes: 2, unsavedWakes: 1 });
      // Seen in either read of the counters.
      expect(report({ rows, activeRunIds: ["live"], before: { ...idle, activeRuns: 1, pendingWakes: 1, unsavedWakes: 1 },
        after: { ...idle, activeRuns: 1 } }).handoff).toMatchObject({ ready: false, unsavedWakes: 1 });
    });
    it("treats every pending wake as unsaved without a valid saved count", () => {
      const rows = [{ id: "live", recoverable: true }];
      for (const unsavedWakes of [undefined, -1, 3, 0.5, Number.NaN]) {
        expect(report({ rows, activeRunIds: ["live"], before: { ...idle, activeRuns: 1, pendingWakes: 2, unsavedWakes },
          after: { ...idle, activeRuns: 1 } }).handoff, String(unsavedWakes)).toMatchObject({ ready: false, pendingWakes: 2, unsavedWakes: 2 });
      }
    });
    it("is not ready while a started execution has no recovery evidence", () => {
      const rows = [{ id: "live", recoverable: true }, { id: "preparing", recoverable: false, restartable: true },
        { id: "legacy-child", recoverable: false }];
      expect(busy(rows)).toMatchObject({ ready: false, blockingRuns: 2,
        handoff: { ready: false, recoverableRuns: 1, restartableRuns: 1, blockingRuns: 1 } });
    });
    it("counts an execution this report could not observe as a blocker", () => {
      const rows = [{ id: "preparing", recoverable: false, restartable: true }];
      expect(report({ rows, activeRunIds: ["preparing", "unseen"], after: { ...idle, activeRuns: 2 } }).handoff)
        .toMatchObject({ ready: false, restartableRuns: 1, blockingRuns: 1 });
      expect(report({ rows, activeRunIds: ["preparing"], after: { ...idle, activeRuns: 2 } }).handoff)
        .toMatchObject({ ready: false, restartableRuns: 1, blockingRuns: 1 });
    });
    it("never counts one execution in two classes", () => {
      expect(busy([{ id: "a", recoverable: true, restartable: true }]).handoff)
        .toMatchObject({ ready: true, recoverableRuns: 1, restartableRuns: 0, blockingRuns: 0 });
    });
    it("stays not ready while draining or truncated", () => {
      const rows = [{ id: "preparing", recoverable: false, restartable: true }];
      expect(report({ rows, activeRunIds: ["preparing"], before: { ...idle, activeRuns: 1, draining: true } }).handoff)
        .toMatchObject({ ready: false, blockingRuns: 0 });
      const many = Array.from({ length: 1_001 }, (_, i) => ({ id: String(i), recoverable: false, restartable: true }));
      expect(report({ rows: many, activeRunIds: many.map(row => row.id), before: { ...idle, activeRuns: many.length },
        after: { ...idle, activeRuns: many.length } })).toMatchObject({ truncated: true, handoff: { ready: false } });
    });
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
  it("keeps an old unowned preparation visible without making it a live upgrade blocker", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const owner = await currentNativeControllerIdentity();
    await db.insert(companies).values({ id: companyId, name: "Retained preparation", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retained preparation", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Interrupted preparation", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native", nativePhase: "observed", runnerInstanceId: randomUUID(), nativeSessionId: randomUUID() });
    const retained = { controllerBootId: "previous-controller", leaseOwner: "previous-controller-lease", controllerGeneration: 1,
      leaseExpiresAt: new Date(0), recoveryState: "awaiting_evidence", phase: "observed", failureCode: null };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, ...retained });
    const input = { activeRunIds: new Set<string>(), counters: () => idle };
    try {
      const savedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const savedOwner = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: true, activeRuns: 0,
        recoverableRuns: 0, blockingRuns: 0, retainedBlockedRuns: 1,
        nativeControllerRecovery: { activeExecutionAdoption: { retainedBlockedRuns: 1 } } });
      const [{ default: express }, { default: request }, { instanceSettingsRoutes }, { errorHandler }] = await Promise.all([
        import("express"), import("supertest"), import("../../routes/instance-settings.js"), import("../../middleware/error-handler.js"),
      ]);
      const app = express();
      let isInstanceAdmin = false;
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "readiness-test", source: "session", isInstanceAdmin };
        next();
      });
      app.use("/api", instanceSettingsRoutes(db));
      app.use(errorHandler);
      await request(app).get("/api/instance/task-drain?upgradeReadiness=1").expect(403);
      isInstanceAdmin = true;
      const response = await request(app).get("/api/instance/task-drain?upgradeReadiness=1").expect(200);
      expect(response.body.upgradeReadiness).toMatchObject({ ready: true, activeRuns: 0, blockingRuns: 0, retainedBlockedRuns: 1 });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toEqual(savedRun);
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).toEqual(savedOwner);
      expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
        .toEqual([{ status: "running" }]);
      expect(await db.select({ state: nativeRunFinalizations.recoveryState }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runId))).toEqual([{ state: "awaiting_evidence" }]);
      for (const patch of [
        { controllerBootId: owner.bootId }, { controllerBootId: null }, { controllerBootId: "" },
        { leaseExpiresAt: new Date(Date.now() + 60_000) }, { leaseExpiresAt: null },
        { leaseOwner: null }, { controllerGeneration: 0 }, { failureCode: "uncertain" },
        { recoveryState: null }, { phase: "workspace_finalizing" },
      ]) {
        await db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, runId));
        expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: false, blockingRuns: 1, retainedBlockedRuns: 0 });
        await db.update(nativeRunFinalizations).set(retained).where(eq(nativeRunFinalizations.runId, runId));
      }
      for (const patch of [{ runtimeMode: "legacy" }, { nativePhase: "running" }, { processPid: process.pid }, { processStartedAt: new Date() }]) {
        await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, runId));
        expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: false, blockingRuns: 1, retainedBlockedRuns: 0 });
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativePhase: "observed", processPid: null, processStartedAt: null })
          .where(eq(heartbeatRuns.id, runId));
      }
      await db.insert(nativeRunnerCheckpoints).values({ runId, companyId, issueId, part: "header", material: {} });
      expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: false, blockingRuns: 1, retainedBlockedRuns: 0 });
      await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
      await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
      expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: false, blockingRuns: 1, retainedBlockedRuns: 0 });
      await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
      input.activeRunIds.add(runId);
      expect(await readUpgradeReadiness(db, { ...input, counters: () => ({ ...idle, activeRuns: 1 }) }))
        .toMatchObject({ ready: false, activeRuns: 1, blockingRuns: 1, retainedBlockedRuns: 0 });
      input.activeRunIds.clear();
      let reads = 0;
      expect(await readUpgradeReadiness(db, { ...input, counters: () => {
        if (reads++ > 0) input.activeRunIds.add(runId);
        return { ...idle, activeRuns: input.activeRunIds.size };
      } })).toMatchObject({ ready: false, blockingRuns: 1, retainedBlockedRuns: 0 });
    } finally {
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    }
  });
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
    const parsedHeader = JSON.parse(header);
    const representativeHeader = JSON.stringify({ ...parsedHeader, state: { ...parsedHeader.state,
      runAttachTemplate: { provider: { instructions: "x".repeat(300_000) } } } });
    await db.update(nativeRunnerCheckpoints).set({ material: cipher.encrypt(JSON.stringify({ ...binding, part: "header", contents: representativeHeader })) })
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    for (const contents of ["{", "{}", JSON.stringify({ ...JSON.parse(header), schema: "paperclip.runner.controller-checkpoint.v1" }),
      JSON.stringify({ ...JSON.parse(header), padding: "x".repeat(1_100_000) }),
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
    // Remote-authoritative runs retain their logical workspace identity without a host sync record.
    const remoteWorkspace = { schema: "paperclip.remote-workspace-run.v1", workspaceId: workspace.workspaceId,
      leaseId: workspace.leaseId, providerLeaseId: workspace.providerLeaseId, remoteCwd: workspace.remoteCwd,
      epoch: 1, state: "prepared", snapshotId: null };
    const remoteProfile = { remoteWorkspace };
    await db.update(heartbeatRuns).set({ runnerProfileJson: remoteProfile }).where(eq(heartbeatRuns.id, runId));
    expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: true, recoverableRuns: 1, blockingRuns: 0 });
    for (const remote of [{ ...remoteWorkspace, state: "saved", snapshotId: randomUUID() },
      remoteWorkspace]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: remote,
        nativeWorkspaceSync: { ...workspace, workspaceId: randomUUID() } } }).where(eq(heartbeatRuns.id, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(true); // remote identity takes precedence
    }
    for (const remote of [null, {}, { ...remoteWorkspace, schema: "unknown" }, { ...remoteWorkspace, epoch: 0 },
      { ...remoteWorkspace, workspaceId: randomUUID() }, { ...remoteWorkspace, leaseId: "invalid" },
      { ...remoteWorkspace, remoteCwd: "" }, { ...remoteWorkspace, snapshotId: "invalid" }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: workspace,
        remoteWorkspace: remote } }).where(eq(heartbeatRuns.id, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false); // no fallback to the legacy identity
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: execution.runnerProfileJson }).where(eq(heartbeatRuns.id, runId));
    // Plugin task admission owns an environment lease identity and deliberately has no workspace-sync record.
    const pluginLeaseId = randomUUID();
    await db.insert(environmentLeases).values({ id: pluginLeaseId, companyId, heartbeatRunId: runId, issueId,
      provider: "plugin", providerLeaseId: "synthetic-task", metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: true } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: remoteProfile }).where(eq(heartbeatRuns.id, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false); // contradictory task authorities cannot be adopted
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
  it("classifies a run with no launched agent work as restartable, and any started work as a blocker", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const owner = await currentNativeControllerIdentity();
    await db.insert(companies).values({ id: companyId, name: "Restartable", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Restartable", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preparing", status: "in_progress", assigneeAgentId: agentId });
    const unlaunched = { runtimeMode: "native", nativePhase: "observed", processPid: null, processGroupId: null,
      processStartedAt: null, sessionIdBefore: null, sessionIdAfter: null, executionStage: null, controllerBootId: null,
      runnerProfileJson: { nativePreparationFencingVersion: 1 } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "running",
      runnerInstanceId: randomUUID(), nativeSessionId: randomUUID(), ...unlaunched });
    const claimed = { controllerBootId: owner.bootId, leaseOwner: "controller-lease", controllerGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000), phase: "observed", failureCode: null };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, ...claimed });
    const input = { activeRunIds: new Set([runId]), counters: () => ({ ...idle, activeRuns: 1, pendingWakes: 1, unsavedWakes: 0 }) };
    const restartable = { ready: false, activeRuns: 1, recoverableRuns: 0, blockingRuns: 1, pendingWakes: 1,
      handoff: { version: 1, ready: true, recoverableRuns: 0, restartableRuns: 1, blockingRuns: 0, pendingWakes: 1 } };
    const blocking = { ready: false, blockingRuns: 1, handoff: { ready: false, restartableRuns: 0, blockingRuns: 1 } };
    try {
      expect(await readUpgradeReadiness(db, input)).toMatchObject(restartable);
      for (const patch of [{ processPid: process.pid }, { processGroupId: process.pid }, { processStartedAt: new Date() },
        { sessionIdBefore: "provider-session" }, { sessionIdAfter: "provider-session" }, { nativePhase: "result_accepted" },
        { runnerProfileJson: {} }, { runtimeMode: "legacy" }]) {
        await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, runId));
        expect(await readUpgradeReadiness(db, input), JSON.stringify(patch)).toMatchObject(blocking);
        await db.update(heartbeatRuns).set(unlaunched).where(eq(heartbeatRuns.id, runId));
      }
      for (const patch of [{ failureCode: "uncertain" }, { phase: "workspace_finalizing" }]) {
        await db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, runId));
        expect(await readUpgradeReadiness(db, input), JSON.stringify(patch)).toMatchObject(blocking);
        await db.update(nativeRunFinalizations).set(claimed).where(eq(nativeRunFinalizations.runId, runId));
      }
      await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
      expect(await readUpgradeReadiness(db, input)).toMatchObject(blocking);
      await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
      await db.insert(nativeRunnerCheckpoints).values({ runId, companyId, issueId, part: "header", material: {} });
      expect(await readUpgradeReadiness(db, input)).toMatchObject(blocking);
      await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
      // The executor records this request before any backend may start a runner.
      for (const event of [{ eventType: "native.process_start_requested" }, { eventType: "adapter.invoke" },
        { eventType: "lifecycle", sourceEventId: "runner-event-1" }]) {
        const [{ id }] = await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, ...event })
          .returning({ id: heartbeatRunEvents.id });
        expect(await readUpgradeReadiness(db, input), event.eventType).toMatchObject(blocking);
        await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, id));
      }
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "lifecycle" });
      expect(await readUpgradeReadiness(db, input)).toMatchObject(restartable);
      // A direct-adapter preparation that has not reached dispatch is requeued by process-loss recovery.
      const legacyPreparing = { runtimeMode: "legacy", nativePhase: null, executionStage: "preparing", controllerBootId: randomUUID() };
      await db.update(heartbeatRuns).set(legacyPreparing).where(eq(heartbeatRuns.id, runId));
      expect(await readUpgradeReadiness(db, input)).toMatchObject(restartable);
      for (const patch of [{ executionStage: "dispatching" }, { controllerBootId: null }, { processPid: process.pid }]) {
        await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, runId));
        expect(await readUpgradeReadiness(db, input), JSON.stringify(patch)).toMatchObject(blocking);
        await db.update(heartbeatRuns).set({ ...legacyPreparing, processPid: null }).where(eq(heartbeatRuns.id, runId));
      }
    } finally {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    }
  });
  it("blocks the handoff while a wake admission waits on the agent lock with nothing saved", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Unsaved wake", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Unsaved wake", role: "engineer", adapterType: "process",
      status: "idle", adapterConfig: { command: "true" } });
    const { heartbeatService } = await import("../heartbeat.js");
    const heartbeat = heartbeatService(db);
    const saved = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    const lock = await db.$client.reserve();
    let wake: Promise<unknown> | undefined;
    try {
      await lock.unsafe("begin");
      await lock.unsafe(`select id from agents where id = '${agentId}' for update`);
      wake = heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
        requestedByActorType: "user", requestedByActorId: "readiness-user" });
      await vi.waitFor(async () => {
        const locks = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%from agents where id =%for update%'`);
        expect(locks.length).toBeGreaterThan(0);
      }, { timeout: 20_000, interval: 100 });
      expect(await saved()).toEqual([]);
      expect((await heartbeat.readUpgradeReadiness()).handoff).toMatchObject({ ready: false, pendingWakes: 1, unsavedWakes: 1 });
    } finally {
      await lock.unsafe("rollback"); lock.release();
      await wake;
      await heartbeat.drainActiveRunExecutions();
    }
    expect(await saved()).toHaveLength(1);
    expect((await heartbeat.readUpgradeReadiness()).handoff).toMatchObject({ pendingWakes: 0, unsavedWakes: 0 });
  }, 60_000);
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
