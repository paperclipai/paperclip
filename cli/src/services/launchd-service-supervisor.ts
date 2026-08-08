import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const LAUNCHD_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LAUNCHD_LOG_GENERATIONS = 3;
export const LAUNCHD_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;
export const LAUNCHD_EARLY_EXIT_WINDOW_MS = 60_000;
export const LAUNCHD_MAX_EARLY_FAILURES = 5;
export const LAUNCHD_OUTPUT_DRAIN_TIMEOUT_MS = 1_000;
export const LAUNCHD_CHILD_STOP_TIMEOUT_MS = 5_000;

type SupervisorStatus = {
  state: "starting" | "running" | "exited" | "blocked";
  reason: string;
  message: string;
  updatedAt: string;
  childPid?: number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  freeDiskBytes?: number;
  earlyFailureCount?: number;
};

type LaunchdServiceSupervisorOptions = {
  instanceId: string;
  homeDir: string;
  shimPath: string;
  now?: () => number;
  spawnChild?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess & {
    stdout: Readable;
    stderr: Readable;
  };
  freeDiskBytes?: (instanceRoot: string) => Promise<number>;
  outputDrainTimeoutMs?: number;
  childStopTimeoutMs?: number;
};

type SupervisorFailureReason = "spawn_error" | "output_error" | "supervisor_error";

class LaunchdSupervisorError extends Error {
  constructor(readonly reason: SupervisorFailureReason, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "LaunchdSupervisorError";
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function assertSafeLogPath(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new Error(`Refusing to use unsafe service log path ${filePath}.`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export async function rotateLaunchdServiceLog(filePath: string, generations = LAUNCHD_LOG_GENERATIONS): Promise<void> {
  if (!Number.isInteger(generations) || generations < 1) {
    throw new Error("Log generations must be a positive integer.");
  }

  await assertSafeLogPath(filePath);
  for (let generation = 1; generation <= generations; generation += 1) {
    await assertSafeLogPath(`${filePath}.${generation}`);
  }

  await fs.rm(`${filePath}.${generations}`, { force: true });
  for (let generation = generations - 1; generation >= 1; generation -= 1) {
    try {
      await fs.rename(`${filePath}.${generation}`, `${filePath}.${generation + 1}`);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  try {
    await fs.rename(filePath, `${filePath}.1`);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export class RotatingLogWriter extends Writable {
  private handle: FileHandle | null = null;
  private currentBytes = 0;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = LAUNCHD_LOG_MAX_BYTES,
    private readonly generations = LAUNCHD_LOG_GENERATIONS,
  ) {
    super();
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Log size limit must be a positive integer.");
    }
  }

  override _construct(callback: (error?: Error | null) => void): void {
    this.openCurrentLog().then(() => callback(), callback);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.writeBuffer(buffer).then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.handle;
    this.handle = null;
    if (!handle) {
      callback(error);
      return;
    }
    handle.close().then(() => callback(error), callback);
  }

  private async openCurrentLog(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await assertSafeLogPath(this.filePath);
    this.handle = await fs.open(
      this.filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = await this.handle.stat();
    this.currentBytes = stat.size;
    if (this.currentBytes >= this.maxBytes) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    await rotateLaunchdServiceLog(this.filePath, this.generations);
    this.handle = await fs.open(
      this.filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    this.currentBytes = 0;
  }

  private async writeBuffer(buffer: Buffer): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      if (!this.handle) throw new Error(`Service log ${this.filePath} is not open.`);
      if (this.currentBytes >= this.maxBytes) await this.rotate();

      const writableBytes = Math.min(buffer.length - offset, this.maxBytes - this.currentBytes);
      const { bytesWritten } = await this.handle.write(buffer, offset, writableBytes);
      if (bytesWritten < 1) throw new Error(`Unable to write service log ${this.filePath}.`);
      offset += bytesWritten;
      this.currentBytes += bytesWritten;
    }
  }
}

export function recentLaunchdEarlyFailures(
  failureTimestamps: number[],
  now: number,
  windowMs = LAUNCHD_EARLY_EXIT_WINDOW_MS,
): number[] {
  const cutoff = now - windowMs;
  return failureTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now);
}

export function launchdStartupBlockReason(input: {
  freeDiskBytes: number;
  failureTimestamps: number[];
  now: number;
}): { reason: "low_disk" | "crash_loop"; failures: number[] } | null {
  const failures = recentLaunchdEarlyFailures(input.failureTimestamps, input.now);
  if (input.freeDiskBytes < LAUNCHD_MIN_FREE_DISK_BYTES) {
    return { reason: "low_disk", failures };
  }
  if (failures.length >= LAUNCHD_MAX_EARLY_FAILURES) {
    return { reason: "crash_loop", failures };
  }
  return null;
}

async function readFailureTimestamps(filePath: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { timestamps?: unknown };
    return Array.isArray(parsed.timestamps)
      ? parsed.timestamps.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function defaultFreeDiskBytes(instanceRoot: string): Promise<number> {
  const stats = await fs.statfs(instanceRoot, { bigint: true });
  const freeBytes = stats.bavail * stats.bsize;
  return freeBytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(freeBytes);
}

async function recordLaunchdSupervisorFailure(input: {
  instanceId: string;
  failurePath: string;
  statusPath: string;
  failures: number[];
  finishedAt: number;
  reason: SupervisorFailureReason;
  error: unknown;
  childPid?: number | null;
}): Promise<number> {
  const nextFailures = [
    ...recentLaunchdEarlyFailures(input.failures, input.finishedAt),
    input.finishedAt,
  ];
  const crashLoopCapped = nextFailures.length >= LAUNCHD_MAX_EARLY_FAILURES;
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  const failureKind = input.reason === "spawn_error"
    ? "could not start the child service"
    : input.reason === "output_error"
      ? "could not stream the child service logs"
      : "encountered an internal supervisor error";
  const message = crashLoopCapped
    ? `Paperclip startup paused after ${nextFailures.length} early failures within ${LAUNCHD_EARLY_EXIT_WINDOW_MS / 1000} seconds. Last failure: ${failureKind}: ${detail}. Run 'paperclipai service start --instance ${input.instanceId}' after correcting the cause.`
    : `Paperclip launchd supervisor ${failureKind}: ${detail}.`;

  await writeJsonAtomically(input.failurePath, { timestamps: nextFailures });
  await writeJsonAtomically(input.statusPath, {
    state: crashLoopCapped ? "blocked" : "exited",
    reason: crashLoopCapped ? "crash_loop" : input.reason,
    message,
    updatedAt: new Date(input.finishedAt).toISOString(),
    childPid: input.childPid ?? null,
    earlyFailureCount: nextFailures.length,
  } satisfies SupervisorStatus);

  return crashLoopCapped ? 0 : 1;
}

function waitForTimeout(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}

async function stopChild(
  child: ChildProcess,
  childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const stopped = await Promise.race([
    childExit.then(() => true, () => true),
    waitForTimeout(timeoutMs).then(() => false),
  ]);
  if (stopped || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    childExit.then(() => undefined, () => undefined),
    waitForTimeout(timeoutMs),
  ]);
}

export async function clearLaunchdServiceSafetyState(instanceRoot: string): Promise<void> {
  await Promise.all([
    fs.rm(path.join(instanceRoot, "service-early-failures.json"), { force: true }),
    fs.rm(path.join(instanceRoot, "service-supervisor-status.json"), { force: true }),
  ]);
}

export async function runLaunchdServiceSupervisor(options: LaunchdServiceSupervisorOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const instanceRoot = path.join(options.homeDir, "instances", options.instanceId);
  const logDirectory = path.join(instanceRoot, "logs");
  const stdoutPath = path.join(logDirectory, "service.log");
  const stderrPath = path.join(logDirectory, "service.err.log");
  const failurePath = path.join(instanceRoot, "service-early-failures.json");
  const statusPath = path.join(instanceRoot, "service-supervisor-status.json");
  const freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes;
  const outputDrainTimeoutMs = options.outputDrainTimeoutMs ?? LAUNCHD_OUTPUT_DRAIN_TIMEOUT_MS;
  const childStopTimeoutMs = options.childStopTimeoutMs ?? LAUNCHD_CHILD_STOP_TIMEOUT_MS;
  const spawnChild = options.spawnChild ?? ((command, args, env) => spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }));

  const startedAt = now();
  let failures: number[] = [];
  let child: (ChildProcess & { stdout: Readable; stderr: Readable }) | null = null;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let stopping = false;
  let pendingSignal: NodeJS.Signals | null = null;
  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  try {
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    failures = recentLaunchdEarlyFailures(await readFailureTimestamps(failurePath), startedAt);
    const availableBytes = await freeDiskBytes(instanceRoot);
    const blocked = launchdStartupBlockReason({ freeDiskBytes: availableBytes, failureTimestamps: failures, now: startedAt });

    if (blocked) {
      const lowDisk = blocked.reason === "low_disk";
      const message = lowDisk
        ? `Paperclip startup refused: ${availableBytes} bytes free; at least ${LAUNCHD_MIN_FREE_DISK_BYTES} bytes are required.`
        : `Paperclip startup paused after ${blocked.failures.length} early failures within ${LAUNCHD_EARLY_EXIT_WINDOW_MS / 1000} seconds. Run 'paperclipai service start --instance ${options.instanceId}' after correcting the cause.`;
      await writeJsonAtomically(statusPath, {
        state: "blocked",
        reason: blocked.reason,
        message,
        updatedAt: new Date(startedAt).toISOString(),
        freeDiskBytes: availableBytes,
        earlyFailureCount: blocked.failures.length,
      } satisfies SupervisorStatus);
      return 0;
    }

    await writeJsonAtomically(failurePath, { timestamps: failures });
    await writeJsonAtomically(statusPath, {
      state: "starting",
      reason: "preflight_passed",
      message: "Paperclip launchd supervisor preflight passed; starting the service.",
      updatedAt: new Date(startedAt).toISOString(),
      freeDiskBytes: availableBytes,
      earlyFailureCount: failures.length,
    } satisfies SupervisorStatus);

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      pendingSignal = signal;
      if (child && childExit) {
        void stopChild(child, childExit, signal, childStopTimeoutMs);
      }
    };
    onSigterm = () => forwardSignal("SIGTERM");
    onSigint = () => forwardSignal("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);

    try {
      child = spawnChild(options.shimPath, ["run", "--instance", options.instanceId], {
        ...process.env,
        PAPERCLIP_SERVICE_MANAGED: "1",
        PAPERCLIP_INSTANCE_ID: options.instanceId,
        PAPERCLIP_HOME: options.homeDir,
      });
    } catch (error) {
      throw new LaunchdSupervisorError("spawn_error", error);
    }

    childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child?.once("error", reject);
      child?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const childOutcome = childExit.then(
      (value) => ({ kind: "exit" as const, value }),
      (error: unknown) => ({ kind: "spawn_error" as const, error }),
    );
    const outputOutcome = Promise.all([
      pipeline(child.stdout, new RotatingLogWriter(stdoutPath)),
      pipeline(child.stderr, new RotatingLogWriter(stderrPath)),
    ]).then(
      () => ({ kind: "output_complete" as const }),
      (error: unknown) => ({ kind: "output_error" as const, error }),
    );

    if (pendingSignal) {
      void stopChild(child, childExit, pendingSignal, childStopTimeoutMs);
    }

    await writeJsonAtomically(statusPath, {
      state: "running",
      reason: "child_started",
      message: "Paperclip service is running under the launchd supervisor.",
      updatedAt: new Date(now()).toISOString(),
      childPid: child.pid ?? null,
      freeDiskBytes: availableBytes,
      earlyFailureCount: failures.length,
    } satisfies SupervisorStatus);

    const firstOutcome = await Promise.race([childOutcome, outputOutcome]);
    let exitCode: number | null;
    let exitSignal: NodeJS.Signals | null;
    if (firstOutcome.kind === "output_error") {
      await stopChild(child, childExit, "SIGTERM", childStopTimeoutMs);
      throw new LaunchdSupervisorError("output_error", firstOutcome.error);
    }
    if (firstOutcome.kind === "spawn_error") {
      throw new LaunchdSupervisorError("spawn_error", firstOutcome.error);
    }
    if (firstOutcome.kind === "output_complete") {
      const outcome = await childOutcome;
      if (outcome.kind === "spawn_error") throw new LaunchdSupervisorError("spawn_error", outcome.error);
      ({ code: exitCode, signal: exitSignal } = outcome.value);
    } else {
      ({ code: exitCode, signal: exitSignal } = firstOutcome.value);
      const outcome = await Promise.race([
        outputOutcome,
        waitForTimeout(outputDrainTimeoutMs).then(() => ({ kind: "output_timeout" as const })),
      ]);
      if (outcome.kind === "output_error") throw new LaunchdSupervisorError("output_error", outcome.error);
      if (outcome.kind === "output_timeout") {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }

    const finishedAt = now();
    const exitedEarly = !stopping && finishedAt - startedAt < LAUNCHD_EARLY_EXIT_WINDOW_MS;
    const nextFailures = exitedEarly
      ? [...recentLaunchdEarlyFailures(failures, finishedAt), finishedAt]
      : [];
    await writeJsonAtomically(failurePath, { timestamps: nextFailures });

    const crashLoopCapped = nextFailures.length >= LAUNCHD_MAX_EARLY_FAILURES;
    const message = crashLoopCapped
      ? `Paperclip startup paused after ${nextFailures.length} early failures within ${LAUNCHD_EARLY_EXIT_WINDOW_MS / 1000} seconds. Run 'paperclipai service start --instance ${options.instanceId}' after correcting the cause.`
      : `Paperclip service exited${exitCode === null ? "" : ` with code ${exitCode}`}${exitSignal ? ` from ${exitSignal}` : ""}.`;
    await writeJsonAtomically(statusPath, {
      state: crashLoopCapped ? "blocked" : "exited",
      reason: crashLoopCapped ? "crash_loop" : stopping ? "operator_stop" : exitedEarly ? "early_exit" : "child_exit",
      message,
      updatedAt: new Date(finishedAt).toISOString(),
      childPid: child.pid ?? null,
      exitCode,
      signal: exitSignal,
      earlyFailureCount: nextFailures.length,
    } satisfies SupervisorStatus);

    if (crashLoopCapped) return 0;
    if (stopping) return 1;
    return exitCode && exitCode > 0 ? exitCode : 1;
  } catch (error) {
    if (stopping) return 1;
    if (child && childExit && child.exitCode === null && child.signalCode === null) {
      await stopChild(child, childExit, "SIGTERM", childStopTimeoutMs);
    }
    const supervisorError = error instanceof LaunchdSupervisorError
      ? error
      : new LaunchdSupervisorError("supervisor_error", error);
    try {
      return await recordLaunchdSupervisorFailure({
        instanceId: options.instanceId,
        failurePath,
        statusPath,
        failures,
        finishedAt: now(),
        reason: supervisorError.reason,
        error: supervisorError,
        childPid: child?.pid ?? null,
      });
    } catch {
      // If safety-state persistence itself is unavailable, fail closed so launchd
      // does not retry forever and amplify the underlying disk/filesystem fault.
      return 0;
    }
  } finally {
    if (onSigterm) process.off("SIGTERM", onSigterm);
    if (onSigint) process.off("SIGINT", onSigint);
  }
}
