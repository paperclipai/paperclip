import { measureRunPhase } from "../execution-preparation-timing.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { environmentTaskOperationSchema, environmentTaskResultSchema, type PluginEnvironmentTaskOperation, type PluginEnvironmentTaskResult, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { RUNNER_PRP_PROTOCOL_MIN, RUNNER_PRP_PROTOCOL_MAX, type RunnerProcessHandle, type RunnerProcessLaunchSpec,
  type DurablePrpControlPlane, type RunnerExecutionDriver, type RunnerLaunchPreparer, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";

export async function verifyPluginRunnerTaskReattachment(
  task: (operation: unknown) => Promise<unknown>, identity: unknown,
): Promise<void> {
  const operation = environmentTaskOperationSchema.parse({ kind: "read_state", identity });
  if (operation.kind !== "read_state") throw new Error("Plugin Runner recovery identity unavailable");
  const status = environmentTaskResultSchema.parse(await task({ kind: "status" }));
  if (status.kind !== "status" || status.executionStopped || status.phase !== "running") {
    throw new Error("Plugin Runner is not running");
  }
  const result = environmentTaskResultSchema.parse(await task(operation));
  if (result.kind !== "state" || result.state.schema !== "paperclip.runner.durable.state.v1"
    || Object.entries(operation.identity).some(([key, value]) => result.state[key] !== value)) {
    throw new Error("Plugin Runner adoption identity mismatch");
  }
}

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
  warmTaskVersion?: 1;
  adoptIdentity?: DurableRecoveryIdentity;
}) {
  const pollMs = input.pollMs ?? 500;
  let registrationGeneration = 0;
  let activeOutbound: ReturnType<typeof connectRunnerPrpIngress> | null = null;
  let preparedLaunchId: string | undefined;
  let preparedIdentity: DurableRecoveryIdentity | undefined = input.adoptIdentity;
  let launched = !!input.adoptIdentity;
  let stopRequested = false;
  let released = false;
  let submitted = !!input.adoptIdentity;
  let detached = false;
  let adoptionVerified = false;
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  let confirmStopped: (code: number) => void = () => {};
  let stoppedState: Extract<PluginEnvironmentTaskResult, { kind: "status" }> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  const running = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  void running.catch(() => undefined);
  if (input.adoptIdentity) markReady();
  const call = async (operation: PluginEnvironmentTaskOperation) => {
    const phase = ({ prepare: "execution.plugin_prepare", check_project_auth: "execution.plugin_project_auth",
      submit: "execution.plugin_submit", connection: "execution.plugin_connection" } as const)[operation.kind as "prepare" | "check_project_auth" | "submit" | "connection"];
    const result = environmentTaskResultSchema.parse(await (phase
      ? measureRunPhase(phase, () => input.task(operation)) : input.task(operation)));
    if (result.kind !== (operation.kind === "read_file" ? "file" : operation.kind === "describe" ? "description" : operation.kind === "prepare" ? "prepared" : operation.kind === "check_project_auth" ? "project_auth" : ["read_state", "archive_state"].includes(operation.kind) ? "state" : ["status", "connection", "credentials"].includes(operation.kind) ? operation.kind : "accepted")) {
      throw new Error("Plugin Runner returned an invalid operation result");
    }
    return result;
  };
  const checkProjectAuth = async (configurationId:string) => {
    if (input.projectAuthCheckVersion !== 1) throw new Error("Plugin Runner managed project authentication validation unavailable");
    const provider = input.harness === "codex" ? "openai" : input.harness === "claude" ? "anthropic" : input.harness;
    const validation = await call({kind:"check_project_auth",configurationId,provider,projectIds:[...input.projectIds]});
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    if (validation.kind !== "project_auth" || !validation.allowed || validation.configurationId !== configurationId
      || validation.provider !== provider) throw new Error("Plugin Runner project authentication conflicts with the selected managed account");
  };
  const authorizeRunnerAdoption = async (configurationId: string, identity: DurableRecoveryIdentity) => {
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    if (!input.adoptIdentity || Object.entries(input.adoptIdentity).some(([key, value]) => identity[key as keyof DurableRecoveryIdentity] !== value)) {
      throw new Error("Plugin Runner adoption identity mismatch");
    }
    await checkProjectAuth(configurationId);
    preparedLaunchId = configurationId;
  };
  const prepareLaunch: RunnerLaunchPreparer = async (requirements, recovery) => {
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    // Reconnecting the previous authority must not prepare it through the new run's lease.
    if (recovery && input.adoptIdentity && Object.entries(input.adoptIdentity).every(([key,value]) => requirements.identity[key as keyof DurableRecoveryIdentity] === value)) {
      await authorizeRunnerAdoption(recovery.configurationId, requirements.identity);
      return recovery;
    }
    const result = await call(environmentTaskOperationSchema.parse({ kind: "prepare", requirements,
      projectIds: [...input.projectIds], ...(recovery ? { recovery } : {}),
      ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
      ...(launched && preparedIdentity && requirements.identity.runId !== preparedIdentity.runId
        ? { priorIdentity: preparedIdentity, accountIdentity: input.accountIdentity } : {}),
    }));
    if (released || stopRequested) throw new Error("Plugin Runner preparation cancelled");
    if (result.kind !== "prepared") throw new Error("Plugin Runner preparation unavailable");
    if (input.projectAuthCheckVersion !== 1) throw new Error("Plugin Runner managed project authentication validation unavailable");
    if (launched || !result.projectAuthCheckAtSubmit) await checkProjectAuth(result.launch.configurationId);
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
    if (!native || (native.lifecyclePolicy?.mode !== "per_turn" && !(native.lifecyclePolicy?.mode === "warm" && input.accountIdentity && input.warmTaskVersion === 1))
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
      kill: () => {
        stopRequested = true;
        if (native.lifecyclePolicy?.mode === "warm" && submitted) void stopAndConfirm().catch(rejectFailure);
        return true;
      } };
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
        if (state.phase === "running" && !stopRequested) {
          markReady();
          // PRP owns live failure detection; warm idle tasks must not keep polling Launcher.
          if (native.lifecyclePolicy?.mode === "warm") return;
        }
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
          if (input.adoptIdentity) {
            await verifyPluginRunnerTaskReattachment(input.task, input.adoptIdentity);
          } else await running;
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
    prepareLaunch, authorizeRunnerAdoption, readRunnerState, runnerProcessLauncher: launcher,
    // The provider resolves the authorized retained task before each state operation.
    prepareExternalRunnerState: async () => {},
    archiveExternalRunnerState: async archive => {
      if (!input.resumeFrom) throw new Error("Plugin Runner archive requires a retained task");
      const result = await call({ kind: "archive_state", ...archive, resumeFrom: input.resumeFrom });
      if (result.kind !== "state") throw new Error("Plugin Runner archived state unavailable");
      return result.state;
    },
    controlPlaneRegistration: (authority, identity, signal) => registration(authority, identity?.runId ?? "", signal),
    ...(input.adoptIdentity ? { adoptExistingRunner: {
      // Provider ownership is attested by Launcher, never by a controller-local PID.
      pid: null, processGroupId: null, startedAt: null,
      isAlive: async () => {
        if (!adoptionVerified) { if ((await readStatus()).executionStopped === true) return false; adoptionVerified = true; }
        // Authenticated PRP detects disconnects; this cache never asserts termination.
        return stoppedState === undefined;
      },
      signal: async () => { stopRequested = true; await stopAndConfirm(); return true; },
    } } : {}),
  };
  const readWorkspaceFile = async (path: string, maxBytes: number): Promise<Buffer> => {
    if (!submitted || !preparedIdentity || released || stopRequested) throw new Error("Plugin Runner file access unavailable");
    const result = await call(environmentTaskOperationSchema.parse({ kind: "read_file", identity: preparedIdentity,
      projectIds: [...input.projectIds], path, maxBytes }));
    if (released || stopRequested || result.kind !== "file" || result.byteSize > maxBytes) throw new Error("Plugin Runner file access unavailable");
    const bytes = Buffer.from(result.base64, "base64");
    if (bytes.length !== result.byteSize || bytes.toString("base64") !== result.base64 ||
        createHash("sha256").update(bytes).digest("hex") !== result.sha256) throw new Error("Plugin Runner file integrity check failed");
    return bytes;
  };
  return { launcher, registration, driver, readWorkspaceFile,
    rebind(next: typeof input) {
      if (!launched || stopRequested || stoppedState || detached || next.harness !== input.harness ||
          input.accountIdentity !== next.accountIdentity || input.credentialIdentity !== next.credentialIdentity ||
          JSON.stringify(input.projectIds) !== JSON.stringify(next.projectIds)) throw new Error("Plugin warm task cannot be rebound");
      input = next;
      released = false;
    },
  };

}
