import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parse as parseEnvContents } from "dotenv";
import { expandHomePrefix } from "../home-paths.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";

const execFileAsync = promisify(execFile);
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]+$/;
const POSTGRES_STOP_TIMEOUT_MS = 10_000;
export const WORKTREE_INSTANCE_ROOT_METADATA_KEY = "worktreeInstanceRoot";

export function deriveWorktreeInstanceId(workspacePath: string): string {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const normalized = path.basename(resolvedWorkspacePath)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48);
  const pathHash = createHash("sha256").update(resolvedWorkspacePath).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

/**
 * The instance id a seeded worktree actually runs as, read from the pointer the
 * guest process itself loads.
 *
 * Synchronous and null-on-anything-unexpected by design: callers use it to
 * decide whether they can prove workspace identity at all, and an unsafe or
 * unreadable pointer must fail closed rather than fall back to a guess.
 */
export function readWorktreeInstanceId(workspacePath: string): string | null {
  const envPath = path.join(path.resolve(workspacePath), ".paperclip", ".env");
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  const instanceId = parseEnvContents(contents).PAPERCLIP_INSTANCE_ID?.trim();
  if (!instanceId || !INSTANCE_ID_RE.test(instanceId)) return null;
  return instanceId;
}

export type WorktreeInstancePointer = {
  envPath: string;
  envContents: string;
};

export type WorktreeInstanceCleanupResult =
  | { status: "not_configured" }
  | { status: "already_absent"; instanceRoot: string }
  | { status: "refused"; instanceRoot: string | null; warning: string }
  | { status: "removed"; instanceRoot: string; postgresStopped: boolean };

export type WorktreeInstanceCleanupDependencies = {
  stopEmbeddedPostgres: (dataDir: string) => Promise<boolean>;
  removeInstanceRoot: (instanceRoot: string) => Promise<void>;
};

export type EmbeddedPostgresStopDependencies = {
  processIsAlive: (pid: number) => boolean;
  readVerifiedPostgresCommand: (pid: number, dataDir: string) => Promise<string | null>;
  signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  wait: (milliseconds: number) => Promise<unknown>;
};

const defaultCleanupDependencies: WorktreeInstanceCleanupDependencies = {
  stopEmbeddedPostgres: stopEmbeddedPostgresIfRunning,
  removeInstanceRoot: async (instanceRoot) => {
    await fs.rm(instanceRoot, { recursive: true, force: true });
  },
};

const defaultPostgresStopDependencies: EmbeddedPostgresStopDependencies = {
  processIsAlive,
  readVerifiedPostgresCommand,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  wait: delay,
};

function isStrictChildPath(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathExists(value: string): Promise<boolean> {
  return fs.lstat(value).then(() => true).catch(() => false);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readVerifiedPostgresCommand(pid: number, dataDir: string): Promise<string | null> {
  if (process.platform === "linux") {
    const commandLinePath = `/proc/${pid}/cmdline`;
    let commandLine: string;
    try {
      commandLine = await fs.readFile(commandLinePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const args = commandLine.split("\0").filter(Boolean);
    const executable = path.basename(args[0] ?? "");
    const dataDirFlagIndex = args.indexOf("-D");
    const configuredDataDir = dataDirFlagIndex >= 0 ? args[dataDirFlagIndex + 1] : null;
    if (!executable.includes("postgres") || !configuredDataDir) {
      throw new Error(`Refusing to signal process ${pid}: it is not the expected embedded PostgreSQL process.`);
    }
    const canonicalConfiguredDataDir = await fs.realpath(configuredDataDir).catch(() => path.resolve(configuredDataDir));
    if (canonicalConfiguredDataDir !== dataDir) {
      throw new Error(`Refusing to signal process ${pid}: its PostgreSQL data directory does not match ${dataDir}.`);
    }
    return args.join(" ");
  }

  if (process.platform === "win32") {
    throw new Error(`Refusing to signal process ${pid}: safe PostgreSQL process verification is unavailable on Windows.`);
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const command = stdout.trim();
    if (!command) return null;
    if (!/(?:^|\/)postgres(?:\s|$)/.test(command) || !command.includes(dataDir)) {
      throw new Error(`Refusing to signal process ${pid}: it is not the expected embedded PostgreSQL process.`);
    }
    return command;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
}

export async function stopEmbeddedPostgresIfRunning(
  dataDir: string,
  dependencies: EmbeddedPostgresStopDependencies = defaultPostgresStopDependencies,
): Promise<boolean> {
  const postmasterPidPath = path.join(dataDir, "postmaster.pid");
  if (!await pathExists(postmasterPidPath)) return false;

  const canonicalDataDir = await fs.realpath(dataDir);
  const pidContents = await fs.readFile(postmasterPidPath, "utf8");
  const pidLines = pidContents.split(/\r?\n/);
  const pid = Number(pidLines[0]?.trim());
  const recordedDataDir = pidLines[1]?.trim();
  if (!Number.isInteger(pid) || pid <= 0 || !recordedDataDir) {
    throw new Error(`Refusing to remove ${dataDir}: its postmaster.pid is malformed.`);
  }

  const canonicalRecordedDataDir = await fs.realpath(recordedDataDir).catch(() => path.resolve(recordedDataDir));
  if (canonicalRecordedDataDir !== canonicalDataDir) {
    throw new Error(`Refusing to remove ${dataDir}: postmaster.pid points at a different PostgreSQL data directory.`);
  }
  if (!dependencies.processIsAlive(pid)) return false;
  if (await dependencies.readVerifiedPostgresCommand(pid, canonicalDataDir) === null) return false;

  try {
    dependencies.signalProcess(pid, "SIGINT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  const deadline = Date.now() + POSTGRES_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!dependencies.processIsAlive(pid)) return true;
    await dependencies.wait(100);
  }
  throw new Error(`Embedded PostgreSQL process ${pid} did not stop within ${POSTGRES_STOP_TIMEOUT_MS}ms.`);
}

export async function readWorktreeInstancePointer(workspacePath: string): Promise<WorktreeInstancePointer | null> {
  const envPath = path.join(workspacePath, ".paperclip", ".env");
  try {
    return {
      envPath,
      envContents: await fs.readFile(envPath, "utf8"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveConfiguredInstanceRoot(pointer: WorktreeInstancePointer, expectedInstanceId?: string):
  | { instanceRoot: string; instanceId: string }
  | { warning: string; instanceRoot: string | null; refusalReason: string | null } {
  const env = parseEnvContents(pointer.envContents);
  const configuredHome = env.PAPERCLIP_HOME?.trim();
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
  if (!configuredHome || !instanceId) {
    return { warning: "", instanceRoot: null, refusalReason: null };
  }
  if (!INSTANCE_ID_RE.test(instanceId)) {
    return {
      instanceRoot: null,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_INSTANCE_ID is not a safe path segment.`,
      refusalReason: "unsafe_instance_id",
    };
  }

  const expandedHome = expandHomePrefix(configuredHome);
  if (!path.isAbsolute(expandedHome)) {
    return {
      instanceRoot: null,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_HOME is not absolute.`,
      refusalReason: "non_absolute_home",
    };
  }
  const instanceRoot = path.resolve(expandedHome, "instances", instanceId);
  if (expectedInstanceId && instanceId !== expectedInstanceId) {
    return {
      instanceRoot,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_INSTANCE_ID "${instanceId}" does not match the expected workspace instance "${expectedInstanceId}".`,
      refusalReason: "instance_id_mismatch",
    };
  }
  return { instanceRoot, instanceId };
}

function resolveManagedInstancesDir(worktreesDir?: string): string {
  const managedWorktreesDir = path.resolve(
    expandHomePrefix(
      worktreesDir?.trim()
      || process.env.PAPERCLIP_WORKTREES_DIR?.trim()
      || path.join(os.homedir(), ".paperclip-worktrees"),
    ),
  );
  return path.join(managedWorktreesDir, "instances");
}

export async function readManagedWorktreeInstanceOwnership(
  workspacePath: string,
  worktreesDir?: string,
): Promise<{ instanceRoot: string; instanceId: string } | null> {
  const pointer = await readWorktreeInstancePointer(workspacePath);
  if (!pointer) return null;
  const configured = resolveConfiguredInstanceRoot(pointer);
  if ("warning" in configured) {
    if (!configured.warning) return null;
    throw new Error(configured.warning);
  }
  const managedInstancesDir = resolveManagedInstancesDir(worktreesDir);
  if (!isStrictChildPath(configured.instanceRoot, managedInstancesDir)) {
    throw new Error(
      `Refusing to record worktree instance ownership for "${configured.instanceRoot}" because it is outside "${managedInstancesDir}".`,
    );
  }
  return configured;
}

export async function cleanupWorktreeInstanceArtifacts(input: {
  pointer: WorktreeInstancePointer;
  workspaceId: string;
  workspacePath: string;
  expectedInstanceId: string;
  expectedInstanceRoot: string | null;
  recorder?: WorkspaceOperationRecorder | null;
  worktreesDir?: string;
  dependencies?: WorktreeInstanceCleanupDependencies;
}): Promise<WorktreeInstanceCleanupResult> {
  const configured = resolveConfiguredInstanceRoot(input.pointer, input.expectedInstanceId);
  if ("warning" in configured && !configured.warning) return { status: "not_configured" };

  const managedInstancesDir = resolveManagedInstancesDir(input.worktreesDir);
  const managedWorktreesDir = path.dirname(managedInstancesDir);
  const configuredInstanceRoot = configured.instanceRoot;
  let warning = "warning" in configured ? configured.warning : "";
  const recordRefusal = async (
    metadata: Record<string, unknown>,
    refusalWarning = warning,
  ) => {
    if (!input.recorder) return;
    await input.recorder.recordOperation({
      phase: "workspace_teardown",
      cwd: input.workspacePath,
      metadata: {
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        instanceRoot: configuredInstanceRoot,
        managedInstancesDir,
        cleanupAction: "remove_worktree_instance",
        ...metadata,
      },
      run: async () => ({ status: "skipped", system: `${refusalWarning}\n` }),
    });
  };

  if ("warning" in configured) {
    await recordRefusal({ refusalReason: configured.refusalReason }, configured.warning);
    return { status: "refused", instanceRoot: configured.instanceRoot, warning: configured.warning };
  }

  if (!configuredInstanceRoot || !isStrictChildPath(configuredInstanceRoot, managedInstancesDir)) {
    warning ||= `Refusing to remove instance directory "${configuredInstanceRoot ?? "unknown"}" because it is outside "${managedInstancesDir}".`;
    await recordRefusal({ refusalReason: "outside_managed_instances_dir" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  const expectedInstanceRoot = input.expectedInstanceRoot ? path.resolve(input.expectedInstanceRoot) : null;
  if (!expectedInstanceRoot) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because execution workspace ${input.workspaceId} has no persisted instance root.`;
    await recordRefusal({ refusalReason: "persisted_instance_root_missing" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }
  if (expectedInstanceRoot && configuredInstanceRoot !== expectedInstanceRoot) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because it does not match execution workspace ${input.workspaceId}'s persisted instance root "${expectedInstanceRoot}".`;
    await recordRefusal({
      expectedInstanceRoot,
      refusalReason: "instance_root_workspace_mismatch",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (!await pathExists(configuredInstanceRoot)) {
    return { status: "already_absent", instanceRoot: configuredInstanceRoot };
  }

  let canonicalManagedWorktreesDir: string;
  let canonicalManagedInstancesDir: string;
  let canonicalInstanceRoot: string;
  try {
    [canonicalManagedWorktreesDir, canonicalManagedInstancesDir, canonicalInstanceRoot] = await Promise.all([
      fs.realpath(managedWorktreesDir),
      fs.realpath(managedInstancesDir),
      fs.realpath(configuredInstanceRoot),
    ]);
  } catch (error) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    await recordRefusal({ refusalReason: "canonical_path_unavailable" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (canonicalManagedInstancesDir !== path.join(canonicalManagedWorktreesDir, "instances")) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because the managed instances directory resolves outside "${canonicalManagedWorktreesDir}".`;
    await recordRefusal({
      canonicalInstanceRoot,
      canonicalManagedInstancesDir,
      refusalReason: "managed_instances_dir_symlink",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (!isStrictChildPath(canonicalInstanceRoot, canonicalManagedInstancesDir)) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path "${canonicalInstanceRoot}" is outside "${canonicalManagedInstancesDir}".`;
    await recordRefusal({
      canonicalInstanceRoot,
      canonicalManagedInstancesDir,
      refusalReason: "canonical_path_outside_managed_instances_dir",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  const dependencies = input.dependencies ?? defaultCleanupDependencies;
  let postgresStopped = false;
  const cleanup = async () => {
    postgresStopped = await dependencies.stopEmbeddedPostgres(path.join(canonicalInstanceRoot, "db"));
    const [currentManagedInstancesDir, currentInstanceRoot] = await Promise.all([
      fs.realpath(managedInstancesDir),
      fs.realpath(configuredInstanceRoot),
    ]);
    if (
      currentManagedInstancesDir !== canonicalManagedInstancesDir
      || currentInstanceRoot !== canonicalInstanceRoot
      || !isStrictChildPath(currentInstanceRoot, currentManagedInstancesDir)
    ) {
      throw new Error(`Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path changed during cleanup.`);
    }
    await dependencies.removeInstanceRoot(currentInstanceRoot);
  };

  if (input.recorder) {
    await input.recorder.recordOperation({
      phase: "workspace_teardown",
      cwd: input.workspacePath,
      metadata: {
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        instanceRoot: canonicalInstanceRoot,
        managedInstancesDir: canonicalManagedInstancesDir,
        cleanupAction: "remove_worktree_instance",
      },
      run: async () => {
        await cleanup();
        return {
          status: "succeeded",
          system: `Removed worktree instance directory ${canonicalInstanceRoot}\n`,
          metadata: { postgresStopped },
        };
      },
    });
  } else {
    await cleanup();
  }

  return { status: "removed", instanceRoot: canonicalInstanceRoot, postgresStopped };
}
