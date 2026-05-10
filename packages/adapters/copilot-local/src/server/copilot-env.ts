export function applyCopilotPermissionEnvDefaults(
  env: Record<string, string>,
  envConfig: Record<string, unknown>,
): void {
  if (
    Object.prototype.hasOwnProperty.call(envConfig, "COPILOT_ALLOW_ALL") &&
    typeof envConfig.COPILOT_ALLOW_ALL === "string"
  ) {
    return;
  }
  env.COPILOT_ALLOW_ALL = "false";
}

export function enablesCopilotAllowAll(env: Record<string, string>): boolean {
  const raw = env.COPILOT_ALLOW_ALL;
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}
