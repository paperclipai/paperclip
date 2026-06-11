/**
 * Cloud execution-policy bootstrap.
 *
 * Lets an operator / gitops deployment force the instance onto the Kubernetes
 * sandbox provider purely via environment variables, with no manual product-API
 * calls. On startup we:
 *   1. Parse `PAPERCLIP_EXECUTION_MODE` (+ `PAPERCLIP_K8S_*`) from the env.
 *   2. Persist `executionMode` into instance general settings (so the per-run
 *      heartbeat guard enforces it).
 *   3. Idempotently ensure a configured Kubernetes sandbox environment for every
 *      company (mirrors `ensureLocalEnvironment`).
 *
 * The boot hook is *configuration convenience*; the actual security gate is the
 * per-run guard in the heartbeat (see `execution-allowlist.ts`). Even with no
 * boot hook, setting `executionMode=kubernetes` denies local execution.
 *
 * The env-var parsing is a pure function so it is trivially unit-testable.
 */

import type { Db } from "@paperclipai/db";
import type { InstanceExecutionMode } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { environmentService, type KubernetesEnvironmentConfigInput } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { parseAdapterRegistryEnv } from "./adapter-registry-bootstrap.js";

export type ExecutionPolicyBootstrapEnv = Record<string, string | undefined>;

/**
 * Parsed forced-execution bootstrap.
 *
 * - `kubernetes`: provider-pinned; carries the managed Kubernetes config so the
 *   boot hook can provision a k8s environment per company.
 * - `sandbox`: provider-agnostic; the operator configures their sandbox provider
 *   through the normal environment flow, so the boot hook only persists the
 *   setting and provisions nothing.
 */
export type ExecutionPolicyBootstrap =
  | {
      executionMode: Extract<InstanceExecutionMode, "kubernetes">;
      kubernetesConfig: KubernetesEnvironmentConfigInput;
    }
  | {
      executionMode: Extract<InstanceExecutionMode, "sandbox">;
    };

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
 * Parse the forced-execution-mode env config. Returns null when execution is
 * unrestricted (no env, or `PAPERCLIP_EXECUTION_MODE=any`). Throws on an
 * unrecognized mode so a misconfigured deployment fails loudly instead of
 * silently allowing local execution.
 */
export function parseExecutionPolicyBootstrapEnv(
  env: ExecutionPolicyBootstrapEnv,
): ExecutionPolicyBootstrap | null {
  const raw = env.PAPERCLIP_EXECUTION_MODE?.trim();
  if (!raw || raw === "any") return null;
  if (raw === "sandbox") {
    // Provider-agnostic: the operator configures their sandbox provider via the
    // normal environment flow; the boot hook only persists the setting.
    return { executionMode: "sandbox" };
  }
  if (raw !== "kubernetes") {
    throw new Error(
      `PAPERCLIP_EXECUTION_MODE must be "kubernetes", "sandbox", or "any" (got "${raw}").`,
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

  return { executionMode: "kubernetes", kubernetesConfig };
}

/**
 * Apply the parsed bootstrap to the database: persist `executionMode` into
 * instance settings and, for the Kubernetes mode, ensure a configured
 * Kubernetes environment for every company. Idempotent; safe to call on every
 * boot.
 *
 * For `executionMode=sandbox` there is nothing to provision — the operator
 * configures their sandbox provider through the normal environment flow — so we
 * only persist the setting and the per-run heartbeat guard enforces it.
 */
export async function applyExecutionPolicyBootstrap(
  db: Db,
  bootstrap: ExecutionPolicyBootstrap,
): Promise<{ executionMode: InstanceExecutionMode; companiesConfigured: number }> {
  const instanceSettings = instanceSettingsService(db);
  const environments = environmentService(db);

  await instanceSettings.updateGeneral({ executionMode: bootstrap.executionMode });

  if (bootstrap.executionMode === "sandbox") {
    logger.info(
      { executionMode: bootstrap.executionMode },
      "applied provider-agnostic sandbox execution policy (no managed environment provisioned; configure a sandbox provider per company)",
    );
    return { executionMode: bootstrap.executionMode, companiesConfigured: 0 };
  }

  const companyIds = await instanceSettings.listCompanyIds();
  let configured = 0;
  const failedCompanyIds: string[] = [];
  for (const companyId of companyIds) {
    try {
      await environments.ensureKubernetesEnvironment(companyId, bootstrap.kubernetesConfig);
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

/**
 * Convenience: parse + apply from a raw env map. Returns null when unrestricted.
 */
export async function bootstrapExecutionPolicyFromEnv(
  db: Db,
  env: ExecutionPolicyBootstrapEnv = process.env,
): Promise<{ executionMode: InstanceExecutionMode; companiesConfigured: number } | null> {
  const bootstrap = parseExecutionPolicyBootstrapEnv(env);
  if (!bootstrap) return null;
  return applyExecutionPolicyBootstrap(db, bootstrap);
}
