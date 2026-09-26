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

// Linux caps every individual exec argument and environment string at
// MAX_ARG_STRLEN (128 KiB with 4 KiB pages) and the whole argv+env block at
// RLIMIT_STACK/4 (~2 MiB with an 8 MiB stack). A value over either limit makes
// execve fail with E2BIG before the child starts. Prune any single oversized
// value regardless of key prefix, then keep the aggregate well under budget.
// The child either recovers the value via the Paperclip API or runs without it.
export const ENV_SINGLE_VALUE_MAX_BYTES = 64 * 1024;
export const ENV_AGGREGATE_MAX_BYTES = 1024 * 1024;

// PATH resolution and HOME-based lookup happen before the child runs, so
// pruning them breaks command resolution; they are also far below the budget
// in every real deployment.
const ENV_AGGREGATE_PROTECTED_KEYS = new Set(["PATH", "HOME"]);

export function pruneOversizedLaunchEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const kept: NodeJS.ProcessEnv = {};
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (Buffer.byteLength(value) > ENV_SINGLE_VALUE_MAX_BYTES) continue;
    kept[key] = value;
    totalBytes += key.length + value.length + 1;
  }
  if (totalBytes <= ENV_AGGREGATE_MAX_BYTES) return kept;
  const dropOrder = entries
    .filter(([key, value]) => key in kept && !ENV_AGGREGATE_PROTECTED_KEYS.has(key))
    .sort(
      (a, b) =>
        Buffer.byteLength(b[1]) - Buffer.byteLength(a[1]) ||
        (a[0] < b[0] ? -1 : 1),
    );
  for (const [key, value] of dropOrder) {
    if (totalBytes <= ENV_AGGREGATE_MAX_BYTES) break;
    delete kept[key];
    totalBytes -= key.length + value.length + 1;
  }
  return kept;
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
