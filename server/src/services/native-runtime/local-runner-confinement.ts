// Type-only: the server loads this module at startup, before the runner package is built.
import type { RunnerConfinementMode, RunnerConfinementPolicy } from "@paperclipai/paperclip-runner/live";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "../../paths.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { resolveMasterKeyFilePath } from "../../secrets/local-encrypted-provider.js";
import { loadStorageConfig } from "../../storage/config.js";

/** Mirrors RUNNER_CONFINEMENT_ENV and RUNNER_CONFINEMENT_UNAVAILABLE in the runner package. */
export const LOCAL_RUNNER_CONFINEMENT_ENV = "PAPERCLIP_LOCAL_AGENT_CONFINEMENT";
export const RUNNER_CONFINEMENT_UNAVAILABLE = "runner_confinement_unavailable";

let embeddedDatabase: { port: number; dataDir: string } | null = null;
let configuredPrivatePaths: string[] | null = null;
let installationRoot: string | null | undefined;

/** Records the embedded database, whose port and files confined local sessions may not reach. */
export function setLocalRunnerConfinementDatabase(database: { port: number; dataDir: string } | null) {
  embeddedDatabase = database;
}

/** Test seam: forget the configured private paths. */
export function resetLocalRunnerConfinementPaths() {
  configuredPrivatePaths = null;
  installationRoot = undefined;
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
    // The configuration and environment files the server read can hold
    // instance-wide credentials (provider keys, database connection strings).
    const workingDirectoryEnv = resolve(process.cwd(), ".env");
    configuredPrivatePaths = [
      ...(storage.storageProvider === "local_disk" ? [storage.storageLocalDiskBaseDir] : []),
      resolveMasterKeyFilePath(env),
      resolvePaperclipConfigPath(),
      resolvePaperclipEnvPath(),
      ...(existsSync(workingDirectoryEnv) ? [workingDirectoryEnv] : []),
    ].map((path) => resolve(path));
  }
  return [...configuredPrivatePaths, ...(embeddedDatabase ? [resolve(embeddedDatabase.dataDir)] : [])];
}

/**
 * The installed server package and its dependencies, which a session may run
 * but not change: the next server start would execute a replaced file outside
 * any session's scope. A source checkout (it has `.git`) is where developers
 * point agents, so it stays writable. Never the home directory or the root.
 */
export function serverInstallationRoot(moduleFile: string = fileURLToPath(import.meta.url), home: string = homedir()): string | null {
  const segments = resolve(moduleFile).split(sep);
  const packages = segments.indexOf("node_modules");
  let root: string | null = null;
  if (packages > 0) {
    // The package directly beneath the outermost node_modules (a scope counts with its package).
    const end = packages + (segments[packages + 1]?.startsWith("@") ? 3 : 2);
    root = segments.slice(0, Math.min(end, segments.length)).join(sep) || null;
  } else {
    for (let directory = dirname(resolve(moduleFile)); directory !== parse(directory).root; directory = dirname(directory)) {
      if (existsSync(join(directory, "node_modules"))) { root = directory; break; }
    }
  }
  if (!root) return null;
  // Outside node_modules the server runs from its own files: a Git checkout
  // there (its .git may sit above the server package, as in the monorepo) is
  // Paperclip source and stays writable. A package under node_modules is an
  // install even inside another project's checkout.
  if (packages <= 0) {
    for (let directory = dirname(resolve(moduleFile)); ; directory = dirname(directory)) {
      if (existsSync(join(directory, ".git"))) return null;
      if (directory === parse(directory).root) break;
    }
  }
  const resolvedHome = resolve(home);
  if (root === parse(root).root || resolvedHome === root || resolvedHome.startsWith(`${root}${sep}`)) return null;
  return root;
}

function readOnlyPaths() {
  if (installationRoot === undefined) installationRoot = serverInstallationRoot();
  return installationRoot ? [installationRoot] : [];
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
    readOnlyPaths: readOnlyPaths(),
    deniedLoopbackPorts: embeddedDatabase ? [embeddedDatabase.port] : [],
  };
}
