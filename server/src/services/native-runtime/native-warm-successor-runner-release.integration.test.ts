import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { completionContracts, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-process-start-events.js";

type ProviderTransport = ReturnType<NonNullable<NonNullable<Parameters<typeof import("../../vendor/paperclip-runner/index.js").createNativeSessionBackend>[1]>["codexTransportFactory"]>>;
const { FakeCodexTransport } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.ts", import.meta.url).href) as { FakeCodexTransport: new () => ProviderTransport };
const { runnerdRecoveryInternals } = await import(new URL("../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts", import.meta.url).href) as {
  runnerdRecoveryInternals: { releaseRunnerProcessOwnership(input: { runnerSettled: boolean; checkpoint: typeof state.checkpoint;
    release: () => Promise<void>; forceKill: () => Promise<void> }): Promise<void> };
};

const state = vi.hoisted(() => ({ execute: vi.fn(), checkpoint: null as null | ((settlement: "settled" | "unsettled") => Promise<void>), storage: null as unknown, transport: null as unknown }));
vi.mock("./native-harness-backup-storage.js", async original => ({
  ...await original<typeof import("./native-harness-backup-storage.js")>(),
  durableNativeHarnessStorage: () => state.storage,
}));
vi.mock("./native-runner-execution-driver.js", async original => {
  const actual = await original<typeof import("./native-runner-execution-driver.js")>();
  return { ...actual, createNativeRunnerExecutionDriver: (input: Parameters<typeof actual.createNativeRunnerExecutionDriver>[0]) => {
    if (input.checkpoint) state.checkpoint = input.checkpoint as typeof state.checkpoint;
    return actual.createNativeRunnerExecutionDriver(input);
  } };
});
vi.mock("../../vendor/paperclip-runner/index.js", async original => {
  const actual = await original<typeof import("../../vendor/paperclip-runner/index.js")>();
  return { ...actual, executeNativeSession: state.execute,
    createNativeSessionBackend: (input: Parameters<typeof actual.createNativeSessionBackend>[0], options: Parameters<typeof actual.createNativeSessionBackend>[1]) => {
      options?.codexTransportFactory?.();
      return actual.createNativeSessionBackend(input, { ...options, codexTransportFactory: () => state.transport as ProviderTransport });
    } };
});
import { closeIdleWarmNativeSessionsForRestart, closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession,
  readNativeSessionIdleWork } from "./native-session-executor.js";
import { assertNativeRunnerCheckpointOwner } from "./native-runner-checkpoint.js";

type Successor = "own_runner" | "owner_clock_ahead" | "own_runner_resumed" | "own_runner_reconciled" | "other_sandbox" | "start_requested_only" | "inherited_events" | "events_before_owner_finished";

describeEmbeddedPostgres("idle warm owner superseded by a successor's Runner", () => {
  const environment = nativeRestartFixture();
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "warm-successor-runner-")); });
  afterAll(async () => { state.storage = null; await rm(root, { recursive: true, force: true }); });

  async function idleOwnerSupersededBySuccessor(label: string, successorKind: Successor, idleTimeoutMs: number) {
    const fixture = await environment.seedRun(label);
    const { companyId, agentId } = environment.current;
    const [contract] = await fixture.db.select().from(completionContracts).where(eq(completionContracts.issueId, fixture.issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, agentId, issueId: fixture.issueId, runId: fixture.runId, executionWorkspaceId: randomUUID() },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: "WARM-2", title: "Idle warm owner", description: null, prompt: "Finish and stay warm.", workMode: "standard" },
      workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: { ...contract.contractJson, revision: String(contract.revision) } } as NativeExecutionInputV1["completionContract"],
      interactionResponses: [], credentialBindings: [],
    };
    state.storage = createStorageService(createLocalDiskStorageProvider(join(root, "objects")));
    const transport = new FakeCodexTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params) => {
      const response = await request(method, params);
      return method === "thread/start" || method === "thread/resume"
        ? { ...response, cwd: root, thread: { ...response.thread as Record<string, unknown>, cwd: root } }
        : response;
    };
    state.transport = transport;
    const closeFailures: string[] = [];
    transport.close = async () => {
      try {
        await runnerdRecoveryInternals.releaseRunnerProcessOwnership({ runnerSettled: false,
          checkpoint: state.checkpoint, release: async () => {}, forceKill: async () => {} });
      } catch (error) { closeFailures.push(String(error)); throw error; }
    };
    state.execute.mockReset().mockImplementation(async options => {
      const session = await options.backend.openSession({ identity: { companyId, agentId, issueId: fixture.issueId,
        runId: fixture.runId, sessionId: execution.session.normalizedSessionId }, workingDirectory: root });
      await options.onSession(session);
      await options.controlPlane.openRun({ identity: { companyId, agentId, issueId: fixture.issueId, runId: fixture.runId,
        sessionId: execution.session.normalizedSessionId }, backendKind: "mock", sourceInstanceId: fixture.native.runnerInstanceId });
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT,
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: execution.completionContract.contract.revision } };
      await options.controlPlane.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: fixture.native.turnId });
      return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: fixture.native.turnId, normalizedSessionId: execution.session.normalizedSessionId,
        providerSessionId: "owner-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 0, highestContiguousSourceSeq: 0, usage: null };
    });
    const environmentId = randomUUID();
    const providerLeaseId = randomUUID();
    await fixture.db.insert(environments).values({ id: environmentId, name: `Sandbox ${label}`, driver: "sandbox" });
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.preparedProfile, nativeExecutionInput: execution } })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const owner = await executePaperclipNativeSession({ db: fixture.db, execution, runnerInstanceId: fixture.native.runnerInstanceId,
      useRunnerd: true, runnerIngressAuthorized: true,
      runnerRemoteBinaryPath: defaultCapabilityRunnerdBinary(), runnerRemoteCodexPath: defaultCapabilityRunnerdBinary(),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: root, environmentId,
        leaseId: randomUUID(), providerKey: "fixture", effectiveCapabilities: { runnerWebSocketIngress: true },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId },
        runner: { execute: async (command: { args?: string[] }) => command.args?.[1] === "uname -s; uname -m"
          ? { exitCode: 0, timedOut: false, stdout: `${process.platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "arm64" ? "arm64" : "x86_64"}\n`, stderr: "" }
          : command.args?.[2] === "paperclip-runner-port-holders"
            ? { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
            : { exitCode: 1, timedOut: false, stdout: "", stderr: "" }, syncIn: async () => {} } } as never,
      instructionWorkingCopy: { runId: fixture.runId, root, checkpointWarm: async () => true, collectStopped: async () => {}, hasChanges: async () => false },
    });
    expect(owner.exitCode).toBe(0);
    expect(readNativeSessionIdleWork()).toBe("present");
    await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 1_000_000, eventType: "turn.completed",
      sourceInstanceId: fixture.native.runnerInstanceId, sourceEventId: `owner-terminal-${fixture.runId}`, sourceSeq: 1_000_000 });
    const ownerFinishedAt = new Date(Date.now() + (successorKind === "owner_clock_ahead" ? 10 * 60_000 : -1_000));
    await fixture.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ownerFinishedAt }).where(eq(heartbeatRuns.id, fixture.runId));
    const [finalized] = await fixture.db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, fixture.runId)).returning();
    expect(finalized.resultId).not.toBeNull();
    const successorRunId = randomUUID(), successorRunner = randomUUID();
    await fixture.db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: fixture.issueId, invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: fixture.issueId },
      runnerInstanceId: successorRunner, startedAt: new Date() });
    await fixture.db.update(issues).set({ executionRunId: successorRunId }).where(eq(issues.id, fixture.issueId));
    await fixture.db.insert(nativeRunFinalizations).values({ runId: successorRunId, companyId, issueId: fixture.issueId, phase: "observed",
      controllerBootId: randomUUID() });
    await fixture.db.insert(environmentLeases).values({ companyId, environmentId, issueId: fixture.issueId, heartbeatRunId: successorRunId,
      status: "active", leasePolicy: "reuse_by_environment", provider: "fixture",
      providerLeaseId: successorKind === "other_sandbox" ? randomUUID() : providerLeaseId });
    const eventAt = successorKind === "events_before_owner_finished" ? new Date(Date.now() - 60_000) : undefined;
    await fixture.db.insert(heartbeatRunEvents).values([
      { companyId, runId: successorRunId, agentId, seq: 1, createdAt: eventAt,
        eventType: successorKind === "start_requested_only" ? PROCESS_START_REQUESTED : PROCESS_IDENTITY_RECORDED,
        sourceEventId: successorKind === "inherited_events" ? `inherited-${randomUUID()}` : null },
      { companyId, runId: successorRunId, agentId, seq: 2, createdAt: eventAt,
        eventType: successorKind === "own_runner_resumed" ? "session.resumed" : successorKind === "own_runner_reconciled" ? "session.reconciled" : "session.started",
        sourceInstanceId: successorRunner, sourceEventId: `session-${successorRunId}`, sourceSeq: 1 },
    ]);
    return {
      closeFailures,
      ownerCheckpoints: () => fixture.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, fixture.runId)),
      assertOwner: () => fixture.db.transaction(tx => assertNativeRunnerCheckpointOwner(tx, { companyId, issueId: fixture.issueId,
        runId: fixture.runId, authorityRunId: fixture.runId, bootId: finalized.controllerBootId!, generation: finalized.controllerGeneration,
        leaseOwner: "" }, false)),
      release: async () => {
        await fixture.db.update(issues).set({ executionRunId: null, status: "done" }).where(eq(issues.id, fixture.issueId));
        await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "fixture cleanup" });
      },
    };
  }

  it.each<{ successor: Successor; released: boolean }>([
    { successor: "own_runner", released: true },
    { successor: "own_runner_resumed", released: true },
    { successor: "owner_clock_ahead", released: true },
    { successor: "own_runner_reconciled", released: false },
    { successor: "other_sandbox", released: false },
    { successor: "start_requested_only", released: false },
    { successor: "inherited_events", released: false },
    { successor: "events_before_owner_finished", released: false },
  ])("releases an idle warm owner whose checkpoint is refused because a successor on another server launched its own Runner on the same sandbox: $successor", async ({ successor, released }) => {
    const owner = await idleOwnerSupersededBySuccessor(`WARM-PORT-SUCCESSOR-${successor}`, successor, 60_000);
    try {
      const closed = await closeIdleWarmNativeSessionsForRestart();
      expect(owner.closeFailures).toEqual(["Error: native_runner_checkpoint_owner_lost"]);
      if (released) expect(closed).toEqual({ closed: 1, busy: 0, failed: 0, failures: [] });
      else expect(closed).toMatchObject({ closed: 0, busy: 0, failed: 1 });
      expect(readNativeSessionIdleWork()).toBe(released ? "none" : "present");
      expect(await owner.ownerCheckpoints()).toEqual([]);
      await expect(owner.assertOwner()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally {
      await owner.release();
    }
    expect(readNativeSessionIdleWork()).toBe("none");
  }, 45_000);

  it("releases a superseded idle warm owner from its idle timer without writing a checkpoint", async () => {
    const owner = await idleOwnerSupersededBySuccessor("WARM-PORT-SUCCESSOR-IDLE", "own_runner", 2_000);
    try {
      await vi.waitFor(() => expect(readNativeSessionIdleWork()).toBe("none"), { timeout: 10_000, interval: 100 });
      expect(owner.closeFailures).toEqual(["Error: native_runner_checkpoint_owner_lost"]);
      expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 0, busy: 0, failed: 0, failures: [] });
      expect(await owner.ownerCheckpoints()).toEqual([]);
      await expect(owner.assertOwner()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally {
      await owner.release();
    }
  }, 45_000);
});
