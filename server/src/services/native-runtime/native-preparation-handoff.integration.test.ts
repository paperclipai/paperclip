import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import { DurablePrpControlPlane, inspectDurablePrpCheckpointHeader } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { currentControllerProcess } from "../controller-process-identity.js";
import { nativeRunnerCheckpointRegistration, loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { readNativePreparationHandoffReadiness } from "./native-preparation-handoff.js";
import { recordNativeRunnerLaunchIntent } from "./native-runner-launch-intent.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";

describeEmbeddedPostgres("durable native preparation handoff", () => {
  const environment = nativeRestartFixture();
  let shared: typeof environment.current;
  beforeAll(() => { shared = environment.current; });

  async function seed(label: string) {
    const fixture = await environment.seedRun(`PREPARATION-${label}`);
    const leaseId = randomUUID(), bootId = randomUUID(), leaseOwner = `${bootId}:preparing`;
    const host = await currentControllerProcess();
    const scope = { companyId: shared.companyId, issueId: fixture.issueId, runId: fixture.runId, controllerBootId: bootId };
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.preparedProfile,
      nativePreparationHandoffVersion: 1, nativePreparationFencingVersion: 1 }, nativePhase: "observed" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 1, controllerBootId: bootId,
      controllerGeneration: 1, controllerPid: 2_000_000_001, controllerHostHash: host.hostHash,
      controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.insert(environmentLeases).values({ id: leaseId, companyId: shared.companyId,
      issueId: fixture.issueId, heartbeatRunId: fixture.runId, provider: "fixture", providerLeaseId: `task-${leaseId}`,
      leasePolicy: "retain_on_failure", metadata: { agentId: shared.agentId, runnerTaskLease: true } });
    const identity = { runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: leaseId,
      runId: fixture.runId, normalizedSessionId: fixture.native.normalizedSessionId, turnId: `turn-${fixture.runId}`, itemId: `item-${fixture.runId}` };
    const core = new DurablePrpControlPlane({ stateDirectory: join(shared.runtimeRoot, label), identity,
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    return { ...fixture, scope, leaseId, leaseOwner, identity, core,
      register: () => nativeRunnerCheckpointRegistration({ db: fixture.db,
        binding: { companyId: shared.companyId, issueId: fixture.issueId, runId: fixture.runId }, bootId })(core) };
  }

  it("publishes early preparation atomically and revokes the proof when work starts", async () => {
    const f = await seed("EARLY");
    try {
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "preparing" });
      await f.register();
      const checkpoint = await loadNativeRunnerCheckpoint(f.db, f.scope);
      expect(JSON.parse(checkpoint!.records.get("header")!).schema).toBe("paperclip.runner.controller-checkpoint.v3");
      expect(inspectDurablePrpCheckpointHeader(checkpoint!.records.get("header")!)).toEqual(f.identity);
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "preparing", environmentLeaseId: f.leaseId });
      f.core.queueCommand("turn.start", { input: [] });
      await f.core.flushCheckpoint();
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
    } finally { await f.core.stop(); }
  });

  it("claims exact pre-session launch authority for adoption without a provider session snapshot", async () => {
    const f = await seed("LAUNCH");
    try {
      await f.register();
      f.core.persistPreparedLaunchConfiguration(f.identity, "prepared-configuration");
      const template = { provider: { kind: "codex", cwd: "/workspace" }, authorizedTools: {} };
      f.core.persistRunAttachTemplate(template);
      f.core.queueCommand("run.prepare", template);
      f.core.queueCommand("session.open", { reuse: "same_session" });
      const ticket = f.core.issueBootstrapTicket(60_000);
      await f.core.flushCheckpoint();
      await recordNativeRunnerLaunchIntent(f.db, { ...f.scope, bootId: f.scope.controllerBootId,
        environmentLeaseId: f.leaseId, taskId: `task-${f.leaseId}`, operation: {
          kind: "submit", preparedLaunchId: "prepared-configuration", projectIds: [], bootstrapTicket: ticket,
          runner: { protocolMin: 3, protocolMax: 3, harness: "codex", runnerId: f.identity.runnerInstanceId,
            leaseId: f.leaseId, runId: f.runId, sessionId: f.identity.normalizedSessionId,
            turnId: f.identity.turnId, itemId: f.identity.itemId },
          launch: { runnerVersion: "0.3.0", runnerDigest: `sha256:${"a".repeat(64)}`,
            maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        } });
      await f.db.update(environmentLeases).set({ metadata: { agentId: shared.agentId, runnerTaskLease: true, runnerTaskDispatched: true } })
        .where(eq(environmentLeases.id, f.leaseId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "launching" });
      await f.core.stop();
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      const claims = await claimNativeRestartRecoveries({ db: f.db, controller: shared.successor, restartKind: "hard", runIds: [f.runId] });
      expect(claims).toEqual([expect.objectContaining({ kind: "reattach_remote_runner", runId: f.runId, controllerGeneration: 2 })]);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerInstanceId).toBe(f.identity.runnerInstanceId);
    } finally { await f.core.stop(); }
  });

  it.each(["old-run", "expired-owner", "wrong-agent", "multiple-leases", "malformed-remote", "missing-cursor"])(
    "refuses contradictory %s preparation evidence", async kind => {
      const f = await seed(kind);
      try {
        await f.register();
        if (kind === "old-run") await f.db.update(heartbeatRuns).set({ runnerProfileJson: f.preparedProfile }).where(eq(heartbeatRuns.id, f.runId));
        if (kind === "expired-owner") await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
        if (kind === "wrong-agent") await f.db.update(environmentLeases).set({ metadata: { agentId: randomUUID(), runnerTaskLease: true } }).where(eq(environmentLeases.id, f.leaseId));
        if (kind === "multiple-leases") await f.db.insert(environmentLeases).values({ id: randomUUID(), companyId: shared.companyId,
          issueId: f.issueId, heartbeatRunId: f.runId, provider: "fixture", providerLeaseId: "foreign-task", leasePolicy: "retain_on_failure",
          metadata: { agentId: shared.agentId, runnerTaskLease: true } });
        if (kind === "malformed-remote") await f.db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} || '{"remoteWorkspace":{}}'::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
        if (kind === "missing-cursor") await f.db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, f.runId), eq(nativeRunnerCheckpoints.part, "cursor")));
        expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      } finally { await f.core.stop(); }
    });
});
