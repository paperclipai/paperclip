import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { agentTaskSessions, environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { DurablePrpControlPlane, inspectDurablePrpCheckpointHeader, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { currentControllerProcess } from "../controller-process-identity.js";
import { nativeRunnerCheckpointRegistration, loadNativeRunnerCheckpoint, readNativeGenericWarmPublication } from "./native-runner-checkpoint.js";
import { readNativePreparationHandoffReadiness } from "./native-preparation-handoff.js";
import { recordNativeRunnerLaunchIntent } from "./native-runner-launch-intent.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { restoreNativeWarmPreparationClaim } from "./native-warm-preparation-recovery.js";
import { nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { hasLocalNativeControllerObligations } from "./native-controller-migration.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";

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

  it("keeps an accepted warm predecessor resumable before a new control plane and rejects changed source authority", async () => {
    const f = await seed("WARM-SOURCE"), sourceId = randomUUID(), resultId = randomUUID();
    const [current] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1",
      provider: { kind: "codex", model: null }, binding: { companyId: shared.companyId, agentId: shared.agentId,
        issueId: f.issueId, runId: f.runId, executionWorkspaceId: f.leaseId },
      task: { identifier: "PREPARATION-WARM", title: "Continue retained work", description: null, prompt: "Continue.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 } },
      completionContract: { id: current.completionContractId!, sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Save work." }] } },
      credentialBindings: [], interactionResponses: [] });
    const sourceExecution = parseNativeExecutionInput({ ...execution, binding: { ...execution.binding, runId: sourceId } });
    const fingerprint = nativeToolContractFingerprintForTarget("remote", execution.provider.kind);
    const sourceIdentity = { ...f.identity, runId: sourceId, turnId: `turn-${sourceId}`, itemId: `item-${sourceId}` };
    const sourceCore = new DurablePrpControlPlane({ stateDirectory: join(shared.runtimeRoot, `accepted-predecessor-${sourceId}`), identity: sourceIdentity,
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const snapshot = { sessionId: randomUUID(), providerSessionId: randomUUID(),
      identity: { ...execution.binding, runId: sourceId, sessionId: execution.session.normalizedSessionId } };
    const [source] = await f.db.insert(heartbeatRuns).values({ id: sourceId, companyId: shared.companyId, agentId: shared.agentId,
      nativeIssueId: f.issueId, nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId,
      runtimeMode: "native", status: "succeeded", invocationSource: "assignment", triggerDetail: "system",
      createdAt: new Date(current.createdAt.getTime() - 10000), startedAt: new Date(current.createdAt.getTime() - 9000),
      finishedAt: new Date(current.createdAt.getTime() - 1000), completionContractId: current.completionContractId,
      runnerProfileJson: { nativeExecutionInput: sourceExecution, nativeToolContractFingerprint: fingerprint, sessionCheckpoint: snapshot } }).returning();
    await f.db.insert(nativeRunFinalizations).values({ runId: sourceId, companyId: shared.companyId, issueId: f.issueId,
      phase: "observed", controllerBootId: f.scope.controllerBootId, controllerGeneration: 1,
      leaseOwner: `${f.scope.controllerBootId}:source`, leaseExpiresAt: new Date(Date.now() + 60000) });
    const paths = nativeControllerMigrationDescriptor(execution, fingerprint);
    let selectionId: string | undefined, publishedCore: DurablePrpControlPlane | undefined;
    try {
      await nativeRunnerCheckpointRegistration({ db: f.db, binding: { companyId: shared.companyId, issueId: f.issueId, runId: sourceId },
        bootId: f.scope.controllerBootId })(sourceCore);
      await sourceCore.stop();
      await f.db.insert(nativeRunResults).values({ id: resultId, companyId: shared.companyId, issueId: f.issueId,
        runId: sourceId, completionContractId: current.completionContractId!, serverFingerprint: "accepted-warm-source",
        schemaStatus: "accepted", resultJson: {}, canonicalSha256: "a".repeat(64) });
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, sourceId));
      const rebound = rebindNativeSessionCheckpoint({ previousRun: source, currentExecution: execution, executionTargetKind: "remote" });
      expect(rebound).not.toBeNull();
      const profile = { ...f.preparedProfile, nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint,
        nativePreparationHandoffVersion: 1, nativePreparationHandoffSourceRunId: sourceId, sessionCheckpoint: rebound };
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "preparing", warmSource: true });
      await f.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, sourceId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, sourceId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "preparing", warmSource: true });
      await mkdir(join(paths.root, "control-plane"), { recursive: true, mode: 0o700 });
      await writeFile(join(paths.root, "control-plane", "control-plane-state.json"), JSON.stringify({
        schema: "paperclip.runner.external-control-plane-state.v1", identity: sourceIdentity }), { mode: 0o600 });
      const [selection] = await f.db.insert(agentTaskSessions).values({ companyId: shared.companyId, agentId: shared.agentId,
        adapterType: "paperclip_runner", taskKey: f.issueId, lastRunId: f.runId }).returning({ id: agentTaskSessions.id });
      selectionId = selection.id;
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(false);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativePreparationHandoffVersion: undefined } })
        .where(eq(heartbeatRuns.id, f.runId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson,
        nativeToolContractFingerprint: "foreign-tool-authority" } }).where(eq(heartbeatRuns.id, sourceId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: source.runnerProfileJson }).where(eq(heartbeatRuns.id, sourceId));
      await f.register();
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toMatchObject({ kind: "preparing", warmSource: true });
      await f.core.stop();
      const durable = await loadNativeRunnerCheckpoint(f.db, f.scope);
      durable!.restoreSessionDirectory(paths.root);
      publishedCore = new DurablePrpControlPlane({ stateDirectory: join(paths.root, "control-plane"), identity: f.identity,
        expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      await nativeRunnerCheckpointRegistration({ db: f.db, binding: f.scope, bootId: f.scope.controllerBootId })(publishedCore);
      const published = await loadNativeRunnerCheckpoint(f.db, f.scope);
      const externalMarkerPath = join(paths.root, "control-plane", "control-plane-state.json");
      const externalMarker = await readFile(externalMarkerPath, "utf8");
      expect(JSON.parse(externalMarker)).toEqual({ schema: "paperclip.runner.external-control-plane-state.v1", identity: f.identity });
      const [liveOwner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "fixture_preparation_failed",
        leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(await readNativePreparationHandoffReadiness(f.db, f.scope)).toBeNull();
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(false);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, nativePreparationHandoffVersion: undefined } })
        .where(eq(heartbeatRuns.id, f.runId));
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId));
      await writeFile(externalMarkerPath, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1",
        identity: { ...f.identity, runId: randomUUID() } }), { mode: 0o600 });
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await writeFile(externalMarkerPath, externalMarker, { mode: 0o600 });
      const [failedCursor] = await f.db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.runId, f.runId),
        eq(nativeRunnerCheckpoints.part, "cursor"))).returning();
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await f.db.insert(nativeRunnerCheckpoints).values(failedCursor!);
      await mkdir(join(paths.supervisorPath, ".."), { recursive: true });
      await writeFile(paths.supervisorPath, "unpublished failed preparation supervisor", { mode: 0o600 });
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await rm(paths.supervisorPath);
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(false);
      expect(await readFile(externalMarkerPath, "utf8")).toBe(externalMarker);
      expect((await loadNativeRunnerCheckpoint(f.db, f.scope))!.records).toEqual(published!.records);
      expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerProfileJson?.sessionCheckpoint)
        .toEqual(profile.sessionCheckpoint);
      await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: liveOwner.phase, failureCode: liveOwner.failureCode,
        leaseOwner: liveOwner.leaseOwner, leaseExpiresAt: liveOwner.leaseExpiresAt }).where(eq(nativeRunFinalizations.runId, f.runId));
      await writeFile(join(paths.root, "control-plane", "control-plane-state.json"), "unpublished local controller bytes", { mode: 0o600 });
      expect(await hasLocalNativeControllerObligations(f.db, null)).toBe(true);
      await f.core.stop();
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const controller = await currentNativeControllerIdentity();
      const [claim] = await claimNativeRestartRecoveries({ db: f.db, controller, restartKind: "hard", runIds: [f.runId] });
      expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: f.runId, controllerGeneration: 2 });
      if (claim?.kind !== "bootstrap_incomplete") throw new Error("Expected the canonical never-launched warm preparation claim");
      expect(await restoreNativeWarmPreparationClaim({ db: f.db, execution,
        root: join(shared.runtimeRoot, "warm-successor"), restartRecovery: claim })).toEqual({ version: "0.3.0", digest: `sha256:${"a".repeat(64)}` });
      expect((await readNativeGenericWarmPublication(f.db, f.scope))?.publication).toMatchObject({
        phase: "preparing", sourceIdentity, targetIdentity: f.identity, bootId: controller.bootId, generation: 2 });
      expect(await readNativePreparationHandoffReadiness(f.db, { ...f.scope, controllerBootId: controller.bootId }))
        .toMatchObject({ kind: "launching", warmAttachment: true });
    } finally {
      if (selectionId) await f.db.delete(agentTaskSessions).where(eq(agentTaskSessions.id, selectionId));
      await publishedCore?.stop(); await f.core.stop(); await sourceCore.stop(); await rm(paths.root, { recursive: true, force: true });
    }
  });
});
