import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { completionContracts, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, toolInvocations } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { DurablePrpControlPlane, parseNativeExecutionInput, type NativeSessionBackend, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { executePaperclipNativeSession, nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

vi.mock("./paperclip-runner-tool-authority.js", () => ({ PaperclipRunnerToolAuthority: class {
  readonly binding = {};
  async definitions() { return []; }
  close() {}
} }));

// Staging class P after #20757: run A yielded for an approval, its harness
// backup was never saved, and its sandbox was destroyed. The follow-up run B
// rebinds A's session in a new sandbox whose Runner has no saved state for it.
// B has not started a turn, so a fresh provider session cannot repeat provider
// work or a tool side effect. B continues in that fresh session on its own,
// with no Retry. Any durable sign that B already did provider work keeps the
// permanent named refusal.
describeEmbeddedPostgres("governed-wait follow-up whose saved provider state is gone", () => {
  const environment = nativeRestartFixture();
  const homes: string[] = [];
  afterEach(async () => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

  async function followUpRun() {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, runtimeRoot } = environment.current;
    const home = await mkdtemp(join(tmpdir(), "native-governed-lost-state-")); homes.push(home);
    vi.stubEnv("PAPERCLIP_HOME", home);
    const [sourceRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.id, sourceRun!.completionContractId!));
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      binding: { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: randomUUID() },
      task: { identifier: "GWL-1", title: "Approved work", description: null, prompt: "Continue after the approval.", workMode: "standard" },
      workspace: { cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson },
      runtimeContext: nativeRuntimeContextFixture(), credentialBindings: [], interactionResponses: [],
    });
    const yielded = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Waiting for approval",
      completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
      continuation: { kind: "response_wake", summary: "Continue after the answer", idempotencyKey: "fixture-approval" } };
    const snapshot: PersistedNativeSession = { backendKind: "runner", driverKind: "codex_app_server", sessionId: "lost-driver-session",
      providerSessionId: "lost-provider-session", identity: { companyId, agentId, issueId: f.issueId, runId: f.runId, sessionId: f.native.normalizedSessionId },
      cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], terminalTurns: [], lineage: [], semanticResult: yielded as never, goal: null };
    const bootId = randomUUID(), leaseOwner = randomUUID();
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 1, controllerPid: 2_147_483_000,
      controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, randomUUID()), identity: { runId: f.runId, normalizedSessionId: f.native.normalizedSessionId,
      runnerInstanceId: f.native.runnerInstanceId, environmentLeaseId: f.native.environmentLeaseId, turnId: f.native.turnId, itemId: f.native.itemId },
      expectedRunnerVersion: "governed-lost-state-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) Object.assign(core.queueCommand(type), { status: "completed", result: { status: "completed" } });
    core.store.state.committedEvents.push({ sourceSeq: 1, sourceEventId: "fixture-terminal", eventType: "run.terminal", priority: 0, envelope: { ...core.store.state.identity }, deliveryCount: 1, logicalEffectCount: 1 });
    core.store.state.ackedSourceSeq = 1;
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(f.db, { companyId, issueId: f.issueId, runId: f.runId, authorityRunId: f.runId, bootId, generation: 1, leaseOwner }));
    await core.flushCheckpoint(); await core.stop();
    const [result] = await f.db.insert(nativeRunResults).values({ companyId, issueId: f.issueId, runId: f.runId, completionContractId: sourceRun!.completionContractId!,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: yielded, canonicalSha256: "a".repeat(64) }).returning();
    const fingerprint = nativeToolContractFingerprintForTarget("remote", "codex");
    const descriptor = nativeControllerMigrationDescriptor(execution, fingerprint);
    const sourceProfile = { ...f.preparedProfile, nativeExecutionInput: execution, sessionCheckpoint: snapshot, nativeToolContractFingerprint: fingerprint,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: descriptor.configDigest, processConfigDigest: null },
        { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId }) };
    await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: sourceProfile }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));

    const runId = randomUUID();
    const [run] = await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: f.issueId, issueId: f.issueId, status: "running",
      runtimeMode: "native", nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId,
      completionContractId: sourceRun!.completionContractId, completionContractSha256: sourceRun!.completionContractSha256 }).returning();
    const native = await prepareNativeHeartbeatRun({ db: f.db, run: run!, issue: { id: f.issueId, title: "Approved work", description: null }, environmentLeaseId: randomUUID() });
    const current = { ...execution, binding: { ...execution.binding, runId } };
    const rebound = rebindNativeSessionCheckpoint({ previousRun: { id: f.runId, companyId, agentId, nativeSessionId: f.native.normalizedSessionId, runnerProfileJson: sourceProfile },
      currentExecution: current, executionTargetKind: "remote" });
    expect(rebound?.providerRecoveryPolicy).toBe("allow_replacement_after_governed_wait");
    const [prepared] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared!.runnerProfileJson, nativeExecutionInput: current, sessionCheckpoint: rebound } }).where(eq(heartbeatRuns.id, runId));
    await f.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: f.issueId, phase: "observed" });
    await f.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));

    const recover = vi.fn(async () => ({ recovered: false as const, failureClass: "provider_state_incompatible" as const, resumeStateUnavailable: true as const,
      reason: "Error: NativeRunnerResumeStateUnavailableError: PRP provider resume state is unavailable" }));
    const replacementObserved = new Error("fixture fresh provider session opened");
    const fresh = vi.fn(async () => { throw replacementObserved; });
    const backend: NativeSessionBackend = {
      descriptor: async () => ({ kind: "runner", name: "controlled provider boundary", version: "fixture",
        capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }),
      recoverSession: recover, openSession: fresh, openReplacementSession: fresh,
    };
    const execute = () => executePaperclipNativeSession({ db: f.db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, backend,
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: runtimeRoot, environmentId: randomUUID(), leaseId: randomUUID(),
        providerKey: "fixture", reusableLeaseConfigured: true, runner: { execute: async () => { throw new Error("unexpected remote process execution"); } },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "new-fixture-sandbox" } } as never }).catch((error: unknown) => error);
    return { f, companyId, agentId, runId, recover, fresh, replacementObserved, execute };
  }

  const proofFor = (h: Awaited<ReturnType<typeof followUpRun>>) => new PaperclipControlPlanePort(h.f.db, {
    companyId: h.companyId, issueId: h.f.issueId, runId: h.runId, agentId: h.agentId, sessionId: "proof-session",
    completionContractId: "proof-contract", completionContractSha256: "proof-contract", sourceInstanceId: "proof-runner",
    controlPlaneSourceInstanceId: "proof-control",
  }).provesNoRunProviderWork({ signal: new AbortController().signal });

  it("opens a fresh provider session for the follow-up without a Retry", async () => {
    const h = await followUpRun();
    expect(await proofFor(h)).toBe(true);
    const failure = await h.execute();
    expect(h.recover, String(failure)).toHaveBeenCalledOnce();
    // The fixture stops at the fresh session's boundary; on master the run
    // ended with native_provider_state_incompatible before reaching it.
    expect(failure).toBe(h.replacementObserved);
    expect(h.fresh).toHaveBeenCalledOnce();
  }, 60_000);

  it.each([
    ["a provider event", "event"],
    ["a tool invocation", "tool"],
    ["an accepted result", "result"],
    // A runner event of a non-provider type still carries a source identity:
    // a runner wrote it for this run, so the run is not untouched.
    ["a sourced runner event of a non-provider type", "sourced_event"],
    // The foreign key normally forbids this. A row restored without its result
    // must still deny the proof rather than look like an untouched run.
    ["a finalized result whose result row is missing", "dangling_result"],
  ] as const)("keeps the named refusal when the follow-up run already recorded %s", async (_label, evidence) => {
    const h = await followUpRun();
    if (evidence === "event") await h.f.db.insert(heartbeatRunEvents).values({ companyId: h.companyId, runId: h.runId, agentId: h.agentId,
      seq: 1_000, eventType: "turn.started", stream: "system", level: "info", message: "turn started", payload: {} });
    if (evidence === "tool") await h.f.db.insert(toolInvocations).values({ companyId: h.companyId, runId: h.runId, agentId: h.agentId,
      toolName: "paperclip_get_issue", riskLevel: "read", status: "succeeded" } as never);
    if (evidence === "result") {
      const [run] = await h.f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, h.runId));
      await h.f.db.insert(nativeRunResults).values({ companyId: h.companyId, issueId: h.f.issueId, runId: h.runId, completionContractId: run!.completionContractId!,
        serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: "b".repeat(64) });
    }
    if (evidence === "sourced_event") await h.f.db.insert(heartbeatRunEvents).values({ companyId: h.companyId, runId: h.runId, agentId: h.agentId,
      seq: 1_000, eventType: "native.diagnostic", stream: "system", level: "info", message: "runner diagnostic", payload: {},
      sourceInstanceId: "foreign-runner-instance", sourceEventId: "foreign-runner-instance:event:1", sourceSeq: 1 });
    if (evidence === "dangling_result") await h.f.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = 'replica'`);
      await tx.update(nativeRunFinalizations).set({ resultId: randomUUID() }).where(eq(nativeRunFinalizations.runId, h.runId));
    });
    if (evidence === "sourced_event" || evidence === "dangling_result") {
      // The fixture is the only evidence: no tool invocation or result row.
      expect(await h.f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, h.runId))).toEqual([]);
      expect(await h.f.db.select().from(toolInvocations).where(eq(toolInvocations.runId, h.runId))).toEqual([]);
    }
    // The durable proof itself refuses each kind of evidence.
    expect(await proofFor(h)).toBe(false);
    const failure = await h.execute();
    expect(h.fresh).not.toHaveBeenCalled();
    if (evidence === "dangling_result") {
      // Admission stops even earlier on a finalized result: still no fresh session.
      expect(String(failure)).toContain("native_result_pending_finalization");
      return;
    }
    expect(h.recover, String(failure)).toHaveBeenCalledOnce();
    expect((failure as { code?: string }).code).toBe("native_provider_state_incompatible");
  }, 60_000);
});
