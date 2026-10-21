import { setTimeout as delay } from "node:timers/promises";
import { environmentTaskOperationSchema, environmentTaskResultSchema, type PluginEnvironmentTaskOperation, type PluginEnvironmentTaskResult, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { RUNNER_PRP_PROTOCOL_MIN, RUNNER_PRP_PROTOCOL_MAX, type RunnerProcessHandle, type RunnerProcessLaunchSpec,
  type DurablePrpControlPlane, type RunnerExecutionDriver, type RunnerLaunchPreparer, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";

/** Adapts a lease-bound task provider to the existing native process owner.
 * No provider pid is treated as a local pid. Only executionStopped settles it.
 */
export function createPluginRunnerTaskOwner(input: {
  task: (operation: unknown) => Promise<unknown>;
  projectIds: readonly string[];
  harness: string;
  projectAuthCheckVersion?: 1;
  resumeFrom?: string;
  priorIdentity?: DurableRecoveryIdentity;
  credentialIdentity?: string;
  accountIdentity?: string;
  credential?: PluginEnvironmentTaskCredential;
  onCredentials?: (credential: PluginEnvironmentTaskCredential) => Promise<void>;
  onSessionRetained?: (state: Record<string, unknown>) => Promise<void>;
  onDispatched?: () => Promise<void> | void;
  pollMs?: number;
}) {
  const pollMs = input.pollMs ?? 500;
  let registrationGeneration = 0;
  let activeOutbound: ReturnType<typeof connectRunnerPrpIngress> | null = null;
  let preparedLaunchId: string | undefined;
  let preparedIdentity: DurableRecoveryIdentity | undefined;
  let launched = false;
  let stopRequested = false;
  let released = false;
  let submitted = false;
  let detached = false;
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  let confirmStopped: (code: number) => void = () => {};
  let stoppedState: Extract<PluginEnvironmentTaskResult, { kind: "status" }> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  const running = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  void running.catch(() => undefined);
  const call = async (operation: PluginEnvironmentTaskOperation) => {
    const result = environmentTaskResultSchema.parse(await input.task(operation));
    if (result.kind !== (operation.kind === "describe" ? "description" : operation.kind === "prepare" ? "prepared" : operation.kind === "check_project_auth" ? "project_auth" : ["read_state", "archive_state"].includes(operation.kind) ? "state" : ["status", "connection", "credentials"].includes(operation.kind) ? operation.kind : "accepted")) {
      throw new Error("Plugin Runner returned an invalid operation result");
    }
    return result;
  };
  const prepareLaunch: RunnerLaunchPreparer = async (requirements, recovery) => {
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    const result = await call(environmentTaskOperationSchema.parse({ kind: "prepare", requirements,
      projectIds: [...input.projectIds], ...(recovery ? { recovery } : {}),
      ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
    }));
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    if (result.kind !== "prepared") throw new Error("Plugin Runner preparation unavailable");
    {
      const provider = input.harness === "codex" ? "openai" : input.harness === "claude" ? "anthropic" : input.harness;
      if (input.projectAuthCheckVersion !== 1) throw new Error("Plugin Runner managed project authentication validation unavailable");
      const validation = await call({ kind: "check_project_auth", configurationId: result.launch.configurationId,
        provider, projectIds: [...input.projectIds] });
      if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
      if (validation.kind !== "project_auth" || !validation.allowed || validation.configurationId !== result.launch.configurationId
        || validation.provider !== provider) throw new Error("Plugin Runner project authentication conflicts with the selected managed account");
    }
    preparedLaunchId = result.launch.configurationId;
    preparedIdentity = requirements.identity;
    return result.launch;
  };
  const readRunnerState = async () => {
    const identity = submitted ? preparedIdentity : input.priorIdentity ?? preparedIdentity;
    if (!identity) throw new Error("Plugin Runner state identity unavailable");
    const result = await call({ kind: "read_state", identity,
      ...(!submitted && input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
    });
    if (result.kind !== "state") throw new Error("Plugin Runner state unavailable");
    return result.state;
  };
  const readStatus = async (deadline = Date.now() + 15_000) => {
    for (;;) {
      if (stoppedState) return stoppedState;
      try {
        const state = await call({ kind: "status" });
        if (state.kind === "status") {
          if (state.executionStopped === true) {
            stoppedState = state;
            confirmStopped(state.exitCode ?? (state.phase === "completed" ? 0 : 1));
          }
          return state;
        }
      } catch { /* A failed read is not proof that execution stopped. */ }
      if (Date.now() >= deadline) throw new Error("Plugin Runner status unavailable; reconcile the saved task");
      await delay(pollMs);
    }
  };
  const stopAndConfirm = async () => {
    await call({ kind: "stop" });
    const deadline = Date.now() + 15_000;
    do {
      const state = await readStatus(deadline);
      if (state.executionStopped === true) return;
      await delay(pollMs);
    } while (Date.now() < deadline);
    throw new Error("Plugin Runner termination is unconfirmed; retain the lease for cleanup");
  };
  const launcher = (spec: RunnerProcessLaunchSpec): RunnerProcessHandle => {
    if (launched || released) throw new Error("Plugin Runner replacement requires a new task lease");
    const native = spec.nativeRunner;
    if (!preparedLaunchId) throw new Error("Plugin Runner launch requires preparation");
    if (!native || native.lifecyclePolicy?.mode !== "per_turn"
      || !preparedIdentity || Object.entries(preparedIdentity).some(([key, value]) => native.identity[key as keyof DurableRecoveryIdentity] !== value)) {
      throw new Error("Plugin Runner requires a structured per-turn native launch");
    }
    const operation = environmentTaskOperationSchema.parse({
      kind: "submit", preparedLaunchId, projectIds: [...input.projectIds], bootstrapTicket: native.ticket,
      ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
      ...(input.credentialIdentity ? { credentialIdentity: input.credentialIdentity } : {}),
      ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
      runner: { protocolMin: RUNNER_PRP_PROTOCOL_MIN, protocolMax: RUNNER_PRP_PROTOCOL_MAX,
        harness: input.harness,
        runnerId: native.identity.runnerInstanceId, leaseId: native.identity.environmentLeaseId,
        runId: native.identity.runId, sessionId: native.identity.normalizedSessionId,
        turnId: native.identity.turnId, itemId: native.identity.itemId },
      launch: { runnerVersion: native.runnerVersion, runnerDigest: native.runnerDigest,
        maxOutboxBytes: native.maxOutboxBytes, p0ReserveBytes: native.p0ReserveBytes,
        maxRuntimeMs: native.maxRuntimeMs, maxLifetimeMs: native.maxLifetimeMs,
        reconnectGraceMs: native.reconnectGraceMs, lifecyclePolicy: native.lifecyclePolicy,
      },
    });
    launched = true;
    const child: RunnerProcessHandle["child"] = { exitCode: null, signalCode: null,
      kill: () => { stopRequested = true; return true; } };
    const completion = new Promise<Awaited<RunnerProcessHandle["completion"]>>(resolve => {
      confirmStopped = code => {
        if (child.exitCode !== null) return;
        child.exitCode = code;
        failReady(new Error("Plugin Runner stopped before connection"));
        resolve({ code, signal: null, stdout: "", stderr: "" });
      };
    });
    void (async () => {
      if (released || stopRequested) {
        failReady(new Error("Plugin Runner startup cancelled"));
        confirmStopped(1);
        return;
      }
      environmentTaskOperationSchema.parse(operation);
      // Persist/mark dispatch before crossing the provider boundary. A lost reply
      // must reconcile this attempt and must never launch another task.
      await input.onDispatched?.();
      if (released || stopRequested) {
        failReady(new Error("Plugin Runner startup cancelled"));
        confirmStopped(1);
        return;
      }
      submitted = true;
      try { await call(operation); } catch {
        // Submission can have succeeded remotely. Inspect the same saved task.
        await readStatus();
      }
      let stopSent = false;
      while (child.exitCode === null) {
        if (detached) return;
        if (stopRequested && !stopSent) { await call({ kind: "stop" }); stopSent = true; }
        const state = await readStatus();
        if (state.phase === "running" && !stopRequested) markReady();
        if (state.executionStopped === true) return;
        await delay(pollMs);
      }
    })().catch(error => {
      if (stoppedState) return;
      failReady(error);
      rejectFailure(new Error("Plugin Runner operation failed; reconcile the saved task"));
      if (!submitted) confirmStopped(1);
    });
    return { child, completion, restart: null };
  };
  const registration = async (authority: DurablePrpControlPlane, runId: string, signal?: AbortSignal) => {
    const generation = ++registrationGeneration;
    let registrationReleased = false;
    let outbound: ReturnType<typeof connectRunnerPrpIngress> | null = null;
    let activation: Promise<void> | null = null;
    const endpoint = async (): Promise<RunnerIngressEndpoint> => {
      const result = await call({ kind: "connection" });
      if (result.kind !== "connection") throw new Error("Plugin Runner connection unavailable");
      return { ...result.endpoint, refresh: endpoint, close: async () => {} };
    };
    return {
      connection: { mode: "external" as const },
      startupFailureCode: "runner_ingress_unavailable" as const,
      activate: () => {
        activation = (async () => {
          await running;
          if (registrationReleased || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          const ingress = await endpoint();
          if (registrationReleased || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          await activeOutbound?.close();
          if (registrationReleased || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          outbound = connectRunnerPrpIngress({ authority, endpoint: ingress });
          activeOutbound = outbound;
          void outbound.failure?.catch(rejectFailure);
          await outbound.ready;
        })();
        void activation.catch(() => undefined);
      },
      ready: async () => { await activation; },
      failure,
      checkpoint: async (settlement: "settled" | "unsettled") => {
        if (submitted) { stopRequested = true; await stopAndConfirm(); }
        if (submitted && input.accountIdentity && input.onCredentials) {
          const snapshot = await call({ kind: "credentials", accountIdentity: input.accountIdentity });
          if (snapshot.kind !== "credentials") throw new Error("Plugin Runner credential snapshot unavailable");
          if (snapshot.credential !== null) await input.onCredentials(snapshot.credential);
        }
        if (settlement === "settled" && stoppedState?.sessionStateAvailable === true && input.onSessionRetained) {
          const state = await readRunnerState();
          if (state.schema !== "paperclip.runner.durable.state.v1" || state.lifecycle !== "suspended"
            || !preparedIdentity || Object.entries(preparedIdentity).some(([key, value]) => state[key] !== value)) {
            throw new Error("Plugin Runner suspended state identity mismatch");
          }
          await input.onSessionRetained(state);
        }
        if (submitted) await call({ kind: "complete" });
      },
      release: async (reason?: "detach") => {
        registrationReleased = true;
        if (generation === registrationGeneration) released = true;
        if (reason === "detach") { released = true; detached = true; }
        // Closing WSS does not retire the provider process or release its lease.
        await outbound?.close();
      },
    };
  };
  const driver: RunnerExecutionDriver = {
    prepareLaunch, readRunnerState, runnerProcessLauncher: launcher,
    // The provider resolves the authorized retained task before each state operation.
    prepareExternalRunnerState: async () => {},
    archiveExternalRunnerState: async archive => {
      if (!input.resumeFrom) throw new Error("Plugin Runner archive requires a retained task");
      const result = await call({ kind: "archive_state", ...archive, resumeFrom: input.resumeFrom });
      if (result.kind !== "state") throw new Error("Plugin Runner archived state unavailable");
      return result.state;
    },
    controlPlaneRegistration: (authority, identity, signal) => registration(authority, identity?.runId ?? "", signal),
  };
  return { launcher, registration, driver };
}
