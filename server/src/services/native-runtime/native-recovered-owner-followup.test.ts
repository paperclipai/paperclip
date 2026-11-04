import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, nativeRunResults,
} from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const toolDefinitions = vi.hoisted(() => vi.fn());
vi.mock("../../runtime-api.js", () => ({ resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:43219" }));
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    readonly binding = {};
    definitions() { return toolDefinitions(); }
    close() {}
  },
}));
vi.mock("./current-wake-comments.js", () => ({
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
import { createRunnerdBackend } from "./native-session-executor.js";

// Durable-root admission is the boundary under test. Reaching the run's tool
// authority proves admission passed; no provider or runner process starts.
const ADMITTED = "follow-up admission reached tool authority";
const STRANDED = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";

describe.skipIf(!recoveryPostgresSupport.supported)("follow-up after a recovered per-turn native owner", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let stateDirectory: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  const companyId = randomUUID(), agentId = randomUUID();

  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    database = await startRecoveryPostgres("native-recovered-owner-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Recovered owner", issuePrefix: "ROF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "claude" } });
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    home?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });
  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "native-recovered-owner-state-"));
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateDirectory;
    toolDefinitions.mockReset().mockRejectedValue(new Error(ADMITTED));
  });
  afterEach(async () => {
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const issueFields = (issueId: string) => ({ id: issueId, title: "Continue after recovery", description: null, reviewPolicy: null });

  /** A per-turn sandbox turn whose post-turn checkpoint copy failed. Recovery
   * later committed its result and released the controller lease, but no
   * suspended Runner receipt or failover backup ever reached the controller.
   * Only the database controller checkpoint and recovery pointer survive. */
  async function seedRecoveredPriorRun(control: "settled" | "pending-command" | "unanswered-tool" = "settled") {
    const issueId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after recovery", assigneeAgentId: agentId, status: "in_progress" });
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, contextSnapshot: { issueId } }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(issueId), environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const executionFor = (currentRunId: string) => buildNativeExecutionInput({
      companyId, agentId, runId: currentRunId, provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5",
      issue: { id: issueId, identifier: "ROF-1", title: "Continue after recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue the conversation.",
      workspace: { id: workspaceId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: native.normalizedSessionId,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion,
        contract: contract.contractJson as never },
    });
    const execution = executionFor(runId);
    const identity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: 1, controllerPid: 2_147_483_000,
      controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const scratch = await mkdtemp(join(tmpdir(), "native-recovered-owner-controller-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      // Shape the file-backed journal first; the database checkpoint captures
      // it when persistence moves to the controller's external writer.
      const commands = ["run.prepare", "session.open", "turn.start", "runner.suspend"].map(type => controller.queueCommand(type));
      for (const command of control === "pending-command" ? commands.slice(0, -1) : commands) {
        Object.assign(command, { status: "completed", result: { status: "completed" } });
      }
      const event = (sourceSeq: number, sourceEventId: string, eventType: string) => ({ sourceSeq, sourceEventId, eventType,
        priority: 0 as const, envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.committedEvents.push(
        ...(control === "unanswered-tool" ? [event(1, "unanswered-tool-input", "semantic_tool.input")] : []),
        event(2, "recovered-terminal", "run.terminal"));
      controller.store.state.ackedSourceSeq = 2;
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
    } finally {
      await controller.stop();
      await rm(scratch, { recursive: true, force: true });
    }
    const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: native.normalizedSessionId,
      providerSessionId: "provider-session-before-recovery", activeTurnId: null, pendingRuntimeRequests: [],
      identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
      ...prepared.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      nativeControllerRecovery: createNativeControllerRecovery(snapshot,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId, runnerInstanceId: native.runnerInstanceId, normalizedSessionId: native.normalizedSessionId }),
    } }).where(eq(heartbeatRuns.id, runId));
    return { issueId, runId, native, identity, executionFor };
  }

  /** Mirrors runtime selection: the follow-up inherits the selected source's
   * provider checkpoint before the executor admits its durable root. */
  async function admitFollowUp(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
    const runId = randomUUID();
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: prior.issueId, nativeSessionId: prior.native.normalizedSessionId, contextSnapshot: { issueId: prior.issueId } }).returning();
    const next = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(prior.issueId), environmentLeaseId: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: prior.issueId, runId, phase: "observed" });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, prior.issueId));
    const execution = prior.executionFor(runId);
    const selected = await findNativeSessionResumeRun(db, { companyId, agentId, issueId: prior.issueId,
      normalizedSessionId: prior.native.normalizedSessionId, currentRunId: runId, beforeCreatedAt: row.createdAt });
    const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: prior.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => execution });
    expect(admission.checkpoint).not.toBeNull();
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson, nativeExecutionInput: execution,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      sessionCheckpoint: admission.checkpoint } }).where(eq(heartbeatRuns.id, runId));
    const logs: string[] = [];
    const start = (outcome: "created" | "replacement" = "created") => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async (_stream, chunk) => { logs.push(chunk); },
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: randomUUID(),
        leaseId: randomUUID(), remoteCwd: "/workspace", reusableLeaseConfigured: true,
        runner: { execute: vi.fn(async () => { throw new Error("admission must not reach the sandbox"); }) },
        sandboxLeaseAcquisition: { outcome, providerLeaseId: `sandbox-${runId}` } } as never,
    }).then(() => "constructed", (error: Error) => error.message);
    return { runId, logs, start, selectedRunId: selected?.id ?? null };
  }

  async function quarantined() {
    const path = join(stateDirectory, "quarantine");
    return existsSync(path) ? readdir(path) : [];
  }

  async function sessionRoot() {
    const roots = (await readdir(stateDirectory)).filter(name => /^[a-f0-9]{64}$/.test(name));
    expect(roots).toHaveLength(1);
    return join(stateDirectory, roots[0]!);
  }

  async function archivedOwners(root: string) {
    const parent = join(root, "continuity-breaks");
    if (!existsSync(parent)) return [];
    return Promise.all((await readdir(parent)).map(async name => {
      expect(name).toMatch(/^\d+-[0-9a-f-]{36}$/);
      return JSON.parse(await readFile(join(parent, name, "control-plane", "control-plane-state.json"), "utf8")).identity.runId as string;
    }));
  }

  it.each(["created", "replacement"] as const)(
    "admits a fresh runner authority when the recovered owner is provably finished: %s sandbox", async outcome => {
      const prior = await seedRecoveredPriorRun();
      const followUp = await admitFollowUp(prior);
      expect(followUp.selectedRunId).toBe(prior.runId);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      expect(await quarantined()).toEqual([]);
      const root = await sessionRoot();
      // The prior authority is retained as continuity evidence, not active state.
      expect(existsSync(join(root, "control-plane"))).toBe(false);
      expect(await archivedOwners(root)).toEqual([prior.runId]);
      expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
    }, 60_000);

  /** The state left by a follow-up admitted before retirement existed. Its
   * admission quarantined the rebuilt projection and failed before provider
   * work; it keeps only the provider checkpoint inherited from the owner. */
  async function failUnstartedFollowUp(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
    const followUp = await admitFollowUp(prior);
    const error = await (async () => {
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      try {
        return await followUp.start();
      } finally {
        await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      }
    })();
    expect(error).toBe(STRANDED);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", error, finishedAt: new Date(),
      nativePhase: "observed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, followUp.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_continuation_requires_reconciliation" })
      .where(eq(nativeRunFinalizations.runId, followUp.runId));
    await db.update(issues).set({ executionRunId: null, status: "blocked" }).where(eq(issues.id, prior.issueId));
    return followUp.runId;
  }

  it("retries from the committed owner after a follow-up failed before provider work", async () => {
    const prior = await seedRecoveredPriorRun();
    await failUnstartedFollowUp(prior);
    const retry = await admitFollowUp(prior);
    expect(await retry.start()).toBe(ADMITTED);
    expect(retry.selectedRunId).toBe(prior.runId);
    expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
  }, 60_000);

  it("skips every unstarted follow-up after repeated failed retries", async () => {
    const prior = await seedRecoveredPriorRun();
    const failed = await failUnstartedFollowUp(prior);
    const retry = await admitFollowUp(prior);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
      error: "native_controller_recovery_unsupported:metadata_format",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, retry.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, retry.runId));
    const next = await admitFollowUp(prior);
    expect([failed, retry.runId]).not.toContain(next.selectedRunId);
    expect(next.selectedRunId).toBe(prior.runId);
    expect(await next.start()).toBe(ADMITTED);
  }, 60_000);

  it.each(["process identity", "provider event", "controller checkpoint", "provider work receipt", "claimed coordinator",
    "run result", "different provider session", "own progress cursor"] as const)(
    "keeps a failed follow-up as the source with %s", async scenario => {
      const prior = await seedRecoveredPriorRun();
      const failed = await failUnstartedFollowUp(prior);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      const checkpoint = run.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>;
      if (scenario === "process identity") {
        await db.update(heartbeatRuns).set({ processPid: 4_242 }).where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "provider event") {
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 1, eventType: "session.started",
          stream: "system", payload: {} });
      }
      if (scenario === "controller checkpoint") {
        await db.insert(nativeRunnerCheckpoints).values({ companyId, issueId: prior.issueId, runId: failed, part: "header", material: {} });
      }
      if (scenario === "provider work receipt") {
        await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } })
          .where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "claimed coordinator") {
        await db.update(nativeRunFinalizations).set({ controllerPid: 4_242 }).where(eq(nativeRunFinalizations.runId, failed));
      }
      if (scenario === "run result") {
        await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId, runId: failed,
          completionContractId: run.completionContractId!, serverFingerprint: "fixture", schemaStatus: "rejected",
          resultJson: {}, canonicalSha256: "fixture" });
      }
      if (scenario === "different provider session" || scenario === "own progress cursor") {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: {
          ...checkpoint, ...(scenario === "own progress cursor" ? { cursor: { sourceSeq: 1 } } : { providerSessionId: "another-provider-session" }) } } })
          .where(eq(heartbeatRuns.id, failed));
      }
      const retry = await admitFollowUp(prior);
      expect(retry.selectedRunId).toBe(failed);
      expect(await retry.start()).toBe("native_controller_recovery_unsupported:metadata_format");
    }, 60_000);

  it("admits again when a retry rebuilds the same projection from the database", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
    // Every admission restores the prior projection from the database. The
    // same proof must hold each time instead of rejecting the rebuilt root.
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId, prior.runId]);
  }, 60_000);

  it("admits a stranded task whose earlier attempts quarantined the same projection", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(STRANDED);
    expect(await quarantined()).toHaveLength(1);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toHaveLength(1);
  }, 60_000);

  it("keeps an unsuspended Runner receipt decisive after a retry rebuilds the root", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    // Learn the scope key from a held attempt, then give the active root the
    // local evidence of an owner whose Runner never suspended.
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(STRANDED);
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await mkdir(join(root, "runner"));
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...prior.identity }));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(STRANDED);
    expect(await quarantined()).toHaveLength(1);
    // The retry restores only the database journal. The quarantined receipt
    // must still hold it.
    expect(await followUp.start()).toBe(STRANDED);
    expect(await quarantined()).toHaveLength(2);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  it.each(["uncommitted result", "live controller lease", "unexpired controller lease", "recovery pending", "pending command",
    "unanswered tool input", "foreign quarantine"] as const)("keeps the prior owner held with %s", async scenario => {
    const prior = await seedRecoveredPriorRun(scenario === "pending command" ? "pending-command"
      : scenario === "unanswered tool input" ? "unanswered-tool" : "settled");
    const followUp = await admitFollowUp(prior);
    let expectedQuarantine = 1;
    if (scenario === "uncommitted result") {
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", resultId: null })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "live controller lease") {
      await db.update(nativeRunFinalizations).set({ leaseOwner: "another-controller", leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "unexpired controller lease") {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "recovery pending") {
      await db.update(nativeRunFinalizations).set({ recoveryState: "resuming_session" })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "foreign quarantine") {
      // A copy of this projection is harmless; a different owner saved under
      // the same scope is unresolved evidence that must not be overtaken.
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      expect(await followUp.start()).toBe(STRANDED);
      const [copy] = await quarantined();
      const foreign = join(stateDirectory, "quarantine", copy!.replace(/\.[0-9a-f-]{36}$/, `.${randomUUID()}`));
      await cp(join(stateDirectory, "quarantine", copy!), foreign, { recursive: true });
      const path = join(foreign, "control-plane", "control-plane-state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...state, identity: { ...state.identity, runId: randomUUID() } }));
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      expectedQuarantine = 3;
    }
    const outcome = await followUp.start();
    // A live owner is still waited for before any projection is rebuilt.
    expect(outcome).toBe(scenario === "live controller lease" ? "native_controller_recovery_waiting_for_owner" : STRANDED);
    expect(await quarantined()).toHaveLength(scenario === "live controller lease" ? 0 : expectedQuarantine);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);
});
