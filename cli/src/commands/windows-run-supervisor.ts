import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../config/home.js";
import {
  readRuntimeInfo,
  removeRuntimeInfoForPid,
  type PaperclipRuntimeInfo,
} from "../runtime-info.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CHILD_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_GRACE_MS = 60_000;

export type WindowsRunHealth = {
  listenerOk: boolean;
  databaseBackupOk: boolean;
  databaseBackupStatus: string | null;
};

type SupervisedChild = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
  send?: (message: { type: string }) => unknown;
};

export const WINDOWS_RUN_ACCEPTANCE_HARNESS_ENV = "PAPERCLIP_WINDOWS_RUN_ACCEPTANCE_HARNESS";
export const WINDOWS_RUN_ACCEPTANCE_CLOSE_LISTENER = "paperclip:acceptance:close-listener";
export const WINDOWS_RUN_ACCEPTANCE_SHUTDOWN = "paperclip:acceptance:shutdown";

type WindowsRunSupervisorOptions = {
  instanceId: string;
  startChild: () => SupervisedChild;
  probeHealth: (childPid: number) => Promise<WindowsRunHealth>;
  stopChild: (child: SupervisedChild) => Promise<void>;
  log: (message: string) => void;
  failureThreshold?: number;
  startupGraceMs?: number;
  now?: () => number;
};

/** The run options that must be preserved when a parent starts its child. */
export type SupervisedRunOptions = {
  config?: string;
  instance?: string;
  repair?: boolean;
  bind?: "loopback" | "lan" | "tailnet";
  force?: boolean;
};

/**
 * Supervises the child that owns a Windows foreground `paperclipai run`.
 *
 * Windows has no supported service manager in the CLI today. Keeping the
 * server in a child lets the foreground command retain a single owner while
 * replacing a node process whose HTTP listener disappeared without exiting.
 */
export class WindowsRunSupervisor {
  private child: SupervisedChild | null = null;
  private failures = 0;
  private stopping = false;
  private restarting: Promise<void> | null = null;
  private restartFromPid: number | null = null;
  private readonly failureThreshold: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private childStartedAt = 0;
  private childHasBeenHealthy = false;
  private backupWarningLogged = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly options: WindowsRunSupervisorOptions) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) return;
    const child = this.options.startChild();
    if (!child.pid) throw new Error("Paperclip Windows supervisor failed to start a server child.");
    this.child = child;
    this.failures = 0;
    this.childStartedAt = this.now();
    this.childHasBeenHealthy = false;
    const childPid = child.pid;
    child.once("exit", () => {
      if (this.stopping || this.restarting) return;
      void this.restart(`server_child_exit`, childPid);
    });
    this.options.log(`[paperclipai run] Windows supervisor started server child pid=${childPid}.`);
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.tickOnce().finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  private async tickOnce(): Promise<void> {
    const child = this.child;
    if (!child?.pid || this.stopping || this.restarting) return;

    const health = await this.options.probeHealth(child.pid);
    if (this.child !== child || this.stopping || this.restarting) return;
    if (health.listenerOk) {
      this.childHasBeenHealthy = true;
      this.failures = 0;
      if (this.restartFromPid !== null) {
        if (health.databaseBackupOk) {
          if (this.restartFromPid === child.pid) {
            this.options.log(
              `[paperclipai run] Windows supervisor observed listener recovery without replacement: pid=${child.pid} health=ok databaseBackup=${health.databaseBackupStatus ?? "disabled"}.`,
            );
          } else {
            this.options.log(
              `[paperclipai run] Windows supervisor restored listener: oldPid=${this.restartFromPid} newPid=${child.pid} health=ok databaseBackup=${health.databaseBackupStatus ?? "disabled"}.`,
            );
          }
          this.restartFromPid = null;
          this.backupWarningLogged = false;
        } else if (!this.backupWarningLogged) {
          this.options.log(
            `[paperclipai run] Windows supervisor restored listener but database backup is not healthy: oldPid=${this.restartFromPid} newPid=${child.pid} databaseBackup=${health.databaseBackupStatus ?? "unknown"}.`,
          );
          this.backupWarningLogged = true;
        }
      }
      return;
    }

    if (!this.childHasBeenHealthy && this.now() - this.childStartedAt < this.startupGraceMs) return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      await this.restart("listener_loss", child.pid);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // A listener-loss restart can be paused while it waits for the old child
    // to exit. Do not release the owning parent until that transaction has
    // observed `stopping`; otherwise it can launch an orphan after shutdown.
    if (this.restarting) await this.restarting;
    const child = this.child;
    if (!child) return;
    // Keep the child reference until termination is proven. If stopping the
    // process tree fails, the foreground owner must retain both the child and
    // its instance lock so a later invocation cannot start a competing server.
    await this.options.stopChild(child);
    if (this.child === child) this.child = null;
  }

  sendToChild(message: { type: string }): boolean {
    if (!this.child?.send) return false;
    return this.child.send(message) !== false;
  }

  private async restart(reason: "listener_loss" | "server_child_exit", oldPid: number): Promise<void> {
    if (this.restarting || this.stopping) return this.restarting ?? undefined;
    this.restarting = (async () => {
      this.options.log(`[paperclipai run] Windows supervisor restarting instance=${this.options.instanceId} reason=${reason} oldPid=${oldPid}.`);
      const previousChild = this.child;
      this.child = null;
      this.failures = 0;
      this.restartFromPid = oldPid;
      this.backupWarningLogged = false;
      if (previousChild && reason === "listener_loss") {
        try {
          await this.options.stopChild(previousChild);
        } catch (error) {
          // Do not launch a second child while the previous process may still
          // own the port. Keep it as the sole owner and retry this restart on
          // the next failed probe instead of leaving the supervisor empty.
          this.child = previousChild;
          this.options.log(
            `[paperclipai run] Windows supervisor could not stop oldPid=${oldPid}; will retry listener recovery without starting another server: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
      }
      if (this.stopping) return;
      removeRuntimeInfoForPid(oldPid, this.options.instanceId);
      this.start();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function supervisorLockPath(instanceId: string): string {
  return path.join(resolvePaperclipInstanceRoot(instanceId), "windows-run-supervisor.lock");
}

/** Acquire a per-instance, crash-safe lock for the foreground Windows supervisor. */
export function acquireWindowsRunSupervisorLock(instanceId: string): () => void {
  const lockPath = supervisorLockPath(instanceId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;

  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === token) fs.rmSync(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: string;
    try {
      existing = fs.readFileSync(lockPath, "utf8").trim();
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw readError;
    }
    const ownerPid = Number.parseInt(existing.split(":", 1)[0] ?? "", 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      throw new Error(`Paperclip instance '${instanceId}' is already supervised by foreground process ${ownerPid}.`);
    }
    try {
      if (fs.readFileSync(lockPath, "utf8").trim() === existing) fs.rmSync(lockPath, { force: true });
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
    }
  }
}

function runtimeHealthUrl(runtime: PaperclipRuntimeInfo): string {
  return buildLocalHealthUrl(runtime.host, runtime.port);
}

export async function probeRuntimeHealth(instanceId: string, expectedPid: number): Promise<WindowsRunHealth> {
  const runtime = readRuntimeInfo(instanceId);
  if (!runtime || runtime.pid !== expectedPid) return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
  try {
    const response = await fetch(runtimeHealthUrl(runtime), { signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown; databaseBackup?: { enabled?: unknown; status?: unknown } };
    const databaseBackupStatus = typeof body.databaseBackup?.status === "string" ? body.databaseBackup.status : null;
    const databaseBackupOk = body.databaseBackup?.enabled !== true || databaseBackupStatus === "ok";
    return {
      listenerOk: response.ok && body.status === "ok",
      databaseBackupOk,
      databaseBackupStatus,
    };
  } catch {
    return { listenerOk: false, databaseBackupOk: false, databaseBackupStatus: null };
  }
}

async function waitForChildExit(child: SupervisedChild, timeoutMs = DEFAULT_CHILD_STOP_TIMEOUT_MS): Promise<boolean> {
  if (!child.pid) return true;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  if (child.signalCode !== null && child.signalCode !== undefined) return true;
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function listWindowsOwnedProcessPids(rootPid: number, instanceRoot: string): Promise<number[]> {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], { windowsHide: true, timeout: 30_000 });
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "[]") as
    | { ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string }
    | Array<{ ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const descendants: number[] = [];
  const parents = [rootPid];
  for (let index = 0; index < parents.length; index += 1) {
    const parentPid = parents[index];
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      if (Number(row.ParentProcessId) !== parentPid || !Number.isInteger(pid) || pid <= 0) continue;
      if (descendants.includes(pid)) continue;
      descendants.push(pid);
      parents.push(pid);
    }
  }
  const instanceNeedle = instanceRoot.toLowerCase();
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    if (
      String(row.Name ?? "").toLowerCase() === "postgres.exe"
      && String(row.CommandLine ?? "").toLowerCase().includes(instanceNeedle)
      && Number.isInteger(pid)
      && pid > 0
      && !descendants.includes(pid)
    ) {
      descendants.push(pid);
    }
  }
  return descendants;
}

async function waitForPidsExit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter(isProcessAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    survivors = survivors.filter(isProcessAlive);
  }
  return survivors;
}

export async function stopWindowsServerChild(child: SupervisedChild): Promise<void> {
  if (!child.pid) return;
  const gracefulExit = waitForChildExit(child);
  try {
    if (child.send) child.send({ type: "paperclip:graceful-shutdown" });
    else child.kill("SIGTERM");
  } catch {
    // The child may have exited between the health failure and the restart.
  }
  if (await gracefulExit) return;
  await execFileAsync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"]).catch(() => undefined);
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`Timed out stopping Paperclip server child ${child.pid}.`);
  }
}

/** Stop the server and prove that every process it owned has exited. */
export async function stopWindowsServerTree(child: SupervisedChild, instanceId: string): Promise<void> {
  const descendants = child.pid
    ? await listWindowsOwnedProcessPids(child.pid, resolvePaperclipInstanceRoot(instanceId))
    : [];
  await stopWindowsServerChild(child);

  let survivors = await waitForPidsExit(descendants, 10_000);
  for (const pid of survivors) {
    await execFileAsync("taskkill.exe", ["/pid", String(pid), "/t", "/f"]).catch(() => undefined);
  }
  survivors = await waitForPidsExit(survivors, 5_000);
  if (survivors.length > 0) {
    throw new Error(`Timed out stopping Paperclip server descendants: ${survivors.join(", ")}.`);
  }
}

/**
 * Constructs a `run` invocation instead of copying the parent's argv. This
 * matters when onboarding invokes runCommand() programmatically: its argv is
 * still `onboard`, which must never be restarted by the watchdog.
 */
export function supervisedRunChildArgs(options: SupervisedRunOptions): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Paperclip Windows supervisor could not locate the CLI entrypoint.");
  const args = [entrypoint, "run"];
  if (options.config) args.push("--config", options.config);
  if (options.instance) args.push("--instance", options.instance);
  if (options.bind) args.push("--bind", options.bind);
  if (options.repair === false) args.push("--no-repair");
  if (options.force) args.push("--force");
  args.push("--supervised-child");
  return args;
}

/** Coalesce repeated operator signals into one ownership-preserving shutdown. */
export function createIdempotentShutdown(action: () => Promise<void>): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (!shutdownPromise) {
      let attempt: Promise<void>;
      attempt = action().catch((error) => {
        // A failed stop retains ownership and may be retried by a later signal.
        // Clear only the cached transaction; concurrent signals still share the
        // same attempt and can never release the lock independently.
        if (shutdownPromise === attempt) shutdownPromise = null;
        throw error;
      });
      shutdownPromise = attempt;
    }
    return shutdownPromise;
  };
}

/**
 * Runs the Windows-only parent watchdog until the operator terminates it.
 * The child always receives an explicit `run` invocation plus a hidden
 * recursion guard, including when onboarding called runCommand directly.
 */
export async function runWithWindowsSupervisor(instanceId: string, options: SupervisedRunOptions): Promise<void> {
  const releaseLock = acquireWindowsRunSupervisorLock(instanceId);
  const acceptanceHarnessEnabled = process.env[WINDOWS_RUN_ACCEPTANCE_HARNESS_ENV] === "1";
  const supervisor = new WindowsRunSupervisor({
    instanceId,
    startChild: () => {
      // The native acceptance harness executes the TypeScript CLI through
      // Node's loader. Preserve those Node arguments for its real supervised
      // child without changing packaged production invocations.
      const nodeArgs = acceptanceHarnessEnabled
        ? [...process.execArgv, ...supervisedRunChildArgs(options)]
        : supervisedRunChildArgs(options);
      const child = spawn(process.execPath, nodeArgs, {
        cwd: process.cwd(),
        env: { ...process.env, PAPERCLIP_WINDOWS_RUN_SUPERVISED_CHILD: "1" },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      if (acceptanceHarnessEnabled && process.send) {
        child.on("message", (message) => process.send?.(message));
        child.on("exit", (code, signal) => {
          process.send?.({ type: "paperclip:acceptance:child-exit", code, signal });
        });
      }
      return child;
    },
    probeHealth: (pid) => probeRuntimeHealth(instanceId, pid),
    stopChild: (child) => stopWindowsServerTree(child, instanceId),
    log: (message) => console.error(message),
    // First-run migrations in a source checkout can exceed the production
    // startup grace. The acceptance harness must observe that same child
    // becoming healthy before it injects listener loss.
    startupGraceMs: acceptanceHarnessEnabled ? 240_000 : undefined,
  });

  let interval: NodeJS.Timeout | null = null;
  const shutdown = createIdempotentShutdown(async () => {
    if (interval) clearInterval(interval);
    await supervisor.stop();
    releaseLock();
  });
  const onSignal = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error(
          `[paperclipai run] Windows supervisor shutdown failed; retaining instance ownership: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  };
  const onParentMessage = (message: unknown) => {
    if (!acceptanceHarnessEnabled || !message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;
    if (type === WINDOWS_RUN_ACCEPTANCE_CLOSE_LISTENER) {
      if (!supervisor.sendToChild({ type: WINDOWS_RUN_ACCEPTANCE_CLOSE_LISTENER })) {
        process.send?.({ type: "paperclip:acceptance:error", message: "server child has no IPC channel" });
      }
      return;
    }
    if (type === WINDOWS_RUN_ACCEPTANCE_SHUTDOWN) onSignal();
  };

  // Keep both handlers installed until the one idempotent shutdown transaction
  // completes. A repeated signal must not restore Node's default termination
  // behavior while the supervised child may still own the instance port.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (acceptanceHarnessEnabled) process.on("message", onParentMessage);
  try {
    supervisor.start();
    interval = setInterval(() => { void supervisor.tick(); }, 2_000);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
