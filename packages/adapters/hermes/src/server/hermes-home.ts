/**
 * Hermes home resolver — the single source of truth for Hermes config,
 * skills, and environment discovery inside this adapter package.
 *
 * Precedence (matches design §4 + tasks.md task 1.3):
 *   1. env.HERMES_HOME if set — return as-is, no .hermes append
 *   2. env.HOME                  — return `<home>/.hermes`
 *   3. env.USERPROFILE           — return `<userprofile>/.hermes` (Windows)
 *   4. (homedir ?? os.homedir)() — return `<homedir>/.hermes`
 *
 * Result is always normalized through `path.resolve()` so callers see an
 * absolute path. Callers MUST NOT append `.hermes` themselves — that would
 * re-introduce the double-append bug this resolver exists to fix.
 *
 * The async variant is a thin promise wrapper for callers that prefer
 * async APIs; it intentionally does no I/O so the sync path is the only
 * meaningful behavior.
 */

import os from "node:os";
import path from "node:path";

export type HermesHomeEnv = Pick<NodeJS.ProcessEnv, "HERMES_HOME" | "HOME" | "USERPROFILE">;

export interface ResolveHermesHomeOptions {
  env?: Record<string, unknown> | NodeJS.ProcessEnv;
  homedir?: () => string;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readEnvValue(source: unknown, key: keyof HermesHomeEnv): string | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  return readNonEmptyString(record[key]);
}

/**
 * Read a value from the option-provided env first, then fall back to the
 * current process environment.
 *
 * If `options.env` is explicitly provided (even as an empty object), it acts
 * as a full override — process.env is NOT consulted. This lets tests inject
 * synthetic env values without mutating process.env, and lets callers that
 * want to reason about a particular env snapshot pass it in directly.
 */
function pick(key: keyof HermesHomeEnv, options: ResolveHermesHomeOptions | undefined): string | null {
  if (options && options.env !== undefined) {
    return readEnvValue(options.env, key);
  }
  return readEnvValue(process.env, key);
}

export function resolveHermesHomeSync(options?: ResolveHermesHomeOptions): string {
  const hermesHome = pick("HERMES_HOME", options);
  if (hermesHome !== null) {
    return path.resolve(hermesHome);
  }

  const home = pick("HOME", options);
  if (home !== null) {
    return path.resolve(home, ".hermes");
  }

  const userProfile = pick("USERPROFILE", options);
  if (userProfile !== null) {
    return path.resolve(userProfile, ".hermes");
  }

  const homedir = options?.homedir ?? os.homedir;
  return path.resolve(homedir(), ".hermes");
}

export async function resolveHermesHome(options?: ResolveHermesHomeOptions): Promise<string> {
  return resolveHermesHomeSync(options);
}