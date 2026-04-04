import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_DARWIN_SERVER_ARGS,
  DEFAULT_DARWIN_SERVER_COMMAND,
  DEFAULT_SHARED_NAMESPACE,
  DEFAULT_STORE_ENABLED_ENV_VAR,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UPSTASH_TOKEN_ENV_VAR,
  DEFAULT_UPSTASH_URL_ENV_VAR,
} from "./constants.js";
import type {
  AccessMode,
  AgentPolicy,
  CompanyPolicy,
  DarwinBridgeConfig,
  EffectivePolicy,
} from "./types.js";

function isAccessMode(value: unknown): value is AccessMode {
  return value === "read" || value === "read-write" || value === "promote";
}

function parseJsonArray<T>(raw: unknown, map: (value: unknown) => T | null): T[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid plugin config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Expected plugin config JSON to be an array");
  }
  return parsed.map(map).filter((value): value is T => value !== null);
}

function mapCompanyPolicy(value: unknown): CompanyPolicy | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.companyId !== "string" || typeof row.namespace !== "string" || !isAccessMode(row.accessMode)) {
    return null;
  }
  return {
    companyId: row.companyId,
    namespace: row.namespace,
    accessMode: row.accessMode,
  };
}

function mapAgentPolicy(value: unknown): AgentPolicy | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.agentId !== "string") return null;
  if (row.namespace !== undefined && typeof row.namespace !== "string") return null;
  if (row.accessMode !== undefined && !isAccessMode(row.accessMode)) return null;
  return {
    agentId: row.agentId,
    namespace: typeof row.namespace === "string" ? row.namespace : undefined,
    accessMode: isAccessMode(row.accessMode) ? row.accessMode : undefined,
  };
}

export function parseCompanyPolicies(config: DarwinBridgeConfig): CompanyPolicy[] {
  return parseJsonArray(config.companyPoliciesJson, mapCompanyPolicy);
}

export function parseAgentPolicies(config: DarwinBridgeConfig): AgentPolicy[] {
  return parseJsonArray(config.agentPoliciesJson, mapAgentPolicy);
}

export function resolvePolicy(config: DarwinBridgeConfig, runCtx: ToolRunContext): EffectivePolicy | null {
  const agentPolicy = parseAgentPolicies(config).find((entry) => entry.agentId === runCtx.agentId);
  const companyPolicy = parseCompanyPolicies(config).find((entry) => entry.companyId === runCtx.companyId);

  const namespace = agentPolicy?.namespace ?? companyPolicy?.namespace;
  const accessMode = agentPolicy?.accessMode ?? companyPolicy?.accessMode;
  if (!namespace || !accessMode) return null;

  return { namespace, accessMode };
}

export function getSharedNamespace(config: DarwinBridgeConfig): string {
  return typeof config.sharedNamespace === "string" && config.sharedNamespace.trim() !== ""
    ? config.sharedNamespace
    : DEFAULT_SHARED_NAMESPACE;
}

export function parseDarwinServerArgs(config: DarwinBridgeConfig): string[] {
  const raw = typeof config.darwinServerArgsJson === "string" && config.darwinServerArgsJson.trim() !== ""
    ? config.darwinServerArgsJson
    : DEFAULT_DARWIN_SERVER_ARGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid darwinServerArgsJson: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("darwinServerArgsJson must be a JSON array of strings");
  }
  return parsed;
}

export function getDarwinServerCommand(config: DarwinBridgeConfig): string {
  return typeof config.darwinServerCommand === "string" && config.darwinServerCommand.trim() !== ""
    ? config.darwinServerCommand
    : DEFAULT_DARWIN_SERVER_COMMAND;
}

export function getTimeoutMs(config: DarwinBridgeConfig): number {
  return typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

export function buildDarwinEnv(
  config: DarwinBridgeConfig,
  secrets: { upstashUrl?: string; upstashToken?: string },
): NodeJS.ProcessEnv {
  const upstashUrlEnvVar = typeof config.upstashUrlEnvVar === "string" && config.upstashUrlEnvVar.trim() !== ""
    ? config.upstashUrlEnvVar
    : DEFAULT_UPSTASH_URL_ENV_VAR;
  const upstashTokenEnvVar = typeof config.upstashTokenEnvVar === "string" && config.upstashTokenEnvVar.trim() !== ""
    ? config.upstashTokenEnvVar
    : DEFAULT_UPSTASH_TOKEN_ENV_VAR;
  const storeEnabledEnvVar = typeof config.storeEnabledEnvVar === "string" && config.storeEnabledEnvVar.trim() !== ""
    ? config.storeEnabledEnvVar
    : DEFAULT_STORE_ENABLED_ENV_VAR;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  if (secrets.upstashUrl) {
    env[upstashUrlEnvVar] = secrets.upstashUrl;
  }
  if (secrets.upstashToken) {
    env[upstashTokenEnvVar] = secrets.upstashToken;
  }
  if (!env[storeEnabledEnvVar]) {
    env[storeEnabledEnvVar] = "true";
  }

  return env;
}
