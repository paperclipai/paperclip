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

const VERIFIED_REMOTE_EXECUTION_ENV_STARTUP_KEYS = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "KSH_ENV",
  "PS4",
  "SHELLOPTS",
  "ZDOTDIR",
]);

function isUnsafeVerifiedRemoteExecutionEnvKey(key: string): boolean {
  return key.startsWith("LD_") ||
    key.startsWith("DYLD_") ||
    VERIFIED_REMOTE_EXECUTION_ENV_STARTUP_KEYS.has(key);
}

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

/**
 * Reject environment controls that can execute or load target-controlled code
 * before an integrity-bound remote executable has been verified. This is
 * deliberately narrower than the general remote sanitizer: ordinary adapter
 * launches retain their existing environment contract.
 */
export function sanitizeVerifiedRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized = sanitizeRemoteExecutionEnv(env, inheritedEnv);
  for (const key of Object.keys(sanitized)) {
    if (isUnsafeVerifiedRemoteExecutionEnvKey(key)) {
      throw new Error(`paperclip_verified_remote_env_unsafe:${key}`);
    }
  }
  return sanitized;
}

/**
 * Build the local SSH-client environment for an integrity-bound remote start.
 * Remote runtime credentials travel only in the encoded remote command, while
 * local loader/startup hooks are removed before the transport process starts.
 */
export function sanitizeVerifiedRemoteTransportEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !isUnsafeVerifiedRemoteExecutionEnvKey(key)),
  );
}
