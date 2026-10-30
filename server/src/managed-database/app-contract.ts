import { readFileSync } from "node:fs";
import {
  MANAGED_DATABASE_ENV,
  MANAGED_EMBEDDED_DATABASE_PROVIDER,
  managedDatabaseReadinessSchema,
  type ManagedDatabaseReadiness,
} from "@paperclipai/shared/managed-database";

export type ManagedEmbeddedAppDatabase = {
  databaseUrl: string;
  pluginMigrationUrl: string;
  controlSocket: string;
  readiness: ManagedDatabaseReadiness;
};

export class ManagedDatabaseAppContractError extends Error {
  constructor(message: string) {
    super(`managed embedded database: ${message}`);
    this.name = "ManagedDatabaseAppContractError";
  }
}

function requireLocalUrl(name: string, value: string | undefined, role: string): string {
  if (!value) throw new ManagedDatabaseAppContractError(`${name} is missing`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManagedDatabaseAppContractError(`${name} is not a URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ManagedDatabaseAppContractError(`${name} must be a postgres URL`);
  }
  if (parsed.hostname !== "127.0.0.1") throw new ManagedDatabaseAppContractError(`${name} must use loopback`);
  if (decodeURIComponent(parsed.username) !== role) throw new ManagedDatabaseAppContractError(`${name} must use role ${role}`);
  return value;
}

/**
 * Resolves the database contract for an app started by the managed database
 * supervisor. Returns null for every other deployment, which keeps the
 * existing DATABASE_URL rules (including the public-startup guard) intact.
 *
 * The app refuses to start when:
 * - supervisor-only inputs reach it (it was launched without the supervisor)
 * - the restricted connection, plugin connection, or readiness identity is
 *   missing or inconsistent
 * - the supervisor has not declared the schema current and serving
 */
export function resolveManagedEmbeddedAppDatabase(
  env: NodeJS.ProcessEnv,
  readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): ManagedEmbeddedAppDatabase | null {
  if (env[MANAGED_DATABASE_ENV.config] !== undefined || env[MANAGED_DATABASE_ENV.controlKey] !== undefined) {
    throw new ManagedDatabaseAppContractError(
      `${MANAGED_DATABASE_ENV.config} is set, but the app was not started by the managed database supervisor ` +
        "(node server/dist/managed-database/main.js run -- <app command>)",
    );
  }
  const provider = env[MANAGED_DATABASE_ENV.provider];
  if (provider === undefined || provider === "") return null;
  if (provider !== MANAGED_EMBEDDED_DATABASE_PROVIDER) {
    throw new ManagedDatabaseAppContractError(`unknown ${MANAGED_DATABASE_ENV.provider}=${provider}`);
  }
  if (env.DATABASE_MIGRATION_URL) {
    throw new ManagedDatabaseAppContractError("DATABASE_MIGRATION_URL must not reach the app; schema changes belong to the supervisor");
  }
  if (env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") {
    throw new ManagedDatabaseAppContractError("PAPERCLIP_MIGRATION_AUTO_APPLY must stay false");
  }
  const databaseUrl = requireLocalUrl("DATABASE_URL", env.DATABASE_URL, "paperclip_app");
  const pluginMigrationUrl = requireLocalUrl(MANAGED_DATABASE_ENV.pluginMigrationUrl, env[MANAGED_DATABASE_ENV.pluginMigrationUrl], "paperclip_plugin");
  const readinessFile = env[MANAGED_DATABASE_ENV.readinessFile];
  const controlSocket = env[MANAGED_DATABASE_ENV.controlSocket];
  const stackId = env[MANAGED_DATABASE_ENV.stackId];
  const generation = Number(env[MANAGED_DATABASE_ENV.configGeneration]);
  if (!readinessFile || !controlSocket || !stackId || !Number.isInteger(generation)) {
    throw new ManagedDatabaseAppContractError("supervisor identity variables are incomplete");
  }
  let readiness: ManagedDatabaseReadiness;
  try {
    readiness = managedDatabaseReadinessSchema.parse(JSON.parse(readText(readinessFile)));
  } catch (error) {
    throw new ManagedDatabaseAppContractError(`readiness file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (readiness.stackId !== stackId || readiness.configGeneration !== generation) {
    throw new ManagedDatabaseAppContractError("readiness identity does not match this app's stack/generation");
  }
  if (readiness.status !== "serving" || readiness.mode !== "serving") {
    throw new ManagedDatabaseAppContractError(`supervisor reports ${readiness.status}; the app may not serve`);
  }
  if (readiness.schema.state !== "current" || readiness.hold) {
    throw new ManagedDatabaseAppContractError(`schema is ${readiness.schema.state}${readiness.hold ? ` with hold ${readiness.hold.reason}` : ""}`);
  }
  return { databaseUrl, pluginMigrationUrl, controlSocket, readiness };
}
