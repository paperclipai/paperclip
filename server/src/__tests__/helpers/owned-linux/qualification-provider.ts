// PRIVATE UNRUN provider composition. Uses actual SDK worker registration;
// never insert ready plugin/environment/lease rows from the fixture.
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams, PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult, PluginEnvironmentInspectLeaseParams,
  PluginEnvironmentLease, PluginEnvironmentLeaseObservation,
  PluginEnvironmentRealizeWorkspaceParams, PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams, PluginEnvironmentRunnerIngressEndpoint,
  PluginEnvironmentRunnerIngressEndpointParams, PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams, PluginEnvironmentSyncResult,
  PluginEnvironmentTerminationReceipt, PluginEnvironmentResumeLeaseParams,
} from "@paperclipai/plugin-sdk";

// Concrete implementation boundary for the owned local Linux resource. No
// method may return cached ready/result/termination data. The implementation
// must inspect exact engine/container labels and use actual relay/file custody.
export interface OwnedLinuxProvider {
  initialize(): Promise<void>;
  acquire(input: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease>;
  resume(input: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease>;
  inspect(input: PluginEnvironmentInspectLeaseParams): Promise<PluginEnvironmentLeaseObservation>;
  realize(input: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  execute(input: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult>;
  ingress(input: PluginEnvironmentRunnerIngressEndpointParams): Promise<PluginEnvironmentRunnerIngressEndpoint>;
  syncIn(input: PluginEnvironmentSyncInParams): Promise<PluginEnvironmentSyncResult>;
  syncOut(input: PluginEnvironmentSyncOutParams): Promise<PluginEnvironmentSyncResult>;
  stop(input: PluginEnvironmentReleaseLeaseParams): Promise<PluginEnvironmentTerminationReceipt>;
  idle(): boolean;
  close(): Promise<void>;
}

export function linuxQualificationPlugin(provider: OwnedLinuxProvider) {
  return definePlugin({
    async setup() { await provider.initialize(); },
    async onEnvironmentValidateConfig(params) {
      const ok = params.driverKey === "dot-linux-qualification" && params.config.qualificationId === "dot-owned-linux";
      return ok ? { ok: true, normalizedConfig: { qualificationId: "dot-owned-linux" } }
        : { ok: false, errors: ["owned_linux_configuration_mismatch"] };
    },
    onEnvironmentAcquireLease: input => provider.acquire(input),
    onEnvironmentResumeLease: input => provider.resume(input),
    onEnvironmentInspectLease: input => provider.inspect(input),
    onEnvironmentRealizeWorkspace: input => provider.realize(input),
    onEnvironmentExecute: input => provider.execute(input),
    onEnvironmentRunnerIngressEndpoint: input => provider.ingress(input),
    onEnvironmentSyncIn: input => provider.syncIn(input),
    onEnvironmentSyncOut: input => provider.syncOut(input),
    onEnvironmentStopLease: input => provider.stop(input),
    onEnvironmentReleaseLease: input => provider.stop(input),
    // Retains files: report only the actual observed stopped state, never destroyed.
    onEnvironmentDestroyLease: input => provider.stop(input),
    async onIdleDrain() { return provider.idle() ? "none" : "present"; },
    async onShutdown() { await provider.close(); },
  });
}

export function startLinuxQualificationWorker(provider: OwnedLinuxProvider, url: string) {
  // Normal runWorker advertises the actual methods. This is not a fake manager
  // or a hand-built supportedMethods/ready-row substitute.
  runWorker(linuxQualificationPlugin(provider), url);
}
