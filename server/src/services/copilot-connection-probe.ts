import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { probeCopilotMetadata, validateCopilotMetadata } from "../vendor/paperclip-runner/live/index.js";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { environmentService } from "./environments.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { assertEnvironmentSelectionForCompany } from "../routes/environment-selection.js";
import { buildLoginLeaseAcquireArgs } from "./adapter-login-lease.js";
import { logger } from "../middleware/logger.js";
import { forbidden, unprocessable } from "../errors.js";

export async function probeCopilotConnection(db: Db, companyId: string, token: string, suppliedEnvironmentId?: string | null, model?: string, options: Parameters<typeof environmentRuntimeService>[1] & { targetAgentId?: string } = {}) {
  const { targetAgentId, ...runtimeOptions } = options;
  const environments = environmentService(db), settings = instanceSettingsService(db);
  const experimental = await settings.getExperimental();
  let environmentId = suppliedEnvironmentId ?? (await settings.get()).defaultEnvironmentId;
  if ((await settings.getGeneral()).executionMode === "kubernetes") {
    const kubernetes = await environments.findKubernetesEnvironment(companyId);
    if (!kubernetes) throw unprocessable("The Kubernetes execution environment is unavailable.", { code: "copilot_environment_unavailable" });
    environmentId = kubernetes.id;
  } else if (experimental.enableManagedSandboxOnly && (!environmentId || (await environments.getById(environmentId))?.driver === "local")) {
    const managed = await environments.findManagedSandboxEnvironment(companyId);
    if (!managed) throw unprocessable("The managed environment is unavailable.", { code: "copilot_environment_unavailable" });
    environmentId = managed.id;
  }
  if (!environmentId) return requireVerified(await probeCopilotMetadata(token, model));
  await assertEnvironmentSelectionForCompany(environments, companyId, environmentId, { allowedDrivers: ["local", "ssh", "sandbox", "plugin"] });
  const boundCompanyIds = await environments.listBoundCompanyIds(environmentId);
  if (boundCompanyIds.length > 0 && !boundCompanyIds.includes(companyId)) throw forbidden("The selected environment belongs to another company.", { code: "environment_company_mismatch" });
  const environment = await environments.getById(environmentId);
  if (!environment || environment.status !== "active") throw unprocessable("Choose an active Copilot execution environment.", { code: "copilot_environment_unavailable" });
  if (environment.driver === "local") return requireVerified(await probeCopilotMetadata(token, model));
  const runtime = environmentRuntimeService(db, runtimeOptions);
  let lease: Awaited<ReturnType<typeof runtime.acquireRunLease>> | undefined;
  let succeeded = false;
  let probeFailed = false;
  try {
    if (environment.driver !== "ssh") {
      lease = await runtime.acquireRunLease(buildLoginLeaseAcquireArgs({ metadata: { companyId, environment, adapterType: "paperclip_runner" }, targetAgentId, assertCompanyBinding: true, requestedExpiresAt: new Date(Date.now() + 90_000) }));
      if (environment.driver === "plugin" && await runtime.supportsTasks({ lease: lease.lease })) {
        const updated = await environments.updateLeaseMetadata(lease.lease.id, { ...lease.lease.metadata,
          runnerTaskProbe: { runId: randomUUID(), sessionId: randomUUID(), expiresAtMs: Date.now() + 90_000 } });
        if (!updated) throw new Error("Copilot metadata probe lease disappeared");
        lease.lease = updated;
      } else await runtime.realizeWorkspace({ environment, lease: lease.lease, workspace: {} });
    }
    const target = await resolveEnvironmentExecutionTarget({ db, companyId, adapterType: "paperclip_runner", environment,
      leaseId: lease?.lease.id, lease: lease?.lease, leaseMetadata: lease?.lease.metadata ?? null, environmentRuntime: runtime });
    if (!target || target.kind !== "remote") throw unprocessable("The selected environment cannot run the Copilot metadata probe.", { code: "copilot_environment_unavailable" });
    const verified = await probeCopilotExecutionTarget(token, target, model);
    succeeded = true;
    return verified;
  } catch (error) {
    probeFailed = true;
    throw error;
  } finally {
    if (lease) {
      try {
        const driver = runtime.getDriver(environment.driver);
        if (!driver) throw new Error("Copilot verification lease cleanup driver is unavailable");
        await driver.releaseRunLease({ environment, lease: lease.lease, status: succeeded ? "released" : "failed" });
      } catch {
        // Report only owned identifiers; driver errors may contain credentials.
        logger.warn({ companyId, environmentId: environment.id, leaseId: lease.lease.id, code: "COPILOT_PROBE_CLEANUP_FAILED" }, "Copilot verification lease cleanup failed");
        if (!probeFailed) throw unprocessable("Copilot verification could not release its execution environment.", { code: "COPILOT_REQUEST_FAILED", cleanupCode: "COPILOT_PROBE_CLEANUP_FAILED" });
      }
    }
  }
}

function requireVerified(value: unknown) {
  const result = validateCopilotMetadata(value);
  if (result.status !== "verified") throw unprocessable(result.message, { code: result.code });
  return result;
}

export async function probeCopilotExecutionTarget(token: string, target: AdapterExecutionTarget | null | undefined, model?: string) {
  if (!target || target.kind === "local") return requireVerified(await probeCopilotMetadata(token, model));
  if (target.transport === "sandbox" && target.runnerTask) {
    const result = environmentTaskResultSchema.parse(await target.runnerTask({ kind: "copilot_metadata", token, ...(model ? { model } : {}) }));
    if (result.kind !== "copilot_metadata") throw unprocessable("Copilot metadata verification failed.", { code: "COPILOT_REQUEST_FAILED" });
    const verified = requireVerified(result.metadata);
    if (model && !verified.models.some(value => value.id === model)) throw unprocessable("The selected Copilot model is unavailable for this account.", { code: "COPILOT_MODEL_UNAVAILABLE" });
    return verified;
  }
  // Try the same two installed locations as native admission. An old /opt
  // pack must not hide a valid home pack; account/model failures remain final.
  const deadlineAt = Date.now() + 35_000;
  let incompatibleMetadata: unknown;
  for (const location of ["/opt/paperclip-runner/provider-pack", '"$HOME/.local/share/paperclip-runner/provider-pack"']) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw unprocessable("Copilot metadata verification timed out.", { code: "COPILOT_REQUEST_FAILED" });
    const command = `pack=${location}; if [ -f "$pack/provider-pack.json" ] && [ -f "$pack/dist/cli/copilot-metadata-probe.js" ] && [ -x "$pack/node_modules/node/bin/node" ]; then export PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT="$pack" PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST="$pack/package.json"; exec "$pack/node_modules/node/bin/node" "$pack/dist/cli/copilot-metadata-probe.js"; fi; exit 127`;
    // The selected token and exact model are environment values, never shell source.
    const response = await runAdapterExecutionTargetShellCommand(`copilot-metadata-${randomUUID()}`, target, command, {
      cwd: target.remoteCwd, env: { COPILOT_GITHUB_TOKEN: token, ...(model ? { PAPERCLIP_COPILOT_PROBE_MODEL: model } : {}) }, timeoutSec: Math.ceil(remainingMs / 1000), graceSec: 3,
    });
    if (response.timedOut || response.stdout.length > 64 * 1024) throw unprocessable("Copilot metadata verification timed out.", { code: "COPILOT_REQUEST_FAILED" });
    let result: unknown;
    try { result = JSON.parse(response.stdout.trim()); } catch { continue; }
    const verified = validateCopilotMetadata(result);
    if (verified.status === "failed") {
      if (verified.code === "COPILOT_INSTALLATION_INVALID") continue;
      if (result !== null && typeof result === "object" && (result as Record<string, unknown>).status === "verified") {
        incompatibleMetadata = verified;
        continue;
      }
      requireVerified(verified);
      continue;
    }
    if (response.exitCode !== 0 || response.signal) throw unprocessable("Copilot metadata verification did not exit cleanly.", { code: "COPILOT_REQUEST_FAILED" });
    if (model && !verified.models.some(value => value.id === model)) throw unprocessable("The selected Copilot model is unavailable for this account.", { code: "COPILOT_MODEL_UNAVAILABLE" });
    return verified;
  }
  if (incompatibleMetadata) requireVerified(incompatibleMetadata);
  throw unprocessable("Install the verified Copilot runtime in this environment.", { code: "COPILOT_INSTALLATION_INVALID" });
}
