/**
 * Bootstrap persists the Kubernetes-only execution policy and reconciles one
 * instance-wide managed environment with company-scoped tracking bindings.
 * Operator edits win unless PAPERCLIP_K8S_CONFIG_AUTHORITATIVE opts into
 * manifest ownership; operator archives remain protected in either mode.
 *
 * The heartbeat enforces the persisted policy, not this boot hook. Disabling
 * bootstrap does not reset executionMode or permit local fallback.
 */

import type { Db } from "@paperclipai/db";
import type { InstanceExecutionMode } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { environmentService, type KubernetesEnvironmentConfigInput } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { parseAdapterRegistryEnv } from "./adapter-registry-bootstrap.js";

export type ExecutionPolicyBootstrapEnv = Record<string, string | undefined>;

export interface ExecutionPolicyBootstrap {
  executionMode: Extract<InstanceExecutionMode, "kubernetes">;
  kubernetesConfig: KubernetesEnvironmentConfigInput;
  /** Kept outside kubernetesConfig because that object is stored as provider config. */
  applyOverOperatorEdits: boolean;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

function parsePositiveIntMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `PAPERCLIP_K8S_RPC_TIMEOUT_MS must be a positive integer of milliseconds (got "${value}").`,
    );
  }
  return parsed;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * A null result disables bootstrap; it says nothing about persisted policy.
 * Reject unknown modes so a typo cannot silently skip the policy write.
 */
export function parseExecutionPolicyBootstrapEnv(
  env: ExecutionPolicyBootstrapEnv,
): ExecutionPolicyBootstrap | null {
  const raw = env.PAPERCLIP_EXECUTION_MODE?.trim();
  if (!raw || raw === "any") return null;
  if (raw !== "kubernetes") {
    throw new Error(
      `PAPERCLIP_EXECUTION_MODE must be "kubernetes" or "any" (got "${raw}").`,
    );
  }

  const kubernetesConfig: KubernetesEnvironmentConfigInput = {
    // inCluster defaults to false (matches the plugin schema default); an
    // in-cluster cloud deployment sets PAPERCLIP_K8S_IN_CLUSTER=true.
    inCluster: parseBool(env.PAPERCLIP_K8S_IN_CLUSTER) ?? false,
  };

  const backend = env.PAPERCLIP_K8S_BACKEND?.trim();
  if (backend) {
    if (backend !== "job" && backend !== "sandbox-cr") {
      throw new Error(
        `PAPERCLIP_K8S_BACKEND must be "job" or "sandbox-cr" (got "${backend}").`,
      );
    }
    kubernetesConfig.backend = backend;
  }

  const egressMode = env.PAPERCLIP_K8S_EGRESS_MODE?.trim();
  if (egressMode) {
    if (egressMode !== "cilium" && egressMode !== "standard") {
      throw new Error(
        `PAPERCLIP_K8S_EGRESS_MODE must be "cilium" or "standard" (got "${egressMode}").`,
      );
    }
    kubernetesConfig.egressMode = egressMode;
  }

  const runtimeClassName = env.PAPERCLIP_K8S_RUNTIME_CLASS_NAME?.trim();
  if (runtimeClassName) kubernetesConfig.runtimeClassName = runtimeClassName;

  const namespacePrefix = env.PAPERCLIP_K8S_NAMESPACE_PREFIX?.trim();
  if (namespacePrefix) kubernetesConfig.namespacePrefix = namespacePrefix;

  const imageRegistry = env.PAPERCLIP_K8S_IMAGE_REGISTRY?.trim();
  if (imageRegistry) kubernetesConfig.imageRegistry = imageRegistry;

  const rpcTimeoutMs = parsePositiveIntMs(env.PAPERCLIP_K8S_RPC_TIMEOUT_MS);
  if (rpcTimeoutMs !== undefined) kubernetesConfig.timeoutMs = rpcTimeoutMs;

  const adapterType = env.PAPERCLIP_K8S_ADAPTER_TYPE?.trim();
  if (adapterType) kubernetesConfig.adapterType = adapterType;

  const egressAllowFqdns = parseList(env.PAPERCLIP_K8S_EGRESS_ALLOW_FQDNS);
  if (egressAllowFqdns) kubernetesConfig.egressAllowFqdns = egressAllowFqdns;

  const egressAllowCidrs = parseList(env.PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS);
  if (egressAllowCidrs) kubernetesConfig.egressAllowCidrs = egressAllowCidrs;

  const adapters = parseAdapterRegistryEnv(env);
  if (adapters) kubernetesConfig.adapters = adapters;

  const rawAuthoritative = env.PAPERCLIP_K8S_CONFIG_AUTHORITATIVE;
  const applyOverOperatorEdits = parseBool(rawAuthoritative);
  if (rawAuthoritative !== undefined && applyOverOperatorEdits === undefined) {
    throw new Error(
      `PAPERCLIP_K8S_CONFIG_AUTHORITATIVE must be "true" or "false" (got "${rawAuthoritative}").`,
    );
  }

  return {
    executionMode: "kubernetes",
    kubernetesConfig,
    applyOverOperatorEdits: applyOverOperatorEdits ?? false,
  };
}

export async function applyExecutionPolicyBootstrap(
  db: Db,
  bootstrap: ExecutionPolicyBootstrap,
): Promise<{ executionMode: InstanceExecutionMode; companiesConfigured: number }> {
  const instanceSettings = instanceSettingsService(db);
  const environments = environmentService(db);

  await instanceSettings.updateGeneral({ executionMode: bootstrap.executionMode });

  const companyIds = await instanceSettings.listCompanyIds();
  let configured = 0;
  const failedCompanyIds: string[] = [];
  for (const companyId of companyIds) {
    try {
      await environments.ensureKubernetesEnvironment(companyId, bootstrap.kubernetesConfig, {
        applyOverOperatorEdits: bootstrap.applyOverOperatorEdits,
      });
      configured += 1;
    } catch (err) {
      logger.error(
        { err, companyId },
        "failed to ensure managed Kubernetes environment during execution-policy bootstrap",
      );
      failedCompanyIds.push(companyId);
    }
  }

  logger.info(
    {
      executionMode: bootstrap.executionMode,
      companiesConfigured: configured,
      backend: bootstrap.kubernetesConfig.backend,
      runtimeClassName: bootstrap.kubernetesConfig.runtimeClassName,
      egressMode: bootstrap.kubernetesConfig.egressMode,
      configAuthoritative: bootstrap.applyOverOperatorEdits,
    },
    "applied forced Kubernetes execution policy",
  );

  if (failedCompanyIds.length > 0) {
    throw new Error(
      `execution-policy bootstrap: ${failedCompanyIds.length} of ${companyIds.length} companies failed to get a managed Kubernetes environment under executionMode=${bootstrap.executionMode}; refusing to start (companies: ${failedCompanyIds.join(", ")})`,
    );
  }

  return { executionMode: bootstrap.executionMode, companiesConfigured: configured };
}

export async function bootstrapExecutionPolicyFromEnv(
  db: Db,
  env: ExecutionPolicyBootstrapEnv = process.env,
): Promise<{ executionMode: InstanceExecutionMode; companiesConfigured: number } | null> {
  const bootstrap = parseExecutionPolicyBootstrapEnv(env);
  if (!bootstrap) return null;
  return applyExecutionPolicyBootstrap(db, bootstrap);
}
