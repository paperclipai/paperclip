import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, nativeRunResults,
} from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { readProcessStartedAt } from "../hot-restart.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const toolDefinitions = vi.hoisted(() => vi.fn());
vi.mock("../../runtime-api.js", async importOriginal => ({ ...await importOriginal<typeof import("../../runtime-api.js")>(), resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:43219" }));
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    readonly binding = {};
    definitions() { return toolDefinitions(); }
    close() {}
  },
}));
vi.mock("./current-wake-comments.js", async importOriginal => ({
  ...await importOriginal<typeof import("./current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
import { buildNativeHarnessBackupManifest, createRunnerdBackend, quarantinedBootstrapOfOwnerHeldNoProviderWork, resolveNativeHarnessPersistenceProfile,
  scopedRunnerdStateRoot } from "./native-session-executor.js";

// Durable-root admission is the boundary under test. Reaching the run's tool
// authority proves admission passed; no provider or runner process starts.
const ADMITTED = "follow-up admission reached tool authority";
const STRANDED = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";
/** The held follow-up names the retirement proof that failed. */
const stranded = (refused: string) => `${STRANDED}; retirement_refused=${refused}`;

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
  async function seedRecoveredPriorRun(control: "settled" | "pending-command" | "unanswered-tool"
    | "failed-turn-start" | "rejected-turn-start" | "indeterminate-turn-start" | "unknown-outcome-turn-start"
    | "unsuperseded-unknown-outcome-turn-start" | "failed-suspend" | "pending-attach" | "pending-tool-result" = "settled",
    options: { controller?: { bootId: string; pid: number; processStartedAt: Date }; provider?: "codex" | "acpx" | "opencode";
      lifecycle?: "warm"; governedWait?: boolean } = {}) {
    const issueId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after recovery", assigneeAgentId: agentId, status: "in_progress" });
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, contextSnapshot: { issueId } }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(issueId), environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const executionFor = (currentRunId: string) => buildNativeExecutionInput({
      companyId, agentId, runId: currentRunId, provider: options.provider ?? "acpx", acpxAgent: "claude",
      model: options.provider === "codex" ? "gpt-6.1-sol"
        : options.provider === "opencode" ? "openrouter/deepseek/deepseek-v4.1-flash-1017" : "claude-opus-5-5",
      issue: { id: issueId, identifier: "ROF-1", title: "Continue after recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue the conversation.",
      workspace: { id: workspaceId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: native.normalizedSessionId,
      lifecyclePolicy: options.lifecycle === "warm" ? { mode: "warm", idleTimeoutMs: 900_000 } : { mode: "per_turn", idleTimeoutMs: null },
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion,
        contract: contract.contractJson as never },
    });
    const execution = executionFor(runId);
    const identity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
    const priorController = options.controller ?? { bootId: randomUUID(), pid: 2_147_483_000,
      processStartedAt: new Date(Date.now() - 60_000) };
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: priorController.bootId, generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: 1, controllerPid: priorController.pid,
      controllerProcessStartedAt: priorController.processStartedAt, leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const scratch = await mkdtemp(join(tmpdir(), "native-recovered-owner-controller-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      // Shape the file-backed journal first; the database checkpoint captures
      // it when persistence moves to the controller's external writer.
      const unknownOutcome = { status: "failed", result: { commandType: "turn.start", status: "failed",
        result: { code: "execution_indeterminate", message: "runner recovered after journaling this command; it will not execute twice" } } };
      const answers = {
        "failed-turn-start": { status: "failed", result: { status: "failed" } },
        "rejected-turn-start": { status: "rejected", result: { status: "rejected" } },
        "indeterminate-turn-start": { status: "indeterminate", result: { status: "indeterminate" } },
        "unknown-outcome-turn-start": unknownOutcome,
      } as const;
      const answered = answers as Record<string, unknown>;
      // A warm Runner stays ready after its turn: its controller sends no suspend.
      const commands = ["run.prepare", "session.open", ...(control in answered ? ["turn.start"] : []), "turn.start",
        ...(options.lifecycle === "warm" ? [] : ["runner.suspend"])].map(type => controller.queueCommand(type));
      for (const command of control === "pending-command" ? commands.slice(0, -1) : commands) {
        Object.assign(command, { status: "completed", result: { status: "completed" } });
      }
      if (control in answered) Object.assign(commands[2]!, answers[control as keyof typeof answers]);
      if (control === "unsuperseded-unknown-outcome-turn-start") {
        Object.assign(commands.find(command => command.type === "turn.start")!, unknownOutcome);
      }
      if (control === "failed-suspend") Object.assign(commands.at(-1)!, { status: "failed", result: { status: "failed" } });
      // Staging PAP-4196 and PAP-3443: the controller journaled a delivery to the
      // per-turn Runner that the Runner never acknowledged before its sandbox was
      // destroyed after the turn.
      if (control === "pending-attach") controller.queueCommand("run.attach", { provider: "fixture" });
      const toolInput = control === "unanswered-tool" || control === "pending-tool-result";
      if (control === "pending-tool-result") controller.queueCommand("semantic_tool.result", { sourceEventId: "unanswered-tool-input" });
      const event = (sourceSeq: number, sourceEventId: string, eventType: string) => ({ sourceSeq, sourceEventId, eventType,
        priority: 0 as const, envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.committedEvents.push(
        ...(toolInput ? [event(1, "unanswered-tool-input", "semantic_tool.input")] : []),
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
      // A turn parked on a request_human_input question commits this governed-wait result.
      resultJson: options.governedWait ? { continuation: { kind: "response_wake", idempotencyKey: "interaction-response:question" },
        artifacts: [{ kind: "issue_thread_interaction", ref: `interaction:${randomUUID()}` }] } : {},
      canonicalSha256: "fixture" }).returning();
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
    const logs: string[] = [], environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${runId}`;
    const remoteExecute = vi.fn(async (_request: unknown): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> => {
      throw new Error("admission must not reach the sandbox");
    });
    const start = (outcome: "created" | "replacement" | "resumed" = "created",
      restartRecovery?: Parameters<typeof createRunnerdBackend>[0]["restartRecovery"]) => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async (_stream, chunk) => { logs.push(chunk); },
      ...(restartRecovery ? { restartRecovery } : {}),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId,
        leaseId, remoteCwd: "/workspace", reusableLeaseConfigured: true,
        runner: { execute: remoteExecute },
        sandboxLeaseAcquisition: { outcome, providerLeaseId } } as never,
    }).then(() => "constructed", (error: Error) => error.message);
    // A local Runner keeps its controller root on this host between turns.
    const startLocal = (restartRecovery?: Parameters<typeof createRunnerdBackend>[0]["restartRecovery"]) => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async (_stream, chunk) => { logs.push(chunk); },
      ...(restartRecovery ? { restartRecovery } : {}),
    }).then(() => "constructed", (error: Error) => error.message);
    return { runId, logs, start, startLocal, native: next, environmentId, leaseId, providerLeaseId, remoteExecute, selectedRunId: selected?.id ?? null };
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

  async function seedSuccessorCheckpoint(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
    const pending = await admitFollowUp(prior), runId = pending.runId, execution = prior.executionFor(runId);
    const identity = { ...prior.identity, runId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const owner = { companyId, issueId: prior.issueId, runId, authorityRunId: runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.update(heartbeatRuns).set({ runnerInstanceId: identity.runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
      controllerPid: 2_147_483_000, controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const scratch = await mkdtemp(join(tmpdir(), "native-successor-checkpoint-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      controller.persistRunAttachTemplate({ provider: execution.provider, normalizedSessionId: identity.normalizedSessionId });
      for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
        Object.assign(controller.queueCommand(type), { status: "completed", result: { status: "completed" } });
      }
      controller.store.state.committedEvents.push({ sourceSeq: 2, sourceEventId: `terminal-${runId}`, eventType: "run.terminal",
        priority: 0, envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.ackedSourceSeq = 2;
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
    } finally {
      await controller.stop();
      await rm(scratch, { recursive: true, force: true });
    }
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: prior.native.normalizedSessionId,
      providerSessionId: "provider-session-before-recovery", activeTurnId: null, pendingRuntimeRequests: [],
      identity: { companyId, agentId, issueId: prior.issueId, runId, sessionId: prior.native.normalizedSessionId } };
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: runId, schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: runId }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
      ...prepared.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId, runnerInstanceId: identity.runnerInstanceId, normalizedSessionId: identity.normalizedSessionId }),
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    return { runId, execution, identity };
  }

  async function staleProjection(provider: "codex" | "acpx" = "codex", external = false) {
    const prior = await seedRecoveredPriorRun("settled", { provider });
    const latest = await seedSuccessorCheckpoint(prior), followUp = await admitFollowUp(prior);
    expect(followUp.selectedRunId).toBe(latest.runId);
    const root = scopedRunnerdStateRoot(latest.execution), backupRoot = join(root, "failover-backups", "current");
    const oldCheckpoint = await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId });
    expect(oldCheckpoint).not.toBeNull();
    oldCheckpoint!.restoreSessionDirectory(root);
    const path = join(root, "control-plane", "control-plane-state.json");
    if (external) await writeFile(path, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: prior.identity }));
    const originalBytes = await readFile(path, "utf8");
    const providerFiles = new Map<string, string>();
    for (const directory of resolveNativeHarnessPersistenceProfile(latest.execution).directories) {
      await mkdir(join(backupRoot, directory.name), { recursive: true });
      if (directory.name !== "runner") {
        const file = join(backupRoot, directory.name, "retained-conversation.txt"), bytes = `saved conversation for ${latest.runId}`;
        await writeFile(file, bytes);
        providerFiles.set(file, bytes);
      }
    }
    const runnerBytes = JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...latest.identity,
      lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null });
    await writeFile(join(backupRoot, "runner", "runner-state.json"), runnerBytes);
    const manifestBytes = JSON.stringify(buildNativeHarnessBackupManifest({ backupRoot, execution: latest.execution,
      runnerInstanceId: latest.identity.runnerInstanceId, sourceProviderLeaseId: `sandbox-${latest.runId}`,
      providerSessionIdentity: { providerSessionId: "provider-session-before-recovery", providerBackendSessionId: null,
        providerSessionIdentity: null } }));
    await writeFile(join(backupRoot, "manifest.json"), manifestBytes);
    const assertBackup = async () => {
      expect(await readFile(join(backupRoot, "manifest.json"), "utf8")).toBe(manifestBytes);
      expect(await readFile(join(backupRoot, "runner", "runner-state.json"), "utf8")).toBe(runnerBytes);
      for (const [file, bytes] of providerFiles) expect(await readFile(file, "utf8")).toBe(bytes);
    };
    return { prior, latest, followUp, root, path, backupRoot, originalBytes, assertBackup };
  }

  it.each([
    { provider: "codex" as const, external: false }, { provider: "acpx" as const, external: false },
    { provider: "codex" as const, external: true }, { provider: "acpx" as const, external: true },
  ])("keeps the newest $provider checkpoint paired with its suspended backup (external=$external)", async ({ provider, external }) => {
    const fixture = await staleProjection(provider, external);
    const { prior, latest, followUp, root, path } = fixture;
    expect(await followUp.start()).toBe(ADMITTED);
    expect(JSON.parse(await readFile(path, "utf8")).identity).toEqual(latest.identity);
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(await readFile(join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json"), "utf8"))
      .toBe(fixture.originalBytes);
    expect(await readdir(join(root, "continuity-breaks", archive!))).toEqual(["control-plane"]);
    expect(await quarantined()).toEqual([]);
    expect(followUp.logs.join("")).not.toContain("starting a new runner for this conversation");
  }, 60_000);

  it("starts an unclaimed remote follow-up from the previous owner's external marker under a bootstrap claim", async () => {
    const fixture = await staleProjection("codex", true);
    expect(await fixture.followUp.start("created", { kind: "bootstrap_incomplete", runId: fixture.followUp.runId,
      leaseOwner: "successor", controllerGeneration: 1, providerAttempt: 0, restartKind: "hard", recoveryRequestId: null } as never))
      .toBe(ADMITTED);
    expect(JSON.parse(await readFile(fixture.path, "utf8")).identity).toEqual(fixture.latest.identity);
    await fixture.assertBackup();
    expect(await quarantined()).toEqual([]);
  }, 60_000);

  it("rehydrates a same-source external marker before reading the suspended resumed sandbox", async () => {
    const fixture = await staleProjection("codex", true), { latest, followUp, root, path } = fixture;
    await writeFile(path, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: latest.identity }));
    await db.insert(environments).values({ id: followUp.environmentId, name: `retained-${followUp.environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId,
      issueId: fixture.prior.issueId, heartbeatRunId: latest.runId, provider: "daytona", providerLeaseId: followUp.providerLeaseId,
      status: "released", metadata: { remoteCwd: "/workspace" } });
    const runnerState = { schema: "paperclip.runner.durable.state.v1", ...latest.identity, lifecycle: "suspended", outbox: [],
      pendingTerminalDelivery: null, pendingProviderCleanup: null, warmTransition: null };
    followUp.remoteExecute.mockResolvedValueOnce({ exitCode: 0, timedOut: false,
      stdout: Buffer.from(JSON.stringify(runnerState)).toString("base64"), stderr: "" });
    expect(await followUp.start("resumed")).toBe(ADMITTED);
    expect(JSON.parse(await readFile(path, "utf8")).identity).toEqual(latest.identity);
    expect(JSON.parse(await readFile(join(root, "plugin-runner-state.json"), "utf8"))).toMatchObject(latest.identity);
    expect(followUp.remoteExecute).toHaveBeenCalledOnce();
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([]);
    expect(await quarantined()).toEqual([]);
  }, 60_000);

  it("preserves a same-source marker with a different turn identity before any remote read", async () => {
    const fixture = await staleProjection("codex", true), { latest, followUp, root, path } = fixture;
    const marker = JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1",
      identity: { ...latest.identity, itemId: "foreign-item" } });
    await writeFile(path, marker);
    expect(await followUp.start("resumed")).toBe("native_runner_checkpoint_projection_held:prior_identity");
    expect(await readFile(path, "utf8")).toBe(marker);
    expect(followUp.remoteExecute).not.toHaveBeenCalled();
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([]);
  }, 60_000);

  it.each(["codex", "opencode"] as const)("rehydrates the current %s run marker from its own checkpoint instead of an earlier turn", async provider => {
    const prior = await seedRecoveredPriorRun("settled", { provider }), followUp = await admitFollowUp(prior);
    const identity = { runId: followUp.runId, runnerInstanceId: followUp.native.runnerInstanceId,
      environmentLeaseId: followUp.native.environmentLeaseId, normalizedSessionId: followUp.native.normalizedSessionId,
      turnId: followUp.native.turnId, itemId: followUp.native.itemId };
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    const owner = { companyId, issueId: prior.issueId, runId: followUp.runId, authorityRunId: followUp.runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, followUp.runId));
    const controller = new DurablePrpControlPlane({ stateDirectory: join(root, "control-plane"), identity,
      expectedRunnerVersion: "current-marker-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      const commands = [controller.queueCommand("run.prepare"), controller.queueCommand("session.open")];
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
      const path = join(root, "control-plane", "control-plane-state.json");
      expect(JSON.parse(await readFile(path, "utf8")).schema).toBe("paperclip.runner.external-control-plane-state.v1");
      await mkdir(join(root, "runner"), { recursive: true });
      await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
        schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended" }));
      expect(await followUp.start()).toBe(ADMITTED);
      const restored = JSON.parse(await readFile(path, "utf8"));
      expect(restored.identity).toEqual(identity);
      expect(restored.commands.map((command: { commandId: string }) => command.commandId)).toEqual(commands.map(command => command.commandId));
      expect(await archivedOwners(root)).toEqual([]);
      expect(await quarantined()).toEqual([]);
    } finally { await controller.stop(); }
  }, 60_000);

  it("never substitutes an older checkpoint when the current run marker has no checkpoint", async () => {
    const prior = await seedRecoveredPriorRun(), followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId)), path = join(root, "control-plane", "control-plane-state.json");
    await mkdir(join(root, "control-plane"), { recursive: true });
    const marker = JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: {
      runId: followUp.runId, runnerInstanceId: followUp.native.runnerInstanceId, environmentLeaseId: followUp.native.environmentLeaseId,
      normalizedSessionId: followUp.native.normalizedSessionId, turnId: followUp.native.turnId, itemId: followUp.native.itemId,
    } });
    await writeFile(path, marker);
    expect(await followUp.start()).toBe("native_runner_checkpoint_missing");
    expect(await readFile(path, "utf8")).toBe(marker);
    expect(await archivedOwners(root)).toEqual([]);
  }, 60_000);

  it.each(["unsettled journal", "old owner held", "selected owner held", "foreign scope", "selected parts missing", "selected parts tampered"] as const)(
    "preserves the stale projection and newer backup with %s", async scenario => {
      const fixture = await staleProjection(), { prior, latest, followUp, path, root } = fixture;
      if (scenario === "unsettled journal") {
        const state = JSON.parse(fixture.originalBytes);
        state.commands[0].status = "pending";
        await writeFile(path, JSON.stringify(state));
      }
      if (scenario === "old owner held" || scenario === "selected owner held") {
        await db.update(nativeRunFinalizations).set({ leaseOwner: "another-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
          .where(eq(nativeRunFinalizations.runId, scenario === "old owner held" ? prior.runId : latest.runId));
      }
      if (scenario === "foreign scope") {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...row.runnerProfileJson, nativeExecutionInput: {
          ...prior.executionFor(prior.runId), binding: { ...prior.executionFor(prior.runId).binding, executionWorkspaceId: randomUUID() },
        } } }).where(eq(heartbeatRuns.id, prior.runId));
      }
      if (scenario === "selected parts missing") {
        await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, latest.runId));
      }
      if (scenario === "selected parts tampered") {
        await db.update(nativeRunnerCheckpoints).set({ material: { tampered: true } }).where(eq(nativeRunnerCheckpoints.runId, latest.runId));
      }
      const before = await readFile(path, "utf8");
      expect(await followUp.start()).not.toBe(ADMITTED);
      expect(await readFile(path, "utf8")).toBe(before);
      await fixture.assertBackup();
      expect(await archivedOwners(root)).toEqual([]);
      expect(await quarantined()).toEqual([]);
    }, 60_000);

  it("never replaces a newer local projection with the earlier selected checkpoint", async () => {
    const fixture = await staleProjection();
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, fixture.prior.runId));
    const before = await readFile(fixture.path, "utf8");
    expect(await fixture.followUp.start()).toBe("native_controller_recovery_missing_evidence:newer_progress_barrier");
    expect(await readFile(fixture.path, "utf8")).toBe(before);
    await fixture.assertBackup();
    expect(await archivedOwners(fixture.root)).toEqual([]);
  }, 60_000);

  it.each([false, true])("does not overwrite a current owner while waiting for its coordinator lock (external=%s)", async external => {
    const fixture = await staleProjection("codex", external);
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
      await lockSourceRecoveryCoordinators(tx, companyId, [fixture.latest.runId]);
      locked();
      await hold;
    });
    await acquired;
    const pending = fixture.followUp.start();
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
          and query like '%native_run_finalizations%' and query like '%for update%'
        ) as waiting`);
        waiting = rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const state = JSON.parse(fixture.originalBytes);
      state.identity.runId = fixture.followUp.runId;
      await writeFile(fixture.path, JSON.stringify(state));
      const currentBytes = await readFile(fixture.path, "utf8");
      release();
      await blocker;
      expect(await pending).toBe("native_runner_checkpoint_projection_held:journal_changed");
      expect(await readFile(fixture.path, "utf8")).toBe(currentBytes);
      await fixture.assertBackup();
      expect(await archivedOwners(fixture.root)).toEqual([]);
    } finally {
      release();
      await blocker;
      await pending;
    }
  }, 60_000);

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

  it.each(["created", "replacement"] as const)(
    "bootstraps again when a restart cut the follow-up off after it retired the finished owner: %s sandbox", async outcome => {
      const prior = await seedRecoveredPriorRun();
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      const root = await sessionRoot();
      expect(existsSync(join(root, "control-plane"))).toBe(false);
      expect(await archivedOwners(root)).toEqual([prior.runId]);
      followUp.logs.length = 0;
      expect(await followUp.start(outcome, { kind: "bootstrap_incomplete", runId: followUp.runId, leaseOwner: "successor",
        controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never)).toBe(ADMITTED);
      const [copy] = await quarantined();
      expect(copy).toMatch(/\.identity_indeterminate\./);
      expect(existsSync(join(stateDirectory, "quarantine", copy!, "continuity-breaks"))).toBe(true);
    }, 60_000);

  async function keepLocalRootWithoutPointer(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>) {
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    await rename(join(stateDirectory, "quarantine", copy!), join(stateDirectory, copy!.split(".")[0]!));
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
    const { nativeControllerRecovery: _pointer, ...profile } = run.runnerProfileJson!;
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, prior.runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
  }

  it.each(["recovery pointer", "local journal only"] as const)(
    "admits a follow-up in the process that finished the owner: %s", async evidence => {
      const prior = await seedRecoveredPriorRun("settled", { controller: await currentNativeControllerIdentity() });
      const followUp = await admitFollowUp(prior);
      if (evidence === "local journal only") await keepLocalRootWithoutPointer(prior, followUp);
      expect(await followUp.start()).toBe(ADMITTED);
      expect(await quarantined()).toEqual([]);
      expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
    }, 60_000);

  it("admits a local journal whose controller process has exited", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await keepLocalRootWithoutPointer(prior, followUp);
    expect(await followUp.start()).toBe(ADMITTED);
  }, 60_000);

  it.each(["another live controller", "an earlier controller in this process"] as const)(
    "keeps a local journal held while %s may still own it", async scenario => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
      try {
        await new Promise(resolve => child.once("spawn", resolve));
        const self = await currentNativeControllerIdentity();
        const startedAt = await readProcessStartedAt(child.pid!);
        expect(startedAt).toBeTruthy();
        const controller = scenario === "another live controller"
          ? { bootId: randomUUID(), pid: child.pid!, processStartedAt: new Date(startedAt!) }
          : { ...self, bootId: randomUUID() };
        const prior = await seedRecoveredPriorRun("settled", { controller });
        const followUp = await admitFollowUp(prior);
        await keepLocalRootWithoutPointer(prior, followUp);
        expect(await followUp.start()).toMatch(/; retirement_refused=controller_/);
        expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
      } finally {
        child.kill("SIGKILL");
      }
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
    expect(error).toBe(stranded("owner_observed"));
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

  // Staging shape: a warm Codex owner committed under a controller that a
  // deploy then replaced. The next run got a newly created sandbox, so the
  // prior Runner (left `ready` in its own retained sandbox) can never be
  // adopted here. The follow-up failed with
  // `prior_owner_terminal_state_indeterminate` and the task stayed blocked.
  it.each(["created", "replacement"] as const)(
    "retires a finished warm owner left behind by a restart when this run's sandbox is %s", async outcome => {
      const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
      expect(await quarantined()).toEqual([]);
      expect(followUp.logs.join("")).toContain("finished without a saved runner checkpoint; starting a new runner");
      expect(followUp.remoteExecute).not.toHaveBeenCalled();
    }, 60_000);

  it("keeps a finished warm owner for live adoption when this run resumed its sandbox", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    // A resumed sandbox still holds that Runner; its own recovery path reads it.
    expect(await followUp.start("resumed")).not.toBe(ADMITTED);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  it.each(["pending-command", "unanswered-tool"] as const)(
    "keeps a warm owner held when its journal is unsettled (%s), even on a new sandbox", async control => {
      const prior = await seedRecoveredPriorRun(control, { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start("created")).toMatch(/^runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=journal_/);
      expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    }, 60_000);

  it("keeps a warm owner held while its controller still holds the finalization lease", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, prior.runId));
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start("created")).not.toBe(ADMITTED);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
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
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100, eventType: "session.started",
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

  it.each([
    { control: "failed-turn-start", outcome: ADMITTED },
    { control: "rejected-turn-start", outcome: ADMITTED },
    { control: "indeterminate-turn-start", outcome: ADMITTED },
    { control: "unknown-outcome-turn-start", outcome: ADMITTED },
    { control: "unsuperseded-unknown-outcome-turn-start", outcome: stranded("journal_commands_unsettled(turn.start.failed)") },
    { control: "failed-suspend", outcome: stranded("journal_commands_unsettled(runner.suspend.failed)") },
  ] as const)("retires a finished owner whose journal holds an answered $control command", async ({ control, outcome }) => {
    const prior = await seedRecoveredPriorRun(control);
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(outcome);
  }, 60_000);

  it("starts a follow-up whose own bootstrap never reached its root from the previous owner's settled root", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    expect(await followUp.start("created", { kind: "bootstrap_incomplete", runId: followUp.runId, leaseOwner: "successor",
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never)).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
  }, 60_000);

  it.each([
    { label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { label: "released on another sandbox", status: "released", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { label: "still retained", status: "retained", sameSandbox: false, recorded: true,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
    { label: "ended on this sandbox", status: "expired", sameSandbox: true, recorded: true,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
    { label: "not recorded", status: "expired", sameSandbox: false, recorded: false,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
  ])("retires a finished remote owner whose suspend never finished when its sandbox lease is $label", async ({ status, sameSandbox, recorded, outcome }) => {
    const prior = await seedRecoveredPriorRun("pending-command");
    const followUp = await admitFollowUp(prior);
    if (recorded) {
      await db.insert(environments).values({ id: followUp.environmentId, name: `ended-${followUp.environmentId}`, driver: "sandbox" });
      await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
        heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: sameSandbox ? followUp.providerLeaseId : `sandbox-${prior.runId}`,
        status, releasedAt: status === "retained" ? null : new Date(), metadata: { remoteCwd: "/workspace" } });
    }
    expect(await followUp.start()).toBe(outcome);
  }, 60_000);

  // Staging PAP-4196 (run.attach) and PAP-3443 (semantic_tool.result): the
  // per-turn owner committed its result and its sandbox was destroyed after the
  // turn, but its journal still held a delivery that its Runner never
  // acknowledged. No process remains to receive it, so the follow-up retires
  // the owner. A Runner whose sandbox may still exist keeps the owner held.
  it.each([
    { control: "pending-attach", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: ADMITTED },
    { control: "pending-tool-result", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: ADMITTED },
    { control: "pending-attach", label: "still retained", status: "retained", sameSandbox: false, recorded: true,
      outcome: stranded("journal_commands_unsettled(run.attach.pending)") },
    { control: "pending-tool-result", label: "ended on this sandbox", status: "expired", sameSandbox: true, recorded: true,
      outcome: stranded("journal_commands_unsettled(semantic_tool.result.pending)") },
    { control: "pending-tool-result", label: "not recorded", status: "expired", sameSandbox: false, recorded: false,
      outcome: stranded("journal_commands_unsettled(semantic_tool.result.pending)") },
    { control: "unanswered-tool", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: stranded("journal_tool_input_unanswered") },
    // Staging: the owner parked on a durable question, so that
    // question's tool input is unanswered by design. Its Runner is gone.
    { control: "unanswered-tool", governedWait: true, label: "ended on another sandbox after a governed-wait park",
      status: "expired", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { control: "unanswered-tool", governedWait: true, label: "ended on this sandbox after a governed-wait park",
      status: "expired", sameSandbox: true, recorded: true, outcome: stranded("journal_tool_input_unanswered") },
  ] as const)("retires a finished remote owner with an unacknowledged $control when its sandbox lease $label",
    async ({ control, status, sameSandbox, recorded, outcome, ...rest }) => {
      const governedWait = "governedWait" in rest && rest.governedWait === true;
      const prior = await seedRecoveredPriorRun(control, { provider: "opencode", governedWait });
      const followUp = await admitFollowUp(prior);
      if (recorded) {
        await db.insert(environments).values({ id: followUp.environmentId, name: `ended-${followUp.environmentId}`, driver: "sandbox" });
        await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
          heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: sameSandbox ? followUp.providerLeaseId : `sandbox-${prior.runId}`,
          status, releasedAt: status === "retained" ? null : new Date(), metadata: { remoteCwd: "/workspace" } });
      }
      expect(await followUp.start()).toBe(outcome);
      if (outcome === ADMITTED) expect(followUp.logs.join("")).toContain("finished without a saved runner checkpoint");
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
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    expect(await quarantined()).toHaveLength(1);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toHaveLength(1);
  }, 60_000);

  it.each([
    { label: "an interrupted bootstrap that never opened its session", turnIssued: false, sessionOpened: false },
    { label: "a remote bootstrap that opened its session without a turn", turnIssued: false, sessionOpened: true },
    { label: "a bootstrap copy that already issued a turn", turnIssued: true, sessionOpened: false },
  ])("retires a finished owner past its own quarantined earlier bootstrap: $label", async ({ turnIssued, sessionOpened }) => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const copyRoot = join(stateDirectory, "quarantine", copy!);
    const path = join(copyRoot, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const bootstrap = state.commands.filter((command: { type: string }) => command.type === "run.prepare" || command.type === "session.open"
      || (turnIssued && command.type === "turn.start"));
    for (const command of bootstrap) {
      command.status = command.type === "run.prepare" || (sessionOpened && command.type === "session.open") ? "completed" : "pending";
    }
    const opened = sessionOpened ? ["session.started", "session.capabilities.updated"].map((eventType, index) => ({
      sourceSeq: index + 1, sourceEventId: `opened-${index + 1}`, eventType, priority: 1, envelope: { ...prior.identity },
      deliveryCount: 1, logicalEffectCount: 1 })) : [];
    await writeFile(path, JSON.stringify({ ...state, commands: bootstrap, committedEvents: opened, ackedSourceSeq: opened.length }));
    await rm(join(copyRoot, "runner"), { recursive: true, force: true });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(turnIssued
      ? stranded("quarantine_journal_commands_unsettled(session.open.pending,turn.start.pending)") : ADMITTED);
  }, 60_000);

  it("keeps an unsuspended Runner receipt decisive after a retry rebuilds the root", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    // Learn the scope key from a held attempt, then give the active root the
    // local evidence of an owner whose Runner never suspended.
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await mkdir(join(root, "runner"));
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...prior.identity }));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("runner_lifecycle_not_suspended"));
    expect(await quarantined()).toHaveLength(1);
    // The retry restores only the database journal. The quarantined receipt
    // must still hold it.
    expect(await followUp.start()).toBe(stranded("quarantine_runner_lifecycle_not_suspended"));
    expect(await quarantined()).toHaveLength(2);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  /** Learn the scope key from a held attempt and restore its root as the
   * live session root, as it stands after the prior turn finished. */
  async function restoreHeldRoot(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>) {
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    return root;
  }

  // A continued turn's transport leaves these in the controller root: the
  // runtime context it wrote before launch, and the settled epoch it archived
  // when it rotated authority from the turn before it (S49: the third turn of
  // an ephemeral-lease task could never retire the second turn's owner).
  it("retires a finished owner whose continued turn left runtime context and an archived authority epoch", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await writeFile(join(root, "runtime-context.json"), "{}\n", { mode: 0o600 });
    const epoch = join(root, "authority-epochs", "epoch-0123456789abcdef01234567");
    await mkdir(join(epoch, "control-plane"), { recursive: true, mode: 0o700 });
    await cp(join(root, "control-plane", "control-plane-state.json"), join(epoch, "control-plane", "control-plane-state.json"));
    await writeFile(join(epoch, "runner-state.json"), "{}\n", { mode: 0o600 });
    await mkdir(join(root, "diagnostics"), { mode: 0o700 });
    // The launch preparation saved for the retired identity.
    const preparation = JSON.stringify({ schema: "paperclip.runner.launch-preparation-store.v1", entries: [] });
    await writeFile(join(root, "launch-preparation.json"), preparation, { mode: 0o600 });
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    // Archived epochs belong to the retired lineage; launch inputs stay.
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(existsSync(join(root, "continuity-breaks", archive!, "authority-epochs", "epoch-0123456789abcdef01234567"))).toBe(true);
    expect(existsSync(join(root, "authority-epochs"))).toBe(false);
    expect(await readFile(join(root, "continuity-breaks", archive!, "launch-preparation.json"), "utf8")).toBe(preparation);
    expect(existsSync(join(root, "launch-preparation.json"))).toBe(false);
    expect(existsSync(join(root, "runtime-context.json"))).toBe(true);
    expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
  }, 60_000);

  it("keeps a finished owner held by an unclassified root entry and names it", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await writeFile(join(root, "unrecognized-state"), "{}\n");
    expect(await followUp.start()).toBe(stranded("unexpected_root_entry(unrecognized-state)"));
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  it("keeps a finished owner held by a provider checkpoint and names it as held", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await mkdir(join(root, "cursor-cloud"), { mode: 0o700 });
    await writeFile(join(root, "unrecognized-state"), "{}\n");
    expect(await followUp.start()).toBe(stranded("held_root_entry(cursor-cloud)"));
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  /** A spawned process that stands in for the prior local Runner. */
  async function runnerProcess() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    await new Promise(resolve => child.once("spawn", resolve));
    const startedAt = await readProcessStartedAt(child.pid!);
    expect(startedAt).toBeTruthy();
    return { child, pid: child.pid!, processStartedAt: new Date(startedAt!) };
  }

  async function stoppedRunnerProcess() {
    const runner = await runnerProcess();
    const exited = new Promise(resolve => runner.child.once("exit", resolve));
    runner.child.kill("SIGKILL");
    await exited;
    return runner;
  }

  /** The state a local per-turn Runner leaves when its result was accepted but
   * its suspend command never finished: the controller journal holds a pending
   * runner.suspend and the Runner's own receipt is still `ready`. */
  async function seedUnsuspendedLocalOwner(runner: { pid: number; processStartedAt: Date }) {
    const prior = await seedRecoveredPriorRun("pending-command");
    await db.update(heartbeatRuns).set({ processPid: runner.pid, processGroupId: runner.pid, processStartedAt: runner.processStartedAt })
      .where(eq(heartbeatRuns.id, prior.runId));
    const followUp = await admitFollowUp(prior);
    // Learn the scope key from a held attempt, then keep its root in place.
    expect(await followUp.start()).toMatch(/^runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate/);
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    await mkdir(join(root, "runner"), { recursive: true });
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...prior.identity }));
    return { prior, followUp, root };
  }

  it.each(["exited", "alive", "another owner"] as const)(
    "skips a local quarantined bootstrap that opened a session only when it is this owner's and its processes %s",
    async scenario => {
      const runner = scenario === "alive" ? await runnerProcess() : await stoppedRunnerProcess();
      const root = await mkdtemp(join(tmpdir(), "quarantined-opened-bootstrap-"));
      const identity = { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "owner-run",
        normalizedSessionId: "session-1", turnId: "turn-owner-run", itemId: "item-owner-run" };
      try {
        await mkdir(join(root, "control-plane"), { recursive: true, mode: 0o700 });
        await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
        await writeFile(join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
          schema: "paperclip.runner.durable.control-plane-state.v2", identity,
          bootstrapHistory: { schema: "paperclip.runner.bootstrap-history.v1", originIdentity: identity, credentialsIssued: 1, adopted: false },
          commands: [
            { commandId: "prepare", type: "run.prepare", status: "completed", result: { status: "prepared" } },
            { commandId: "open", type: "session.open", status: "completed", result: { result: { status: "started", processId: runner.pid } } },
          ],
          committedEvents: [{ sourceSeq: 1, sourceEventId: "opened-1", eventType: "session.started", priority: 1, envelope: identity }],
          ackedSourceSeq: 1, connectionCount: 1 }));
        await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
          ...identity, lifecycle: "ready", outbox: [], processedCommands: {
            prepare: { commandType: "run.prepare", status: "completed", result: { status: "prepared" } },
            open: { commandType: "session.open", status: "completed", result: { status: "started", processId: runner.pid } } } }));
        const owner = scenario === "another owner" ? { ...identity, runId: "another-run" } : identity;
        expect(quarantinedBootstrapOfOwnerHeldNoProviderWork(root, owner, true)).toBe(scenario === "exited");
      } finally {
        if (scenario === "alive") runner.child.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  it.each([
    { label: "never delivered to a dead runner", connectionCount: 0, claim: true, admitted: true, archiveOnly: false },
    { label: "possibly delivered", connectionCount: 1, claim: true, admitted: false, archiveOnly: false },
    { label: "without a dead-runner claim", connectionCount: 0, claim: false, admitted: false, archiveOnly: false },
    { label: "cut off before its new control plane was written", connectionCount: 0, claim: true, admitted: true, archiveOnly: true },
    { label: "cut off before its new control plane, without a dead-runner claim", connectionCount: 0, claim: false, admitted: false,
      archiveOnly: true },
  ])("resumes from the previous turn when a warm attach rotation was $label", async ({ connectionCount, claim, admitted, archiveOnly }) => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    const priorIdentity = JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")).identity;
    const epoch = join(root, "authority-epochs",
      `epoch-${createHash("sha256").update(JSON.stringify(priorIdentity)).digest("hex").slice(0, 24)}`);
    await mkdir(epoch, { recursive: true, mode: 0o700 });
    await rename(join(root, "control-plane"), join(epoch, "control-plane"));
    await writeFile(join(epoch, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...priorIdentity,
      lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null }));
    await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "runner", "codex-provider-state.json"), "{}");
    const identity = { ...priorIdentity, runId: followUp.runId, turnId: `turn-${followUp.runId}`, itemId: `item-${followUp.runId}` };
    if (!archiveOnly) await mkdir(join(root, "control-plane"), { mode: 0o700 });
    const undelivered = JSON.stringify({ schema: "paperclip.runner.durable.control-plane-state.v2", identity,
      bootstrapHistory: { schema: "paperclip.runner.bootstrap-history.v1", originIdentity: identity, credentialsIssued: 0, adopted: false },
      runAttachTemplate: {}, tickets: {}, leases: {},
      commands: [{ commandId: "attach", controllerSeq: 1, type: "run.attach", status: "pending", payload: {} }],
      committedEvents: [], ackedSourceSeq: 0, connectionCount, commandDeliveryCounts: {} });
    if (!archiveOnly) await writeFile(join(root, "control-plane", "control-plane-state.json"), undelivered);
    const outcome = await followUp.startLocal(claim ? { kind: "resume_dead_runner", runId: followUp.runId, leaseOwner: "successor",
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never : undefined);
    if (!admitted) {
      expect(outcome).toBe(archiveOnly ? "runner_state_identity_mismatch: durable_identity_unreadable"
        : "runner_state_identity_mismatch: authority_indeterminate");
      return;
    }
    expect(outcome).toBe(ADMITTED);
    expect(JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")).identity).toEqual(priorIdentity);
    expect(existsSync(join(root, "authority-epochs"))).toBe(false);
    if (archiveOnly) {
      expect(existsSync(join(root, "continuity-breaks"))).toBe(false);
      expect(await quarantined()).toEqual([]);
      return;
    }
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(await readFile(join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json"), "utf8")).toBe(undelivered);
    expect(await quarantined()).toEqual([]);
    expect(followUp.logs.join("")).toContain("stopped before its runner received the session");
  }, 60_000);

  it("retires a finished local owner whose Runner stopped before it proved suspension", async () => {
    const { prior, followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    expect(await followUp.startLocal()).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(existsSync(join(root, "runner"))).toBe(false);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
  }, 60_000);

  it("keeps a finished local owner held while its recorded Runner process is alive", async () => {
    const runner = await runnerProcess();
    try {
      const { followUp } = await seedUnsuspendedLocalOwner(runner);
      expect(await followUp.startLocal()).toBe(stranded("runner_process_alive"));
      expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    } finally {
      runner.child.kill("SIGKILL");
    }
  }, 60_000);

  it.each(["no identity", "no process group"] as const)("keeps a finished local owner held with %s", async scenario => {
    const { prior, followUp } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    await db.update(heartbeatRuns).set(scenario === "no identity"
      ? { processPid: null, processGroupId: null, processStartedAt: null } : { processGroupId: null })
      .where(eq(heartbeatRuns.id, prior.runId));
    expect(await followUp.startLocal()).toBe(stranded("runner_process_identity_missing"));
  }, 60_000);

  it("retires a finished local owner from its saved stop receipt after settlement cleared the process fields", async () => {
    const runner = await stoppedRunnerProcess();
    const { prior, followUp, root } = await seedUnsuspendedLocalOwner(runner);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: prior.runId, seq: 900, eventType: "native.local_process_stopped",
      stream: "system", payload: { processPid: runner.pid, processGroupId: runner.pid, processStartedAt: runner.processStartedAt.toISOString() } });
    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null, processStartedAt: null })
      .where(eq(heartbeatRuns.id, prior.runId));
    expect(await followUp.startLocal()).toBe(ADMITTED);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
  }, 60_000);

  it("keeps a stopped local owner held while a provider process from its run events is alive", async () => {
    const provider = await runnerProcess();
    try {
      const { prior, followUp } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: prior.runId, seq: 901, eventType: "provider.event",
        stream: "system", payload: { prpEvent: { payload: { processId: provider.pid,
          processStartedAt: provider.processStartedAt.toISOString() } } } });
      expect(await followUp.startLocal()).toBe(stranded("provider_process_alive"));
    } finally {
      provider.child.kill("SIGKILL");
    }
  }, 60_000);

  it("keeps a stopped local owner held by an unfinished non-lifecycle command", async () => {
    const { followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    const path = join(root, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.commands.find((command: { type: string }) => command.type === "turn.start").status = "pending";
    await writeFile(path, JSON.stringify(state));
    expect(await followUp.startLocal()).toBe(stranded("journal_commands_unsettled(turn.start.pending)"));
  }, 60_000);

  it("keeps a stopped local owner held by an unacknowledged run.attach", async () => {
    // Only a remote Runner whose sandbox lease ended elsewhere is gone by record.
    const { followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    const path = join(root, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.commands.push({ ...state.commands.at(-1), commandId: "command_unacknowledged_attach",
      controllerSeq: state.commands.length + 1, type: "run.attach", status: "pending", result: null });
    await writeFile(path, JSON.stringify(state));
    expect(await followUp.startLocal()).toBe(stranded("journal_commands_unsettled(run.attach.pending)"));
  }, 60_000);

  it.each(["uncommitted result", "committed without result", "live controller lease", "unexpired controller lease", "recovery pending", "pending command",
    "unanswered tool input", "foreign quarantine"] as const)("keeps the prior owner held with %s", async scenario => {
    const prior = await seedRecoveredPriorRun(scenario === "pending command" ? "pending-command"
      : scenario === "unanswered tool input" ? "unanswered-tool" : "settled");
    const followUp = await admitFollowUp(prior);
    let expectedQuarantine = 1;
    if (scenario === "uncommitted result") {
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", resultId: null })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "committed without result") {
      await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, prior.runId));
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
      expect(await followUp.start()).toBe(stranded("owner_observed"));
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
    // A live owner is still waited for before any projection is rebuilt. Every
    // other hold names its failed proof instead of one indeterminate state.
    expect(outcome).toBe({
      "uncommitted result": stranded("owner_retryable_failure"),
      "committed without result": stranded("owner_result_missing"),
      "live controller lease": "native_controller_recovery_waiting_for_owner",
      "unexpired controller lease": stranded("controller_remote_controller_lease_live"),
      "recovery pending": stranded("owner_recovery_resuming_session"),
      "pending command": stranded("journal_commands_unsettled(runner.suspend.pending)"),
      "unanswered tool input": stranded("journal_tool_input_unanswered"),
      "foreign quarantine": stranded("quarantine_journal_identity_mismatch"),
    }[scenario]);
    expect(await quarantined()).toHaveLength(scenario === "live controller lease" ? 0 : expectedQuarantine);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);
});
