function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveAgentHeartbeatDispatchPolicy(runtimeConfig: unknown): {
  executionModel: "push" | "pull";
  dispatchEnabled: boolean;
} {
  const config = parseObject(runtimeConfig);
  const executionModel = config.executionModel === "pull" ? "pull" : "push";
  if (executionModel === "push") {
    return { executionModel, dispatchEnabled: true };
  }

  const pull = parseObject(config.pull);
  return {
    executionModel,
    dispatchEnabled: pull.dispatchEnabled === true,
  };
}

/** Persist the pull default: heartbeat.enabled stays false unless dispatch is explicit. */
export function applyPullHeartbeatWriteGuard(runtimeConfig: unknown): Record<string, unknown> {
  const config = { ...parseObject(runtimeConfig) };
  const policy = resolveAgentHeartbeatDispatchPolicy(config);
  if (policy.executionModel !== "pull" || policy.dispatchEnabled) return config;
  const heartbeat = { ...parseObject(config.heartbeat) };
  heartbeat.enabled = false;
  config.heartbeat = heartbeat;
  return config;
}
