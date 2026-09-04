// The `POSTGRES_NULL_SOCKET_GUARD_ENABLED` env-var contract, split into its
// own leaf module so both `postgres-null-socket-guard.ts` (to decide whether
// to register its `uncaughtException` listener) and `sentry.ts` (to decide
// whether Sentry's own `OnUncaughtException` integration must stay active)
// can read the same value without importing each other.

const GUARD_ENABLED_ENV_VAR = "POSTGRES_NULL_SOCKET_GUARD_ENABLED";

/**
 * Reads the runtime opt-out. An operator sets `false` or `0` to disable the
 * guard; every other value, including an unset variable, keeps it enabled.
 * Follows the same boolean convention as `envBoolean` in
 * `packages/db/src/client.ts`: a value other than a recognized true/false
 * spelling is a configuration mistake, so this throws instead of guessing.
 */
export function isGuardEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[GUARD_ENABLED_ENV_VAR]?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${GUARD_ENABLED_ENV_VAR} must be "true" or "false", got: ${env[GUARD_ENABLED_ENV_VAR]}`);
}
