import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { completionContracts, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { parseNativeExecutionInput, type NativeExecutionInput, type NativeSessionBackend, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { executePaperclipNativeSession, nativeControllerMigrationDescriptor, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";


vi.mock("./paperclip-runner-tool-authority.js", () => ({ PaperclipRunnerToolAuthority: class {
  readonly binding = {};
  async definitions() { return []; }
  close() {}
} }));

async function savedUnstartedAttachment(db: Db, execution: NativeExecutionInput, runnerInstanceId: string) {
  const deadChild = async () => { const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }); const pid = child.pid!; await once(child, "exit"); return pid; };
  const birth = new Date(), runnerPid = await deadChild(), providerPid = await deadChild(), runId = randomUUID(), environmentLeaseId = randomUUID();
  const source = { ...execution, binding: { ...execution.binding, runId } }, { companyId, agentId, issueId } = source.binding;
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
    nativeSessionId: source.session.normalizedSessionId, runnerInstanceId, finishedAt: new Date(), runnerProfileJson: { nativeExecutionInput: source } });
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: issueId!, phase: "terminal_failure" });
  await db.insert(environmentLeases).values({ id: environmentLeaseId, companyId, heartbeatRunId: runId, provider: "local", status: "failed", releasedAt: new Date() });
  await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "native.process_identity_recorded", payload: {
    hostname: hostname(), targetKind: "local", processPid: runnerPid, processGroupId: null, processStartedAt: birth.toISOString() } });
  const scoped = scopedRunnerdStateRoot(source), root = join(dirname(scoped), "quarantine", `${basename(scoped)}.identity_indeterminate.${Date.now()}.${randomUUID()}`,
    "continuity-breaks", `${Date.now()}-${randomUUID()}`);
  const identity = { runId, runnerInstanceId, environmentLeaseId, normalizedSessionId: source.session.normalizedSessionId,
    turnId: `turn-${runId}`, itemId: `item-${runId}` };
  const command = { commandId: "attachment-1", controllerSeq: 1, type: "run.attach", status: "pending" };
  const files = {
    "control-plane/control-plane-state.json": { schema: "paperclip.runner.durable.control-plane-state.v2", identity, connectionCount: 1, ackedSourceSeq: 0, committedEvents: [], commands: [command] },
    "runner/runner-state.json": { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", nextSourceSeq: 1, ackedSourceSeq: 0, outbox: [],
      processedCommands: { "attachment-1": { ...command, commandType: command.type } } },
    "runner/codex-provider-state.json": { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared", ambiguousTurnStartPending: false,
      startupAttempt: { schema: "paperclip.provider_startup.v1", phase: "spawned", origin: identity, command: { ...command, commandType: command.type },
        processId: providerPid, processGroupId: null, authenticatedThreadId: null }, pendingEvents: [], queuedEvents: [] },
  };
  for (const [name, value] of Object.entries(files)) { await mkdir(join(root, name, ".."), { recursive: true }); await writeFile(join(root, name), JSON.stringify(value)); }
  return async () => { for (const [name, value] of Object.entries(files)) expect(await readFile(join(root, name), "utf8")).toBe(JSON.stringify(value)); };
}

describeEmbeddedPostgres("continuation after a stopped local attachment", () => {
  const environment = nativeRestartFixture();
  const homes: string[] = [];
  afterEach(async () => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

  it("preserves the stopped attachment and the authorized replacement policy", async () => {
    const policy = "allow_replacement_after_resume_failure";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId, runtimeRoot } = environment.current;
    const home = await mkdtemp(join(tmpdir(), "native-harness-independence-")); homes.push(home);
    vi.stubEnv("PAPERCLIP_HOME", home);
    const workspaceId = randomUUID();
    const [sourceRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.id, sourceRun!.completionContractId!));
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      binding: { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: workspaceId },
      task: { identifier: "LHI-1", title: "Retained provider work", description: null, prompt: "Continue the saved work.", workMode: "standard" },
      workspace: { cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson },
      runtimeContext: nativeRuntimeContextFixture(), credentialBindings: [], interactionResponses: [],
    });
    const semanticResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Prior provider result", completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const snapshot: PersistedNativeSession = { backendKind: "runner", driverKind: execution.session.driverKind, sessionId: "retained-driver-session", providerSessionId: "retained-provider-session", identity: { companyId, agentId, issueId: f.issueId, runId: f.runId, sessionId: f.native.normalizedSessionId }, cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], terminalTurns: [], lineage: [], semanticResult: semanticResult as never, goal: null };
    const targetKind = "local";
    const fingerprint = nativeToolContractFingerprintForTarget(targetKind, "codex");
    const descriptor = nativeControllerMigrationDescriptor(execution, fingerprint);
    const bootId = randomUUID(), leaseOwner = randomUUID();
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 1, controllerPid: 2_147_483_000, controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [result] = await f.db.insert(nativeRunResults).values({ companyId, issueId: f.issueId, runId: f.runId, completionContractId: (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.completionContractId!, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: semanticResult, canonicalSha256: "a".repeat(64) }).returning();
    const sourceProfile = { ...f.preparedProfile, nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint, sessionCheckpoint: snapshot, nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: descriptor.configDigest, processConfigDigest: null }, { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId }) };
    await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: sourceProfile }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    const runId = randomUUID();
    const [run] = await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: f.issueId, issueId: f.issueId, status: "running", runtimeMode: "native", nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId, completionContractId: sourceRun!.completionContractId, completionContractSha256: sourceRun!.completionContractSha256 }).returning();
    const native = await prepareNativeHeartbeatRun({ db: f.db, run: run!, issue: { id: f.issueId, title: "Retained provider work", description: null }, environmentLeaseId: randomUUID() });
    const current = { ...execution, binding: { ...execution.binding, runId } };
    const rebound = rebindNativeSessionCheckpoint({ previousRun: { id: f.runId, companyId, agentId, nativeSessionId: f.native.normalizedSessionId, runnerProfileJson: sourceProfile }, currentExecution: current, executionTargetKind: targetKind });
    expect(rebound?.providerRecoveryPolicy).toBe(policy);
    const [prepared] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared!.runnerProfileJson, nativeExecutionInput: current, sessionCheckpoint: rebound } }).where(eq(heartbeatRuns.id, runId));
    await f.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: f.issueId, phase: "observed" });
    await f.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const recover = vi.fn(async (saved: PersistedNativeSession) => ({ recovered: false as const, reason: "fixture provider source is absent" }));
    const fresh = vi.fn(async () => { throw new Error("fixture replacement observed before provider turn"); });
    const describe = vi.fn<NativeSessionBackend["descriptor"]>(async () => ({ kind: "runner", name: "controlled provider boundary", version: "fixture", capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }, runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }));
    const backend: NativeSessionBackend = { descriptor: describe, recoverSession: recover, openSession: fresh, openReplacementSession: fresh };
    const verifyAttachment = await savedUnstartedAttachment(f.db, execution, native.runnerInstanceId);
    const failure = await executePaperclipNativeSession({
      db: f.db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, backend,
    }).catch(error => error);
    expect(recover, String(failure)).toHaveBeenCalledOnce();
    expect(recover.mock.calls[0]![0]).toMatchObject({
      providerSessionId: snapshot.providerSessionId, identity: { runId }, providerRecoveryPolicy: policy,
    });
    expect(fresh).toHaveBeenCalledOnce();
    await verifyAttachment();
    const events = await f.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.filter(event => event.eventType === "native.unstarted_attachment_verified")).toHaveLength(1);
  }, 60_000);
});
