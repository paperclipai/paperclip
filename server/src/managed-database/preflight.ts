import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  MANAGED_DATABASE_ENV,
  MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS,
  type ManagedDatabaseConfig,
} from "@paperclipai/shared/managed-database";
import { readDataDirectoryMajor } from "./engine.js";
import { readJsonIfExists, type ManagedDatabaseLayout } from "./layout.js";

export type InitializationMarker = {
  v: 1;
  status: "initializing" | "ready";
  stackId: string;
  volumeId: string;
  initializationId: string;
  engineMajor: number;
  systemIdentifier: string | null;
  createdAt: string;
  readyAt: string | null;
};

export type VolumeIdentity = {
  v: 1;
  stackId: string;
  volumeId: string;
  createdAt: string;
};

export type PreflightPlan =
  /** Authorized first initialization on an empty volume. */
  | { action: "initialize" }
  /** A first initialization crashed before readiness; safe to redo. */
  | { action: "resume-initialize"; marker: InitializationMarker }
  | { action: "existing"; marker: InitializationMarker };

export class ManagedDatabasePreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(`managed database preflight failed [${code}]: ${message}`);
    this.name = "ManagedDatabasePreflightError";
  }
}

function fail(code: string, message: string): never {
  throw new ManagedDatabasePreflightError(code, message);
}

export type PreflightInput = {
  config: ManagedDatabaseConfig;
  layout: ManagedDatabaseLayout;
  env: NodeJS.ProcessEnv;
  engineMajor: number;
  /** Device id lookup; injectable for tests. */
  deviceOf?: (target: string) => number;
  /** uid that must own the supervisor's files (the supervisor's own uid). */
  ownerUid?: number;
};

/**
 * Supervisor state must be real files owned by the supervisor. The app user
 * owns the rest of the volume, so it must not be able to plant a symlink or
 * a substitute marker that the root supervisor would trust.
 */
function assertTrustedEntry(target: string, kind: "directory" | "file", ownerUid: number | undefined): void {
  if (!existsSync(target) && !isSymlink(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) fail("untrusted_path", `${target} is a symbolic link`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) fail("untrusted_path", `${target} is not a ${kind}`);
  if (ownerUid !== undefined && stat.uid !== ownerUid) fail("untrusted_path", `${target} is owned by uid ${stat.uid}, expected ${ownerUid}`);
}

/**
 * Rename and unlink permission comes from the parent directory, so the
 * supervisor's own modes protect nothing while another user can write a
 * directory above it: the app could move the supervisor's directory aside and
 * plant its own tree where the root supervisor writes. Every ancestor, through
 * any symbolic link, must be owned by the supervisor or root and be writable
 * by nobody else, or be sticky (others can then rename only their own entries).
 */
function assertProtectedAncestors(root: string, ownerUid: number | undefined): void {
  if (ownerUid === undefined) return;
  const chain = (start: string) => {
    const dirs: string[] = [];
    for (let dir = start; ; dir = path.dirname(dir)) {
      dirs.push(dir);
      if (dir === path.dirname(dir)) return dirs;
    }
  };
  const literal = chain(path.dirname(root));
  const nearest = literal.find((dir) => existsSync(dir));
  const resolved = nearest ? chain(realpathSync(nearest)) : [];
  for (const dir of new Set([...literal, ...resolved])) {
    if (!existsSync(dir) && !isSymlink(dir)) continue;
    const stat = lstatSync(dir);
    if (stat.uid !== ownerUid && stat.uid !== 0) {
      fail("untrusted_path", `${dir} is owned by uid ${stat.uid}, so it can rename ${root}`);
    }
    if (stat.isDirectory() && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      fail("untrusted_path", `${dir} is writable by other users and not sticky, so they can rename ${root}`);
    }
  }
}

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectoryEmpty(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** Conflicting external database settings are refused outright. */
export function assertNoExternalDatabaseSettings(env: NodeJS.ProcessEnv): void {
  for (const name of ["DATABASE_URL", "DATABASE_MIGRATION_URL", MANAGED_DATABASE_ENV.pluginMigrationUrl]) {
    if (env[name] !== undefined && env[name]!.trim() !== "") {
      fail("conflicting_external_database", `${name} must not be set beside ${MANAGED_DATABASE_ENV.config}`);
    }
  }
}

/**
 * Every check runs before anything is written to the volume. The ordering
 * matters: identity mismatches are reported before version mismatches so an
 * operator sees "wrong volume" rather than a misleading engine error.
 */
export function runManagedDatabasePreflight(input: PreflightInput): PreflightPlan {
  const { config, layout, env } = input;
  const deviceOf = input.deviceOf ?? ((target: string) => statSync(target).dev);

  assertNoExternalDatabaseSettings(env);

  if (!(MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS as readonly number[]).includes(config.engineMajor)) {
    fail("unsupported_engine_major", `engine major ${config.engineMajor} is not supported by this image (supports ${MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS.join(", ")})`);
  }
  if (input.engineMajor !== config.engineMajor) {
    fail("engine_mismatch", `config pins PostgreSQL ${config.engineMajor} but this image bundles PostgreSQL ${input.engineMajor}`);
  }

  // Volume: the mount must exist, be a different filesystem from "/", and
  // match the platform's volume id when one is published.
  const mountPath = path.resolve(config.volume.mountPath);
  if (!existsSync(mountPath)) fail("volume_missing", `${mountPath} does not exist`);
  if (deviceOf(mountPath) === deviceOf("/")) {
    fail("volume_not_mounted", `${mountPath} is on the root filesystem; the stack volume is not attached`);
  }
  if (config.volume.idEnvVar) {
    const published = env[config.volume.idEnvVar];
    if (!published) fail("volume_id_unavailable", `${config.volume.idEnvVar} is not set`);
    if (published !== config.volume.id) {
      fail("volume_mismatch", `${config.volume.idEnvVar}=${published} does not match configured volume ${config.volume.id}`);
    }
  }
  const ownerUid = "ownerUid" in input ? input.ownerUid : process.getuid?.();
  assertTrustedEntry(layout.root, "directory", ownerUid);
  assertTrustedEntry(layout.volumeIdentityFile, "file", ownerUid);
  assertTrustedEntry(layout.markerFile, "file", ownerUid);
  assertTrustedEntry(layout.secretsDir, "directory", ownerUid);
  assertProtectedAncestors(layout.root, ownerUid);
  const identity = readJsonIfExists<VolumeIdentity>(layout.volumeIdentityFile);
  if (identity && (identity.stackId !== config.stackId || identity.volumeId !== config.volume.id)) {
    fail("volume_mismatch", `volume belongs to stack ${identity.stackId} volume ${identity.volumeId}`);
  }

  const marker = readJsonIfExists<InitializationMarker>(layout.markerFile);
  const cluster = config.cluster;

  if (!marker) {
    if (cluster.state === "existing") {
      fail("cluster_missing", "config names an established cluster but the volume has no initialization marker; refusing to create an empty database");
    }
    if (!isDirectoryEmpty(layout.dataDir)) {
      fail("unexpected_data", `${layout.dataDir} has data but no initialization marker`);
    }
    return { action: "initialize" };
  }

  if (marker.stackId !== config.stackId || marker.volumeId !== config.volume.id) {
    fail("marker_mismatch", `marker belongs to stack ${marker.stackId} volume ${marker.volumeId}`);
  }
  if (!identity) fail("volume_identity_missing", "initialization marker exists but the volume identity file is missing");
  if (marker.initializationId !== cluster.initializationId) {
    fail("initialization_mismatch", `volume was initialized by ${marker.initializationId}, config names ${cluster.initializationId}`);
  }
  if (marker.engineMajor !== config.engineMajor) {
    fail("engine_mismatch", `cluster was initialized with PostgreSQL ${marker.engineMajor}; config pins ${config.engineMajor}`);
  }

  if (marker.status === "initializing") {
    if (cluster.state !== "initialize") {
      fail("initialization_incomplete", "first initialization never completed; only an initialize config may resume it");
    }
    return { action: "resume-initialize", marker };
  }

  if (cluster.state === "existing" && marker.systemIdentifier !== cluster.systemIdentifier) {
    fail("system_identifier_mismatch", `cluster ${marker.systemIdentifier} does not match configured ${cluster.systemIdentifier}`);
  }

  const dataMajor = readDataDirectoryMajor(layout.dataDir);
  if (dataMajor === null) {
    fail("cluster_missing", `${layout.dataDir}/PG_VERSION is missing on an established stack; refusing to create an empty database`);
  }
  if (dataMajor !== config.engineMajor) {
    fail("engine_mismatch", `data directory is PostgreSQL ${dataMajor}; config pins ${config.engineMajor}`);
  }
  return { action: "existing", marker };
}
