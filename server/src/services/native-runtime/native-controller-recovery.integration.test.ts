import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentTaskSessions, agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery, importNativeControllerRecovery, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { readNativeControllerRecoveryInventory } from "./native-controller-recovery-inventory.js";

describe.skipIf(!recoveryPostgresSupport.supported)("native controller durable discovery and import", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID(), agentId = randomUUID();
  const compatibility = { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null };
  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    root = await mkdtemp(join(tmpdir(), "native-controller-discovery-"));
    database = await startRecoveryPostgres("native-controller-discovery-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Controller discovery", issuePrefix: "NCD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    home?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });

  async function seed() {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue retained execution", assigneeAgentId: agentId, status: "in_progress" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Continue retained execution", description: null, reviewPolicy: null }, environmentLeaseId: randomUUID() });
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: owner.bootId,
      controllerGeneration: 1, leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, runId),
      identity: { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "discovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
    await core.flushCheckpoint();
    await core.stop();
    const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId: native.normalizedSessionId,
      identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
    const profile = { ...prepared.runnerProfileJson, sessionCheckpoint: snapshot };
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: profile }).where(eq(heartbeatRuns.id, runId));
    const scope = { companyId, agentId, issueId, runId, normalizedSessionId: native.normalizedSessionId };
    return { scope, native, profile, snapshot, owner,
      supervisor: { schema: "paperclip.native-session-supervisor.v1", ...compatibility, snapshot } };
  }

  it("imports a retained source once, rejects stale input, and resolves it without any local projection", async () => {
    const fixture = await seed();
    const input = { ...fixture.scope, expectedConfigDigest: compatibility.configDigest, supervisor: fixture.supervisor };
    expect(await importNativeControllerRecovery(db, { ...input, supervisor: { ...input.supervisor, snapshot: { ...fixture.snapshot, providerSessionId: "stale" } } }))
      .toEqual({ kind: "missing_evidence", reason: "stale_supervisor_snapshot" });
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "imported" });
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "unchanged" });
    await rm(join(root, fixture.scope.runId), { recursive: true });
    const currentRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: currentRunId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native" });
    const recovered = await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId });
    expect(recovered.kind).toBe("recoverable");
    if (recovered.kind !== "recoverable") throw new Error(JSON.stringify(recovered));
    expect(recovered.snapshot).toEqual(fixture.snapshot);
    expect(recovered.checkpoint.recoveryEvidence.runnerInstanceId).toBe(fixture.native.runnerInstanceId);
    const deadline = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ leaseOwner: "other-controller", leaseExpiresAt: deadline }).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "waiting_for_owner", deadline });
    expect(await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId })).toEqual({ kind: "waiting_for_owner", deadline });
  });

  it("holds mismatched snapshots and runner bindings instead of falling back to fresh execution", async () => {
    const fixture = await seed(), currentRunId = randomUUID();
    const metadata = createNativeControllerRecovery(fixture.snapshot, compatibility, { runId: fixture.scope.runId,
      runnerInstanceId: fixture.native.runnerInstanceId, normalizedSessionId: fixture.scope.normalizedSessionId });
    await db.insert(heartbeatRuns).values({ id: currentRunId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native" });
    for (const envelope of [{ ...metadata, snapshotSha256: "wrong" }, { ...metadata, checkpoint: { ...metadata.checkpoint!, runnerInstanceId: randomUUID() } }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.profile, nativeControllerRecovery: envelope } }).where(eq(heartbeatRuns.id, fixture.scope.runId));
      expect(await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId }))
        .toMatchObject({ kind: "missing_evidence", reason: "snapshot_digest_or_checkpoint_binding" });
    }
  });

  it("reports bounded retained-pointer coverage without loading historical payloads", async () => {
    const fixture = await seed();
    await importNativeControllerRecovery(db, { ...fixture.scope, expectedConfigDigest: compatibility.configDigest, supervisor: fixture.supervisor });
    await db.insert(agentTaskSessions).values([0, 1].map(index => ({ companyId, agentId, taskKey: `${fixture.scope.issueId}-${index}`,
      adapterType: "paperclip_runner", lastRunId: fixture.scope.runId })));
    const first = await readNativeControllerRecoveryInventory(db, { limit: 1 });
    expect(first).toMatchObject({ inspected: 1, coverage: "partial", truncated: true, selectedRetainedEvidence: 1, fullPayloadsValidated: false });
    const next = await readNativeControllerRecoveryInventory(db, { limit: 1, afterId: first.nextAfterId! });
    expect(next).toMatchObject({ inspected: 1, coverage: "partial", truncated: false, selectedRetainedEvidence: 1 });
  });
});
