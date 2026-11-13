import { and, eq } from "drizzle-orm";
import { environments, type Db } from "@paperclipai/db";
import type { AgentConfigurationWarning } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { pluginEnvironmentRunnerTaskDriver } from "./plugin-runner-ai-connection.js";

/** An environment whose task-execution plugin sets these variables itself. */
export interface ProtectedEnvironmentKeyHolder {
  environmentId: string;
  environmentName: string;
  keys: ReadonlySet<string>;
}

/**
 * Active plugin environments whose driver declares `protectedEnvironmentKeys`.
 * At run time the plugin's value wins over a configured one. Saving the key
 * where it would be overridden is rejected or answered with a notice.
 */
export async function listProtectedEnvironmentKeyHolders(db: Db): Promise<ProtectedEnvironmentKeyHolder[]> {
  const rows = await db.select({ id: environments.id, name: environments.name, driver: environments.driver, config: environments.config })
    .from(environments).where(and(eq(environments.driver, "plugin"), eq(environments.status, "active")));
  const holders: ProtectedEnvironmentKeyHolder[] = [];
  for (const row of rows) {
    const driver = await pluginEnvironmentRunnerTaskDriver(db, { driver: "plugin", config: row.config });
    const keys = driver?.protectedEnvironmentKeys ?? [];
    if (keys.length > 0) holders.push({ environmentId: row.id, environmentName: row.name, keys: new Set(keys) });
  }
  return holders;
}

function configuredKeys(env: unknown): string[] {
  return env !== null && typeof env === "object" && !Array.isArray(env) ? Object.keys(env) : [];
}

function rejectProtectedKeys(holder: { environmentId?: string; environmentName: string; keys: ReadonlySet<string> }, env: unknown): void {
  const keys = configuredKeys(env).filter(key => holder.keys.has(key)).sort();
  if (keys.length === 0) return;
  throw unprocessable(
    `${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set by ${holder.environmentName} on its tasks. `
      + `Remove ${keys.length === 1 ? "it" : "them"} from the environment variables, or choose another environment.`,
    { code: "protected_environment_variable", keys, ...(holder.environmentId ? { environmentId: holder.environmentId } : {}) },
  );
}

/** Reject keys that the agent's selected environment sets itself for its tasks. */
export function assertNoProtectedEnvironmentKeys(
  holders: readonly ProtectedEnvironmentKeyHolder[],
  environmentId: string | null | undefined,
  env: unknown,
): void {
  const holder = environmentId ? holders.find(candidate => candidate.environmentId === environmentId) : undefined;
  if (holder) rejectProtectedKeys(holder, env);
}

/** Reject an environment's own variables that its plugin driver sets itself. */
export async function assertEnvironmentVariablesNotProtected(
  db: Db,
  environment: { id?: string; name: string; driver: string; config: unknown },
  envVars: unknown,
): Promise<void> {
  if (environment.driver !== "plugin" || configuredKeys(envVars).length === 0) return;
  const config = environment.config !== null && typeof environment.config === "object" && !Array.isArray(environment.config)
    ? environment.config as Record<string, unknown> : {};
  const driver = await pluginEnvironmentRunnerTaskDriver(db, { driver: "plugin", config });
  const keys = driver?.protectedEnvironmentKeys ?? [];
  if (keys.length > 0) rejectProtectedKeys({ environmentId: environment.id, environmentName: environment.name, keys: new Set(keys) }, envVars);
}

/** A friendly notice: the value may be replaced, depending on where the agent runs. */
export function protectedEnvironmentKeyWarnings(
  holders: readonly ProtectedEnvironmentKeyHolder[],
  env: unknown,
  field: string,
): AgentConfigurationWarning[] {
  return configuredKeys(env).sort().flatMap(key => {
    const names = holders.filter(holder => holder.keys.has(key)).map(holder => holder.environmentName);
    if (names.length === 0) return [];
    return [{
      code: "protected_environment_variable" as const,
      field: `${field}.${key}`,
      message: `${key} is set by ${names.join(", ")} on ${names.length === 1 ? "its" : "their"} tasks. `
        + "Agents running there may see the platform's value instead of this one.",
    }];
  });
}
