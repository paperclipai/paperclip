import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import type { RemoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";
import type { RemoteRunnerProcessControls } from "./remote-runner-process.js";

/** Bind idle operations to this controller, never to controller fields read
 * from a prior run. A new controller needs a separate durable takeover. */
export async function createNativeRemoteIdleControls(input: {
  companyId: string;
  runId: string;
  retentionNonce: string;
  process: RemoteRunnerRecoveryProcess;
  runtime: Pick<EnvironmentRuntimeService, "controlRunProcess" | "recoverRunner">;
}) {
  const unavailable = () => new Error("native_remote_runner_idle_authority_unverified");
  const { companyId, runId, retentionNonce, runtime } = input;
  if (typeof retentionNonce !== "string" || !/^[a-f0-9-]{36}$/.test(retentionNonce)) throw unavailable();
  const expected = structuredClone(input.process);
  const controller = await currentNativeControllerIdentity();
  const authority = Object.freeze({ nonce: retentionNonce, bootId: controller.bootId,
    pid: controller.pid, processStartedAt: controller.processStartedAt.toISOString() });
  const control = async (operation: { action: "inspect" } | { action: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGKILL" }) => {
    const binding = { companyId, runId, environmentLeaseId: expected.environmentLeaseId,
      expectedRetention: { ...authority }, expectedOwner: { ...expected.remoteProcessIdentity } };
    const result = operation.action === "inspect"
      ? await runtime.controlRunProcess({ ...binding, operation })
      : await runtime.controlRunProcess({ ...binding, operation });
    if (!result.process || !sameRuntimeServiceConfiguration(result.process, expected)) throw unavailable();
    return result;
  };
  return Object.freeze({
    isAlive: async () => {
      const result = await control({ action: "inspect" });
      if (result.state === "running") return true;
      if (result.state === "exited") return false;
      throw unavailable();
    },
    signal: async (signal: NodeJS.Signals) => {
      if (signal !== "SIGINT" && signal !== "SIGTERM" && signal !== "SIGKILL") throw unavailable();
      const result = await control({ action: "signal", signal });
      if (result.state !== "signalled" && result.state !== "exited") throw unavailable();
      return true;
    },
    readState: async () => {
      const result = await runtime.recoverRunner({ companyId, runId, expectedProcess: structuredClone(expected),
        expectedRetention: { ...authority }, operation: "read_state" });
      if (result.state !== "ready" || !sameRuntimeServiceConfiguration(result.workspaceConnection, expected.workspaceConnection)
        || !("runnerState" in result) || !result.runnerState || Array.isArray(result.runnerState) || result.runnerState.runId !== runId) throw unavailable();
      return result.runnerState;
    },
  });
}

/** Adapt the controller-bound idle capability to a live launcher. Each call
 * still checks the launch receipt; no generic diagnostics command is exposed. */
export async function createNativeRemoteIdleProcessControls(
  input: Parameters<typeof createNativeRemoteIdleControls>[0],
): Promise<RemoteRunnerProcessControls> {
  const expectedOwner = structuredClone(input.process.remoteProcessIdentity);
  const controls = await createNativeRemoteIdleControls(input);
  const checkOwner = (owner: Parameters<RemoteRunnerProcessControls["inspect"]>[0]) => {
    if (!sameRuntimeServiceConfiguration(owner, expectedOwner)) {
      throw new Error("native_remote_runner_idle_authority_unverified");
    }
  };
  return Object.freeze({
    inspect: async owner => { checkOwner(owner); return await controls.isAlive() ? "running" : "exited"; },
    signal: async (owner, signal) => { checkOwner(owner); await controls.signal(signal); return "signalled"; },
    readState: async owner => { checkOwner(owner); return controls.readState(); },
  } satisfies RemoteRunnerProcessControls);
}
