import { startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal } from "./native-execution-lease.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { remotePreparedWorkspace, nativeRestartFixture, describeEmbeddedPostgres } from "./native-restart.test-fixture.js";

describeEmbeddedPostgres("native runner restart recovery: preparation", () => {
  const environment = nativeRestartFixture();
  const { seedRun, transportOptions } = environment;
  let runtimeRoot: typeof environment.current.runtimeRoot;
  let companyId: typeof environment.current.companyId;
  let agentId: typeof environment.current.agentId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ runtimeRoot, companyId, agentId, successor } = environment.current); });

  it.each(["preparation", "claim lock"])("gives a fresh remote claim its full lease through blocked %s", async (blockedPhase) => {
    const fixture = await seedRun(`FRESH-SLOW-${blockedPhase === "claim lock" ? "CLAIM-LOCK" : "PREPARATION"}`);
    const environmentId = randomUUID(), leaseId = randomUUID();
    await fixture.db.insert(environments).values({ id: environmentId, name: `Fresh preparation fixture ${environmentId}`, driver: "sandbox" });
    await fixture.db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId,
      heartbeatRunId: fixture.runId, issueId: fixture.issueId, status: "active",
      provider: "fixture", providerLeaseId: `fresh-preparation-${leaseId}` });
    const execution = buildNativeExecutionInput({ companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: "NRR-FRESH-SLOW", title: "Prepare slowly", description: null, workMode: "standard" },
      taskPrompt: "Prepare a fresh execution.", provider: "codex",
      workspace: { id: fixture.runId, cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Prepare once", criteria: [{ id: "objective", requirement: "Retain ownership" }] } },
    });
    // Stop at the provider boundary after checking ownership; no harness is launched.
    const failure = new Error("end fresh preparation experiment");
    const backend = { descriptor: async () => { throw failure; }, openSession: async () => { throw failure; } };
    let reached!: () => void, release!: () => void;
    const claimed = new Promise<void>(resolveReady => { reached = resolveReady; });
    const preparation = new Promise<void>(resolveReady => { release = resolveReady; });
    let releaseLock: (() => void) | undefined;
    let holder: Promise<void> | undefined;
    let lockPid: number | undefined;
    let leaseStartsAfter: Date | undefined;
    if (blockedPhase === "claim lock") {
      let locked!: () => void;
      const lockTaken = new Promise<void>(resolve => { locked = resolve; });
      const lockReleased = new Promise<void>(resolve => { releaseLock = resolve; });
      holder = fixture.db.transaction(async tx => {
        const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`);
        lockPid = Number(connection.pid);
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).for("update");
        locked(); await lockReleased;
      });
      await lockTaken;
    }
    const running = executePaperclipNativeSession({ db: fixture.db, execution,
      runnerInstanceId: fixture.native.runnerInstanceId, backend,
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId, leaseId, remoteCwd: runtimeRoot },
      onEvent: async event => {
        if (event.payload?.span === "native.coordinator.claim") { reached(); await preparation; }
      },
    }).catch(error => error);
    try {
      if (blockedPhase === "claim lock") {
        // Observe the real claim waiting on the run row after it has locked its
        // coordinator. The lease must start after this wait, not before it.
        await expect.poll(async () => {
          const [waiting] = await fixture.db.execute(sql`select exists (
            select 1 from pg_stat_activity where ${lockPid} = any(pg_blocking_pids(pid))
              and query like 'select %from "heartbeat_runs"%for update%'
          ) as blocked`);
          return waiting.blocked;
        }, { timeout: 10_000 }).toBe(true);
        await fixture.db.execute(sql`select pg_sleep(1)`);
        const [observed] = await fixture.db.execute(sql`select clock_timestamp() as observed_at`);
        leaseStartsAfter = new Date(String(observed.observed_at));
        releaseLock!(); await holder;
      }
      await Promise.race([claimed, running.then(error => { throw error; })]);
      const [initial] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (leaseStartsAfter) {
        expect(initial.leaseExpiresAt!.getTime() - leaseStartsAfter.getTime()).toBeGreaterThan(59_900);
        release();
        expect(await running).toBe(failure);
        return;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, initial.leaseExpiresAt!.getTime() - Date.now() + 2_000)));
      const [current] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(current.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(current.leaseOwner).toBe(initial.leaseOwner);
      expect(current.controllerGeneration).toBe(initial.controllerGeneration);
      expect(current.attempt).toBe(1);
      release();
      expect(await running).toBe(failure);
    } finally { releaseLock?.(); await holder; release(); await running; }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("renews a remote claim through slow preparation and shares renewal with execution", async () => {
    const fixture = await seedRun("SLOW-RECOVERY-PREPARATION");
    const root = resolve(runtimeRoot, fixture.runId);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace(),
      sessionCheckpoint: { identity: { ...binding, agentId, sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "surviving-provider" },
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: 1, leaseOwner: "previous-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: transportOptions(fixture, root).prpIdentity,
      expectedRunnerVersion: "lease-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
    await authority.stop();
    // Establish the abandoned predecessor before the fault; claimed leases are
    // never edited below. The successor must retain ownership for a real minute.
    await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const controller = { ...successor, bootId: randomUUID() };
    const onLost = vi.fn(async () => undefined);
    let preparation: NativeExecutionLeaseRenewal | undefined;
    let execution: NativeExecutionLeaseRenewal | undefined;
    let acquired = false;
    try {
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller,
        restartKind: "hard", runIds: [fixture.runId], onClaim: (claim, scope) => {
          expect(scope.remote).toBe(true);
          preparation = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...scope,
            runId: claim.runId, leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, onLost });
          acquired = true;
        } });
      expect(acquired).toBe(true);
      expect(claim.kind).toBe("reattach_remote_runner");
      if (!("leaseOwner" in claim)) throw new Error("Expected recovery claim");
      const [initial] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      await new Promise(resolveWait => setTimeout(resolveWait, 30_000));
      execution = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...binding,
        leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, controller, remote: true, onLost });
      await preparation!.stop();
      await preparation!.stop(); // A caller cannot release another caller's reference.
      const remaining = Math.max(0, initial.leaseExpiresAt!.getTime() - Date.now() + 2_000);
      await new Promise(resolveWait => setTimeout(resolveWait, remaining));
      const [current] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(current.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(current.controllerGeneration).toBe(claim.controllerGeneration);
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: { ...controller, bootId: randomUUID() },
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([
        expect.objectContaining({ kind: "awaiting_evidence", runId: fixture.runId }),
      ]);
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      await preparation?.stop();
      await execution?.stop();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

});
