import { t } from "@/i18n";
import type { SecretAccessEvent } from "@paperclipai/shared";

/**
 * Delivery mode for an agent secret binding, derived from its `configPath`.
 *
 * The server (see `AGENT_ACCESS_CONFIG_PATH_PREFIX` in
 * `server/src/services/secrets.ts`) treats a binding's config path as the
 * source of truth for how a secret reaches the runtime:
 *  - `env.<KEY>`    — injected as an environment variable at run start.
 *  - `access.<ALIAS>` — fetched on demand via the run-bound agent API
 *                       (`GET /agents/me/secrets`), never written to the env.
 *  - anything else  — a generic adapter config path (rendered as "Config").
 */
export type SecretDeliveryMode = "env" | "api" | "config";

/** Prefix for env-var delivery config paths. Mirrors the server convention. */
export const ENV_CONFIG_PATH_PREFIX = "env.";
/** Prefix for API-access (no env var) delivery config paths. Mirrors the server's `AGENT_ACCESS_CONFIG_PATH_PREFIX`. */
export const AGENT_ACCESS_CONFIG_PATH_PREFIX = "access.";

/** Valid env-var name / access alias (matches the server's `ENV_KEY_RE`). */
export const SECRET_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deliveryModeForConfigPath(configPath: string | null | undefined): SecretDeliveryMode {
  if (!configPath) return "config";
  if (configPath.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) return "api";
  if (configPath.startsWith(ENV_CONFIG_PATH_PREFIX)) return "env";
  return "config";
}

/** Short human label for a delivery mode. */
export function deliveryModeLabel(mode: SecretDeliveryMode): string {
  switch (mode) {
    case "env":
      return t("localizationSecrets.deliveryEnv");
    case "api":
      return t("localizationSecrets.deliveryApi");
    default:
      return t("localizationSecrets.deliveryConfig");
  }
}

/** One-line explanation of a delivery mode, for tooltips/hints. */
export function deliveryModeDescription(mode: SecretDeliveryMode): string {
  switch (mode) {
    case "env":
      return t("localizationSecrets.deliveryEnvDescription");
    case "api":
      return t("localizationSecrets.deliveryApiDescription");
    default:
      return t("localizationSecrets.deliveryConfigDescription");
  }
}

/** The env KEY / access ALIAS carried by a config path (the part after the prefix). */
export function aliasFromConfigPath(configPath: string | null | undefined): string {
  if (!configPath) return "";
  if (configPath.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) {
    return configPath.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length);
  }
  if (configPath.startsWith(ENV_CONFIG_PATH_PREFIX)) {
    return configPath.slice(ENV_CONFIG_PATH_PREFIX.length);
  }
  return configPath;
}

/**
 * Human label for a secret access-event `consumerType`. Runtime consumers are
 * emitted as raw enum values (e.g. `agent_api`, `plugin_worker`) which read
 * poorly when merely capitalized; map the ones that need help explicitly.
 */
export function consumerTypeLabel(consumerType: SecretAccessEvent["consumerType"]): string {
  switch (consumerType) {
    case "agent_api":
      return t("localizationSecrets.consumerAgentApi");
    case "plugin_worker":
      return t("localizationSecrets.consumerPluginWorker");
    case "tool_connection":
      return t("localizationSecrets.consumerToolConnection");
    case "agent": return t("localizationSecrets.consumerAgent");
    case "project": return t("localizationSecrets.consumerProject");
    case "environment": return t("localizationSecrets.consumerEnvironment");
    case "routine": return t("localizationSecrets.consumerRoutine");
    case "plugin": return t("localizationSecrets.consumerPlugin");
    case "issue": return t("localizationSecrets.consumerIssue");
    case "run": return t("localizationSecrets.consumerRun");
    case "system": return t("localizationSecrets.consumerSystem");
    default:
      return String(consumerType).charAt(0).toUpperCase() + String(consumerType).slice(1);
  }
}
