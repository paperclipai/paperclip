import { hashKey } from "@tanstack/react-query";
import type { Agent, AgentRunner, AiConnectionBinding } from "@paperclipai/shared";

const setupOwnedKeys = new Set([
  "model", "modelReasoningEffort", "reasoningEffort", "effort", "thinkingEffort",
  "thinking", "piThinkingLevel", "provider", "env", "apiKey", "authToken", "password",
  "repoUrl", "repoStartingRef", "apiBaseUrl", "kimiApi",
]);
const portableRuntimeKeys = new Set([
  "engine", "timeoutSec", "graceSec", "search", "fastMode",
  "dangerouslyBypassSandbox", "dangerouslyBypassApprovalsAndSandbox", "dangerouslySkipPermissions",
  "permissionMode", "acpPermissionMode", "nonInteractivePermissions", "warmHandleIdleMs", "mode",
]);

function legacyCredentialIdentity(env: unknown, adapterType: string): unknown[] {
  const values = env && typeof env === "object" && !Array.isArray(env) ? env as Record<string, unknown> : {};
  const keys = adapterType === "codex_local"
    ? ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"]
    : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
  return keys.map((key) => {
    const value = values[key];
    if (typeof value === "string") return value || null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const binding = value as Record<string, unknown>;
    if (binding.type === "plain") return binding.value || null;
    if (binding.type === "secret_ref") return [binding.type, binding.secretId, binding.version ?? "latest"];
    if (binding.type === "user_secret_ref") return [binding.type, binding.key, binding.version ?? "latest"];
    return value;
  });
}

export function preserveLocalSetupRuntimeConfig(config: Record<string, unknown>, input: {
  adapterType: string;
  runner: AgentRunner;
  environmentId: string | null;
  savedEnvironmentId: string | null | undefined;
  aiConnection?: AiConnectionBinding;
  saved: Pick<Agent, "adapterType" | "adapterConfig" | "runtimeConfig"> | null;
}): Record<string, unknown> {
  const { saved } = input;
  if (!saved || input.runner !== "legacy" || saved.adapterType !== input.adapterType
    || !["codex_local", "claude_local"].includes(input.adapterType)) return config;

  const sameTarget = input.savedEnvironmentId === input.environmentId;
  const result = { ...config };
  for (const [key, value] of Object.entries(saved.adapterConfig)) {
    if (!setupOwnedKeys.has(key) && (sameTarget || portableRuntimeKeys.has(key))) result[key] = value;
  }
  if (saved.adapterConfig.dangerouslyBypassSandbox !== undefined
    && saved.adapterConfig.dangerouslyBypassApprovalsAndSandbox === undefined) {
    delete result.dangerouslyBypassApprovalsAndSandbox;
  }
  if (sameTarget
    && hashKey([saved.runtimeConfig.aiConnection ?? null]) === hashKey([input.aiConnection ?? null])
    && hashKey(legacyCredentialIdentity(saved.adapterConfig.env, input.adapterType))
      === hashKey(legacyCredentialIdentity(config.env, input.adapterType))) {
    const env = saved.adapterConfig.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      result.env = { ...env, ...((config.env as object) ?? {}) };
    }
  }
  return result;
}
