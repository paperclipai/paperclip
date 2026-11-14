// Type-only: the server loads this module at startup, before the runner package is built.
import type { RunnerConfinementMode, RunnerConfinementPolicy } from "@paperclipai/paperclip-runner/live";
import { resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { resolveMasterKeyFilePath } from "../../secrets/local-encrypted-provider.js";
import { loadStorageConfig } from "../../storage/config.js";

/** Mirrors RUNNER_CONFINEMENT_ENV and RUNNER_CONFINEMENT_UNAVAILABLE in the runner package. */
export const LOCAL_RUNNER_CONFINEMENT_ENV = "PAPERCLIP_LOCAL_AGENT_CONFINEMENT";
export const RUNNER_CONFINEMENT_UNAVAILABLE = "runner_confinement_unavailable";

let embeddedDatabase: { port: number; dataDir: string } | null = null;
let configuredPrivatePaths: string[] | null = null;

/** Records the embedded database, whose port and files confined local sessions may not reach. */
export function setLocalRunnerConfinementDatabase(database: { port: number; dataDir: string } | null) {
  embeddedDatabase = database;
}

/** Test seam: forget the configured private paths. */
export function resetLocalRunnerConfinementPaths() {
  configuredPrivatePaths = null;
}

/** The root that holds every local session's runner state. */
export function runnerdStateBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCLIP_RUNNER_STATE_DIR ??
    resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "durable-sessions");
}

export function resolveLocalRunnerConfinementMode(env: NodeJS.ProcessEnv = process.env): RunnerConfinementMode {
  const value = env[LOCAL_RUNNER_CONFINEMENT_ENV]?.trim().toLowerCase();
  return value === "off" || value === "required" ? value : "auto";
}

/**
 * Operator-configured locations of instance-private data. They can lie outside
 * the instance root, so the scope hides the resolved paths, not only defaults.
 */
function privatePaths(env: NodeJS.ProcessEnv) {
  if (configuredPrivatePaths === null) {
    const storage = loadStorageConfig(undefined, env);
    configuredPrivatePaths = [
      ...(storage.storageProvider === "local_disk" ? [storage.storageLocalDiskBaseDir] : []),
      resolveMasterKeyFilePath(env),
    ].map((path) => resolve(path));
  }
  return [...configuredPrivatePaths, ...(embeddedDatabase ? [resolve(embeddedDatabase.dataDir)] : [])];
}

/**
 * The confinement applied to local runnerd launches. Companies on one instance
 * share the server's operating-system user, so each local session is kept to
 * its own state. `PAPERCLIP_LOCAL_AGENT_CONFINEMENT` selects `auto` (default),
 * `required` or `off`.
 */
export function localRunnerConfinementPolicy(companyId: string, env: NodeJS.ProcessEnv = process.env): RunnerConfinementPolicy {
  return {
    mode: resolveLocalRunnerConfinementMode(env),
    instanceRoot: resolvePaperclipInstanceRoot(),
    companyId,
    sessionStateRoots: [resolve(runnerdStateBase(env))],
    privatePaths: privatePaths(env),
    deniedLoopbackPorts: embeddedDatabase ? [embeddedDatabase.port] : [],
  };
}
