import type { AdapterExecutionTargetTimeoutPolicy } from "./execution-target.js";

/**
 * Env-var override for the deployment-wide adapter run timeout. This is the
 * lowest layer of the precedence chain: the instance setting
 * (`adapterRunTimeoutSec`) wins when it is set, and this variable supplies the
 * value for deployments that never write that setting (and, for hosts that
 * prefer configuration from the environment, a fleet-wide default).
 *
 * Sign conventions match the per-agent `adapterConfig.timeoutSec` field:
 *   - positive -> wall-clock timeout in seconds
 *   - negative -> explicit "no wall clock" for every unconfigured agent
 *   - 0 / blank / unset -> no policy, which leaves the historical
 *     `{ timeoutSec: 0, source: "unlimited" }` outcome for local and SSH
 */
export const ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY = "PAPERCLIP_ADAPTER_RUN_TIMEOUT_SEC";

/**
 * Parse a policy wall clock out of a raw setting or env-var string. Returns
 * null for anything that cannot express a policy: unset, blank, non-numeric,
 * non-finite, or bare 0 (which carries no intent, mirroring the per-agent
 * field). A negative value is returned as-is: it is the opt-out.
 *
 * Throws on a non-numeric or non-finite value so a typo fails loudly at boot
 * instead of silently reverting an operator's timeout policy to "unlimited".
 */
export function parseAdapterRunTimeoutPolicySec(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw === 0) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY} must be a number of seconds (got ${JSON.stringify(trimmed)})`,
    );
  }
  if (parsed === 0) return null;
  return parsed;
}

export interface AdapterRunTimeoutPolicySources {
  /** Instance/company setting value; wins over `envSec` when it parses. */
  instanceSec?: number | string | null;
  /** Env-var value; used only when the instance setting is absent. */
  envSec?: number | string | null;
  /** Which layer owns the returned value, for logs. Defaults to `env_default`. */
  source?: AdapterExecutionTargetTimeoutPolicy["source"];
}

/**
 * Collapse the two policy layers into the single value the resolver consumes.
 * Precedence: instance setting, then env var, then no policy. An explicitly
 * negative value from either layer is an opt-out and is preserved, so the
 * fallback chain never silently re-adds a wall clock.
 */
export function resolveAdapterRunTimeoutPolicy(
  sources: AdapterRunTimeoutPolicySources = {},
): AdapterExecutionTargetTimeoutPolicy | null {
  const instanceSec = parseAdapterRunTimeoutPolicySec(sources.instanceSec ?? null);
  if (instanceSec !== null) {
    return { timeoutSec: instanceSec, source: "instance_default" };
  }
  const envSec = parseAdapterRunTimeoutPolicySec(sources.envSec ?? null);
  if (envSec !== null) {
    return { timeoutSec: envSec, source: sources.source ?? "env_default" };
  }
  return null;
}

/**
 * Read the env layer on its own. Callers that already know the instance
 * setting should use {@link resolveAdapterRunTimeoutPolicy} instead so the
 * precedence between the two layers stays in one place.
 */
export function readAdapterRunTimeoutPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): AdapterExecutionTargetTimeoutPolicy | null {
  return resolveAdapterRunTimeoutPolicy({ envSec: env[ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY] ?? null });
}
