import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";
import { defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";

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
import { closeWarmNativeSessionsForEnvironment, detachNativeSessionsForRestart, executePaperclipNativeSession, NativeControllerDetachedForRestartError } from "./native-session-executor.js";
import * as executionLease from "./native-execution-lease.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";

describeEmbeddedPostgres("managed warm checkpoint ownership", () => {
  const environment = nativeRestartFixture();
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "warm-checkpoint-owner-")); });
  afterAll(async () => { state.storage = null; await rm(root, { recursive: true, force: true }); });

  it.each(["normal", "delayed", "instruction_error", "fresh_successor", "wrong_boot", "superseded_owner", "detach_during_close", "detach_during_instruction_error", "detach_during_instruction_error_and_renewal_loss"])("keeps the producing coordinator claim until the managed failed-turn close joins: %s", async scenario => {
    let fixture: Omit<Awaited<ReturnType<typeof environment.seedRun>>, "runId"> & { runId: string } = await environment.seedRun(`WARM-CHECKPOINT-OWNER-${scenario}`);
    const { companyId, agentId } = environment.current;
    const [contract] = await fixture.db.select().from(completionContracts).where(eq(completionContracts.issueId, fixture.issueId));
    let execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, agentId, issueId: fixture.issueId, runId: fixture.runId, executionWorkspaceId: randomUUID() },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: "WARM-1", title: "Retain checkpoint owner", description: null, prompt: "Return a failed turn.", workMode: "standard" },
      workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
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
    const ownersAtClose: Array<{ phase: string; leaseOwner: string | null; resultId: string | null; leaseExpiresAt: Date | null }> = [];
    const initiatingError = new Error("fixture instruction checkpoint failed private-canary-N45");
    const invalidated = scenario === "wrong_boot" || scenario === "superseded_owner";
    const renewalLoss = scenario === "detach_during_instruction_error_and_renewal_loss";
    const instructionErrorWithDetach = scenario.startsWith("detach_during_instruction_error");
    let originalBoot: string | null = null;
    let replacementOwner: string | null = null;
    let enteredClose!: () => void, releaseClose!: () => void;
    const closeEntered = new Promise<void>(resolve => { enteredClose = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const detached = vi.fn(async () => {});
    Object.assign(transport, { detachControllerForRestart: detached });
    const renew = executionLease.startNativeSessionExecutionLeaseRenewal;
    let renewalStopped = false;
    const renewal = vi.spyOn(executionLease, "startNativeSessionExecutionLeaseRenewal").mockImplementation(input => {
      const owned = renew(input);
      return { ...owned, stop: async () => { renewalStopped = true; await owned.stop(); } };
    });
    transport.close = async () => {
      const [owner] = await fixture.db.select({ phase: nativeRunFinalizations.phase, leaseOwner: nativeRunFinalizations.leaseOwner,
        resultId: nativeRunFinalizations.resultId, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      ownersAtClose.push(owner);
      expect(renewalStopped).toBe(false);
      if (scenario === "detach_during_close") { enteredClose(); await closeGate; }
      if (scenario === "delayed") {
        await expect.poll(async () => {
          const [current] = await fixture.db.select({ expires: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fixture.runId));
          return current.expires!.getTime();
        }, { timeout: 25_000, interval: 250 }).toBeGreaterThan(owner.leaseExpiresAt!.getTime() + 10_000);
        expect(renewalStopped).toBe(false);
      }
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
      await options.controlPlane.appendEvent({ schema: "paperclip.prp.event.v1", runId: fixture.runId,
        normalizedSessionId: execution.session.normalizedSessionId, turnId: fixture.native.turnId,
        sourceInstanceId: fixture.native.runnerInstanceId, sourceEventId: "provider-overload", sourceSeq: 1,
        sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
        payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded" } } });
      const terminal = { schema: "paperclip.prp.terminal.v1", runTerminalState: "failed", turnTerminalState: "failed", reportedWorkDisposition: "needs_review" };
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review",
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: execution.completionContract.contract.revision } };
      await options.controlPlane.completeRun({ result, terminal, turnId: fixture.native.turnId });
      return { result, terminal, turnId: fixture.native.turnId, normalizedSessionId: execution.session.normalizedSessionId,
        providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const environmentId = randomUUID();
    let acquisition: "created" | "resumed" = "created";
    const providerLeaseId = randomUUID();
    const runCurrent = async () => {
      await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.preparedProfile, nativeExecutionInput: execution } })
        .where(eq(heartbeatRuns.id, fixture.runId));
      return executePaperclipNativeSession({ db: fixture.db, execution, runnerInstanceId: fixture.native.runnerInstanceId,
        useRunnerd: true, runnerIngressAuthorized: true,
        runnerRemoteBinaryPath: defaultCapabilityRunnerdBinary(), runnerRemoteCodexPath: defaultCapabilityRunnerdBinary(),
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: root, environmentId,
          leaseId: randomUUID(), providerKey: "fixture", effectiveCapabilities: { runnerWebSocketIngress: true },
          sandboxLeaseAcquisition: { outcome: acquisition, providerLeaseId },
          runner: { execute: async (command: { args?: string[] }) => command.args?.[1] === "uname -s; uname -m"
            ? { exitCode: 0, timedOut: false, stdout: `${process.platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "arm64" ? "arm64" : "x86_64"}\n`, stderr: "" }
            : { exitCode: 1, timedOut: false, stdout: "", stderr: "" }, syncIn: async () => {} } } as never,
        instructionWorkingCopy: { runId: fixture.runId, root, checkpointWarm: async () => {
          if (instructionErrorWithDetach) { enteredClose(); await closeGate; throw initiatingError; }
          if (scenario === "instruction_error") throw initiatingError;
          if (invalidated) {
            const [current] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
            originalBoot = current.controllerBootId;
            replacementOwner = scenario === "superseded_owner" ? randomUUID() : current.leaseOwner;
            await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), leaseOwner: replacementOwner,
              controllerGeneration: current.controllerGeneration + 1 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
          }
          return true;
        },
          collectStopped: async () => {}, hasChanges: async () => false },
      });
    };
    let running: ReturnType<typeof runCurrent> | undefined;
    try {
      running = runCurrent();
      if (scenario.startsWith("detach_during_")) {
        await Promise.race([closeEntered, running.then(() => { throw new Error("fixture checkpoint was not reached"); })]);
        expect(renewalStopped).toBe(false);
        const [beforeDetach] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        const detach = await detachNativeSessionsForRestart([fixture.runId]);
        expect(detach).toEqual({ detachedRunIds: [fixture.runId], inactiveRunIds: [], unsupportedRunIds: [], pendingRunIds: [] });
        expect(detached).toHaveBeenCalledOnce();
        const [held] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        expect(held).toMatchObject({ phase: "workspace_finalizing", leaseOwner: beforeDetach.leaseOwner, resultId: beforeDetach.resultId });
        if (renewalLoss) {
          originalBoot = held.controllerBootId;
          replacementOwner = randomUUID();
          await fixture.db.update(nativeRunFinalizations).set({ leaseOwner: replacementOwner,
            controllerGeneration: held.controllerGeneration + 1 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
          await expect.poll(() => renewal.mock.results[0].value.remainingMs(), { timeout: 25_000, interval: 250 }).toBe(0);
        }
        releaseClose();
        await expect(running).rejects.toBeInstanceOf(NativeControllerDetachedForRestartError);
        const failure = await running.catch(error => error);
        expect(failure).toMatchObject({ diagnostic: { stage: "post_result_cleanup",
          postExecutionCleanupFailed: instructionErrorWithDetach, renewalStopFailed: renewalLoss } });
        expect(failure).not.toHaveProperty("cause");
        expect(JSON.stringify(failure)).not.toContain("private-canary-N45");
      } else if (invalidated) await expect(running).rejects.toThrow("native_session_lease_lost");
      else if (scenario === "instruction_error") await expect(running).rejects.toBe(initiatingError);
      else {
        const result = await running;
        expect(result.exitCode).toBe(1);
        expect(result.errorCode).toBe("native_provider_overloaded");
      }
      expect(state.checkpoint).toBeTypeOf("function");
      if (invalidated) expect(closeFailures).toEqual(["Error: native_harness_storage_owner_missing"]);
      else expect(closeFailures).toEqual([]);
      expect(ownersAtClose).toHaveLength(1);
      expect(ownersAtClose[0].leaseOwner).not.toBeNull();
      expect(renewalStopped).toBe(true);
      const [released] = await fixture.db.select({ leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(released.leaseOwner).toBe(invalidated || renewalLoss ? replacementOwner : scenario.startsWith("detach_during_") ? ownersAtClose[0].leaseOwner : null);
      expect(state.execute).toHaveBeenCalledTimes(1);
      if (scenario.startsWith("detach_during_")) {
        const rows = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, fixture.issueId));
        expect(rows).toHaveLength(1);
        expect(rows[0].resultJson).not.toHaveProperty("nativeCancellation");
      }
      if (scenario === "fresh_successor") {
        await fixture.db.update(heartbeatRuns).set({ responsibleUserId: "local-capacity-owner" }).where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.update(issues).set({ responsibleUserId: "local-capacity-owner" }).where(eq(issues.id, fixture.issueId));
        await finalizeNativeRun({ db: fixture.db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        const [retry] = await fixture.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, fixture.runId)));
        expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "native_provider_overloaded", contextSnapshot: { forceFreshSession: true } });
        const unexpected = async () => { throw new Error("unexpected fixture escalation"); };
        const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(fixture.db, {
          resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
          recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected } });
        expect((await release({ companyId, runId: fixture.runId, now: new Date() })).outcome.kind).toBe("released");
        const [ready] = await fixture.db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: fixture.issueId })
          .where(eq(heartbeatRuns.id, retry.id)).returning();
        await fixture.db.update(issues).set({ executionRunId: retry.id }).where(eq(issues.id, fixture.issueId));
        const [task] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
        const native = await prepareNativeHeartbeatRun({ db: fixture.db, run: ready, issue: task, environmentLeaseId: randomUUID() });
        await fixture.db.insert(nativeRunFinalizations).values({ runId: retry.id, companyId, issueId: fixture.issueId, phase: "observed" });
        const previousSession = execution.session.normalizedSessionId;
        execution = { ...execution, binding: { ...execution.binding, runId: retry.id }, session: { ...execution.session, normalizedSessionId: native.normalizedSessionId } };
        expect(execution.session.normalizedSessionId).not.toBe(previousSession);
        fixture = { ...fixture, runId: retry.id, native };
        acquisition = "resumed";
        renewalStopped = false;
        const second = await runCurrent();
        expect(second.errorCode).toBe("native_provider_overloaded");
        expect(state.execute).toHaveBeenCalledTimes(2);
        expect(ownersAtClose).toHaveLength(2);
        expect(closeFailures).toEqual([]);
      }
    } finally {
      releaseClose();
      await running?.catch(() => undefined);
      if (invalidated || renewalLoss) await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: originalBoot, phase: "committed",
        leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "fixture cleanup" });
      renewal.mockRestore();
    }
  }, 45_000);
});
