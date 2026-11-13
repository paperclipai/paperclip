import { definePlugin, PluginEnvironmentCreationCleanupError, runWorker } from "@paperclipai/plugin-sdk";

function failure(params) {
  const cleanup = {
    providerLeaseId: "paperclip-create-fixture", attemptId: "fixture", companyId: params.companyId,
    environmentId: params.environmentId, runId: params.runId, accountFingerprint: "a".repeat(64),
    labels: { "paperclip-provider": "daytona" },
  };
  const diagnostic = { phase: params.config.phase ?? "create", elapsedMs: 2_000, budgetMs: 2_000,
    output: "private-provider-output", command: "private-provider-command", url: "private-provider-url" };
  return new PluginEnvironmentCreationCleanupError([new Error("private-provider-cause")],
    "Daytona lease acquisition timed out; allocation cleanup is pending", cleanup, diagnostic);
}

runWorker(definePlugin({
  async setup() {},
  async onEnvironmentAcquireLease(params) { throw failure(params); },
  async onEnvironmentDestroyLease(params) { throw failure(params); },
}), import.meta.url);
