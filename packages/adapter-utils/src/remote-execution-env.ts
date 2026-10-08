/** Host control-plane credentials that must never be inherited into agent runs. */
export const REMOTE_EXECUTION_CONTROL_PLANE_SECRET_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "OMNIROUTE_API_KEY",
] as const;

export function readControlPlaneSecretEnvValues(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values: string[] = [];
  for (const key of REMOTE_EXECUTION_CONTROL_PLANE_SECRET_KEYS) {
    const value = readEnvValueCaseInsensitive(env, key);
    if (typeof value === "string" && value.length > 0) values.push(value);
  }
  return values;
}

const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
