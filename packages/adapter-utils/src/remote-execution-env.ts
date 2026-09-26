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

export function pruneOversizedLaunchEnvWithReport(
  env: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; dropped: string[] } {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const dropped: string[] = [];
  const kept: NodeJS.ProcessEnv = {};
  // execve counts UTF-8 bytes, not JavaScript characters: account in bytes.
  let totalBytes = 0;
  for (const [key, value] of entries) {
    const valueBytes = Buffer.byteLength(value);
    if (valueBytes > ENV_SINGLE_VALUE_MAX_BYTES) {
      dropped.push(key);
      continue;
    }
    kept[key] = value;
    totalBytes += Buffer.byteLength(key) + valueBytes + 1;
  }
  if (totalBytes > ENV_AGGREGATE_MAX_BYTES) {
    const dropOrder = entries
      .filter(
        ([key, value]) =>
          key in kept && !ENV_AGGREGATE_PROTECTED_KEYS.has(key),
      )
      .sort(
        (a, b) =>
          Buffer.byteLength(b[1]) - Buffer.byteLength(a[1]) ||
          (a[0] < b[0] ? -1 : 1),
      );
    for (const [key, value] of dropOrder) {
      if (totalBytes <= ENV_AGGREGATE_MAX_BYTES) break;
      delete kept[key];
      dropped.push(key);
      totalBytes -= Buffer.byteLength(key) + Buffer.byteLength(value) + 1;
    }
  }
  return { env: kept, dropped };
}

export function pruneOversizedLaunchEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return pruneOversizedLaunchEnvWithReport(env).env;
}

// The SSH lanes fold the whole remote environment into a single `sh -c`
// argv string, so the assembled env block has the per-string limit too.
// Budget the assembled `KEY=VALUE` block (quoting included) so several
// medium values cannot jointly exceed the per-argument exec limit.
export const SSH_REMOTE_ENV_MAX_BYTES = 64 * 1024;

export function budgetSshRemoteEnvWithReport(
  env: Record<string, string> | NodeJS.ProcessEnv,
): { env: Record<string, string>; dropped: string[] } {
  const { env: pruned, dropped } = pruneOversizedLaunchEnvWithReport(env);
  const kept: Record<string, string> = {};
  let totalBytes = 0;
  const candidates = Object.entries(pruned)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    // Keep the smallest entries first so the most configuration survives.
    .sort(
      (a, b) =>
        Buffer.byteLength(`${a[0]}=${a[1]}`) -
          Buffer.byteLength(`${b[0]}=${b[1]}`) ||
        (a[0] < b[0] ? -1 : 1),
    );
  for (const [key, value] of candidates) {
    // shellQuote wraps the value in single quotes and escapes embedded
    // quotes; ~8 bytes of overhead per entry bounds the worst case.
    const entryBytes = Buffer.byteLength(`${key}=${value}`) + 8;
    if (totalBytes + entryBytes > SSH_REMOTE_ENV_MAX_BYTES) {
      dropped.push(key);
      continue;
    }
    kept[key] = value;
    totalBytes += entryBytes;
  }
  return { env: kept, dropped };
}

export function budgetSshRemoteEnv(
  env: Record<string, string> | NodeJS.ProcessEnv,
): Record<string, string> {
  return budgetSshRemoteEnvWithReport(env).env;
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
