import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

function resolveConfiguredInstanceRoot(pointer: WorktreeInstancePointer, expectedInstanceId: string):
  | { instanceRoot: string }
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
  if (instanceId !== expectedInstanceId) {
    return {
      instanceRoot,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_INSTANCE_ID "${instanceId}" does not match the expected workspace instance "${expectedInstanceId}".`,
      refusalReason: "instance_id_mismatch",
    };
  }
  return { instanceRoot };
}

export async function cleanupWorktreeInstanceArtifacts(input: {
  pointer: WorktreeInstancePointer;
  workspaceId: string;
  workspacePath: string;
  expectedInstanceId: string;
  recorder?: WorkspaceOperationRecorder | null;
  worktreesDir?: string;
  dependencies?: WorktreeInstanceCleanupDependencies;
}): Promise<WorktreeInstanceCleanupResult> {
  const configured = resolveConfiguredInstanceRoot(input.pointer, input.expectedInstanceId);
  if ("warning" in configured && !configured.warning) return { status: "not_configured" };

  const managedWorktreesDir = path.resolve(
    expandHomePrefix(input.worktreesDir?.trim() || process.env.PAPERCLIP_WORKTREES_DIR?.trim() || path.join(os.homedir(), ".paperclip-worktrees")),
  );
  const managedInstancesDir = path.join(managedWorktreesDir, "instances");
  const recordRefusal = async (
    instanceRoot: string | null,
    refusalWarning: string,
    metadata: Record<string, unknown>,
  ) => {
    if (!input.recorder) return;
    await input.recorder.recordOperation({
      phase: "workspace_teardown",
      cwd: input.workspacePath,
      metadata: {
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        instanceRoot,
        managedInstancesDir,
        cleanupAction: "remove_worktree_instance",
        ...metadata,
      },
      run: async () => ({ status: "skipped", system: `${refusalWarning}\n` }),
    });
  };

  if ("warning" in configured) {
    await recordRefusal(configured.instanceRoot, configured.warning, { refusalReason: configured.refusalReason });
    return { status: "refused", instanceRoot: configured.instanceRoot, warning: configured.warning };
  }

  const configuredInstanceRoot = configured.instanceRoot;
  let warning = "";

  if (!isStrictChildPath(configuredInstanceRoot, managedInstancesDir)) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because it is outside "${managedInstancesDir}".`;
    await recordRefusal(configuredInstanceRoot, warning, { refusalReason: "outside_managed_instances_dir" });
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
      fs.realpath(managedWorktreesDir, { encoding: "utf8" }),
      fs.realpath(managedInstancesDir, { encoding: "utf8" }),
      fs.realpath(configuredInstanceRoot, { encoding: "utf8" }),
    ]);
  } catch (error) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    await recordRefusal(configuredInstanceRoot, warning, { refusalReason: "canonical_path_unavailable" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (canonicalManagedInstancesDir !== path.join(canonicalManagedWorktreesDir, "instances")) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because the managed instances directory resolves outside "${canonicalManagedWorktreesDir}".`;
    await recordRefusal(configuredInstanceRoot, warning, {
      canonicalInstanceRoot,
      canonicalManagedInstancesDir,
      refusalReason: "managed_instances_dir_symlink",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (!isStrictChildPath(canonicalInstanceRoot, canonicalManagedInstancesDir)) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path "${canonicalInstanceRoot}" is outside "${canonicalManagedInstancesDir}".`;
    await recordRefusal(configuredInstanceRoot, warning, {
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
      fs.realpath(managedInstancesDir, { encoding: "utf8" }),
      fs.realpath(configuredInstanceRoot, { encoding: "utf8" }),
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
