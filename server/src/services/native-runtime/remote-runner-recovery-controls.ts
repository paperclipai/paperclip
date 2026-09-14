import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import type { PluginEnvironmentExecuteResult, PluginEnvironmentRunnerRecoveryExecuteParams } from "@paperclipai/plugin-sdk";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import type { RemoteRunnerRecoveryController, RemoteRunnerRecoveryProcess, RemoteRunnerRetentionAuthority } from "./remote-runner-recovery.js";

/** One immutable host capability. No host PID probes and no generic-execute,
 * endpoint or allocation fallback when the original connection is unavailable. */
export function createRemoteRunnerRecoveryControls(input: {
  companyId: string; runId: string; process: RemoteRunnerRecoveryProcess;
  runtime: Pick<EnvironmentRuntimeService, "controlRunProcess" | "recoverRunner" | "executeRecoveringRunner">;
  idle?: { authority: RemoteRunnerRetentionAuthority; reconnectionNonce: string; generation: number };
}): { nativeRunnerRecovery: NonNullable<AdapterSandboxExecutionTarget["nativeRunnerRecovery"]>;
  getRunnerIngressEndpoint: NonNullable<AdapterSandboxExecutionTarget["getRunnerIngressEndpoint"]>;
  execute(execution: PluginEnvironmentRunnerRecoveryExecuteParams["execution"]): Promise<PluginEnvironmentExecuteResult> } {
  const expected = structuredClone(input.process);
  const binding = { companyId: input.companyId, runId: input.runId, environmentLeaseId: expected.environmentLeaseId, expectedOwner: expected.remoteProcessIdentity };
  const unavailable = () => new Error("native_remote_runner_recovery_unverified");
  const idle = input.idle ? structuredClone(input.idle) : null;
  if (idle && (!/^[a-f0-9-]{36}$/.test(idle.reconnectionNonce) || !/^[a-f0-9-]{36}$/.test(idle.authority.nonce)
    || idle.reconnectionNonce === idle.authority.nonce || !Number.isSafeInteger(idle.generation) || idle.generation < 1)) throw unavailable();
  let controller: Readonly<RemoteRunnerRecoveryController> | null = null;
  const controllerBinding = () => {
    if (!controller) throw unavailable();
    if (idle) return { expectedRetention: { ...idle.authority }, expectedIdleReconnectionNonce: idle.reconnectionNonce };
    return { expectedController: { ...controller } };
  };
  let observation: Promise<boolean> | null = null;
  const inspect = async () => {
    const result = await input.runtime.controlRunProcess({ ...binding, ...(controller || idle ? controllerBinding() : {}), operation: { action: "inspect" } });
    if (!result.process || !sameRuntimeServiceConfiguration(result.process, expected)) throw unavailable();
    if (result.state === "running") return true;
    if (result.state === "exited") return false;
    throw unavailable();
  };
  const recover = async (operation: "read_state" | "ingress") => {
    const result = await input.runtime.recoverRunner({ companyId: binding.companyId, runId: binding.runId, expectedProcess: expected, ...controllerBinding(), operation });
    if (result.state !== "ready" || !sameRuntimeServiceConfiguration(result.workspaceConnection, expected.workspaceConnection)) throw unavailable();
    return result;
  };
  const acquire = async (): Promise<RunnerIngressEndpoint> => {
    const result = await recover("ingress");
    if (!("endpoint" in result)) throw unavailable();
    const endpoint = result.endpoint;
    let url: URL;
    try { url = new URL(endpoint.websocketUrl); } catch { throw unavailable(); }
    if (endpoint.kind !== "authenticated_websocket" || url.protocol !== "wss:" || url.username || url.password || url.search || url.hash
      || url.pathname !== `/api/runner/v1/connect/${binding.runId}` || !endpoint.generation
      || !Array.isArray(endpoint.secretHeaders) || endpoint.secretHeaders.length !== 1) throw unavailable();
    const header = endpoint.secretHeaders[0]!;
    if (header.name !== "X-Daytona-Preview-Token" || typeof header.value !== "string" || !header.value || header.value.length > 16384 || /[\r\n]/.test(header.value)) throw unavailable();
    const secretHeader = { name: header.name } as { name: string; readonly value: string; toJSON(): { name: string; value: "[REDACTED]" } };
    Object.defineProperty(secretHeader, "value", { value: header.value, enumerable: false });
    Object.defineProperty(secretHeader, "toJSON", { value: () => ({ name: header.name, value: "[REDACTED]" as const }) });
    return { kind: "authenticated_websocket", websocketUrl: url.toString(), secretHeaders: Object.freeze([Object.freeze(secretHeader)]),
      generation: endpoint.generation, refresh: acquire, close: async () => undefined };
  };
  return {
    execute: async execution => {
      // A recovered idle transport receives no workspace command capability.
      // Checkpoint work must obtain the separate close admission.
      if (idle) throw unavailable();
      // Workspace-copy clients may carry their ordinary five-minute timeout.
      // Recovery commands use the separately bounded capability instead.
      const requestedTimeout = execution.timeoutMs ?? 30_000;
      if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw unavailable();
      const response = await input.runtime.executeRecoveringRunner({ companyId: binding.companyId, runId: binding.runId,
        expectedProcess: expected, ...controllerBinding(), execution: { ...structuredClone(execution), timeoutMs: Math.min(requestedTimeout, 120_000) } });
      if (response.state !== "executed" || !sameRuntimeServiceConfiguration(response.workspaceConnection, expected.workspaceConnection)
        || !response.result || response.result.timedOut || response.result.exitCode === null || !Number.isInteger(response.result.exitCode)
        || typeof response.result.stdout !== "string" || typeof response.result.stderr !== "string") throw unavailable();
      return response.result;
    },
    nativeRunnerRecovery: {
      process: { pid: expected.pid, processGroupId: null, startedAt: expected.startedAt, processLocation: "remote", remoteProcessIdentity: { ...expected.remoteProcessIdentity } },
      bindController: expectedController => {
        if (!expectedController || typeof expectedController.leaseOwner !== "string" || !expectedController.leaseOwner
          || !Number.isSafeInteger(expectedController.controllerGeneration) || expectedController.controllerGeneration < 0
          || (idle && (expectedController.leaseOwner !== `native-idle:${idle.authority.nonce}` || expectedController.controllerGeneration !== idle.generation))
          || (controller && (controller.leaseOwner !== expectedController.leaseOwner
            || controller.controllerGeneration !== expectedController.controllerGeneration))) throw unavailable();
        if (!controller) {
          controller = Object.freeze({ leaseOwner: expectedController.leaseOwner, controllerGeneration: expectedController.controllerGeneration });
          // An outstanding initial probe is not evidence for the bound owner.
          observation = null;
        }
      },
      isAlive: () => {
        // Transport requests and its monitor may ask simultaneously. Never
        // cache a past liveness result as evidence for a later operation.
        if (!observation) {
          const pending = inspect().finally(() => { if (observation === pending) observation = null; });
          observation = pending;
        }
        return observation;
      },
      signal: async signal => {
        if (signal !== "SIGINT" && signal !== "SIGTERM" && signal !== "SIGKILL") throw unavailable();
        const result = await input.runtime.controlRunProcess({ ...binding, ...controllerBinding(), operation: { action: "signal", signal } });
        if (!result.process || !sameRuntimeServiceConfiguration(result.process, expected) || !["signalled", "exited"].includes(result.state)) throw unavailable();
        return true;
      },
      readState: async () => {
        const result = await recover("read_state");
        if (!("runnerState" in result) || !result.runnerState || Array.isArray(result.runnerState) || result.runnerState.runId !== binding.runId) throw unavailable();
        return result.runnerState;
      },
    },
    getRunnerIngressEndpoint: async request => {
      if (request.leaseId !== expected.environmentLeaseId || request.port !== 43127 || request.path !== `/api/runner/v1/connect/${binding.runId}`) throw unavailable();
      return acquire();
    },
  };
}
