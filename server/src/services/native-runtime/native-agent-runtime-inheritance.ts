/**
 * The small, non-sensitive portion of a native runner configuration that may
 * follow an agent when it hires a teammate. Keep this list closed: adapter
 * configuration also contains instructions paths, environment bindings, and
 * provider session identity that must remain owned by the new agent. A company
 * profile reference may be reused; the hire route revalidates its qualification.
 */
export const INHERITABLE_NATIVE_RUNNER_CONFIG_KEYS = [
  "provider",
  "acpxAgent",
  "model",
  "codexPermissionMode",
  "opencodePermissionMode",
  "acpxPermissionMode",
  "lifecycleMode",
  "modelReasoningEffort",
  "maxIterations",
  "maxOutputTokens",
  "timeoutSeconds",
  "idleTimeoutMs",
  "maxSessionListCostUsd",
  "maxEstimatedSessionCostUsd",
  "invocationLimits",
  "managedAgentsRetentionAcknowledged",
  "agentCoreRetentionAcknowledged",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INHERITABLE_INVOCATION_LIMIT_KEYS = [
  "maxIterations",
  "maxOutputTokens",
  "timeoutSeconds",
] as const;

function inheritedScalar(key: string, value: unknown): unknown {
  if (key === "maxIterations" || key === "maxOutputTokens" || key === "timeoutSeconds" || key === "idleTimeoutMs") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const bounds = key === "maxIterations" ? [1, 8] : key === "maxOutputTokens" ? [1, 4096] : key === "timeoutSeconds" ? [1, 300] : [1, 86_400_000];
    return value >= bounds[0] && value <= bounds[1] ? value : undefined;
  }
  if (key === "maxSessionListCostUsd" || key === "maxEstimatedSessionCostUsd") {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

export function inheritNativeRunnerAdapterConfig(adapterConfig: unknown): Record<string, unknown> {
  const source = isRecord(adapterConfig) ? adapterConfig : {};
  const inherited = Object.fromEntries(
    INHERITABLE_NATIVE_RUNNER_CONFIG_KEYS
      .filter((key) => key !== "invocationLimits")
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, inheritedScalar(key, source[key])])
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
  const invocationLimits = isRecord(source.invocationLimits) ? source.invocationLimits : null;
  const limits = invocationLimits
    ? Object.fromEntries(
        INHERITABLE_INVOCATION_LIMIT_KEYS
          .filter((key) => invocationLimits[key] !== undefined)
          .map((key) => [key, inheritedScalar(key, invocationLimits[key])])
          .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
      )
    : undefined;
  if (limits && Object.keys(limits).length > 0) inherited.invocationLimits = limits;
  // Copy only the selected provider's company profile reference, never a live
  // provider session or the profile contents. The route still checks company
  // ownership, enablement, retention, and current qualification before hiring.
  const profileKey = source.provider === "claude_managed"
    ? "managedProfileId"
    : source.provider === "aws_agentcore" ? "agentCoreProfileId" : null;
  if (profileKey) {
    const profileId = source[profileKey];
    if (typeof profileId === "string" && profileId.trim()) inherited[profileKey] = profileId;
  }
  return inherited;
}
