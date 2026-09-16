import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { setExpensiveWorkspaceGitExecutor } from "@paperclipai/adapter-utils/git-workspace-sync";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const WORKSPACE_GIT_SCAN_ERROR_CODES = {
  saturated: "workspace_git_scan_saturated",
  timeout: "workspace_git_scan_timeout",
  cancelled: "workspace_git_scan_cancelled",
  outputLimit: "workspace_git_scan_output_limit",
  failed: "workspace_git_scan_failed",
} as const;

export type WorkspaceGitScanErrorCode =
  (typeof WORKSPACE_GIT_SCAN_ERROR_CODES)[keyof typeof WORKSPACE_GIT_SCAN_ERROR_CODES];

export class WorkspaceGitScanError extends HttpError {
  readonly code: WorkspaceGitScanErrorCode;

  constructor(
    code: WorkspaceGitScanErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    const status = code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout
      ? 504
      : code === WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled
        ? 499
        : 503;
    super(status, message, {
      code,
      retryable: code !== WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled,
      ...details,
    });
    this.name = "WorkspaceGitScanError";
    this.code = code;
  }
}

export function isWorkspaceGitScanError(error: unknown): error is WorkspaceGitScanError {
  return error instanceof WorkspaceGitScanError;
}

export interface WorkspaceGitScanResult {
  stdout: string;
  stderr: string;
  canonicalWorkspacePath: string;
  workspaceHash: string;
  cacheHit: boolean;
  singleFlightJoined: boolean;
}

export interface WorkspaceGitScanInput {
  workspacePath: string;
  args: readonly string[];
  operation: string;
  /**
   * Stable, non-secret scheduling dimensions. Jobs sharing any recently-served
   * dimension are deprioritized, so changing issue ids cannot bypass fairness
   * for the same company, actor, or repository.
   */
  fairnessKeys?: readonly string[];
  signal?: AbortSignal;
  /** Successful-result cache duration. Use zero for correctness-sensitive guards. */
  cacheTtlMs?: number;
  /** Per-operation wall-clock deadline. Defaults to the process-wide setting. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface WorkspaceGitSchedulerSnapshot {
  activeCount: number;
  queuedCount: number;
  inFlightCount: number;
  cacheEntryCount: number;
  cacheBytes: number;
  totals: {
    started: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    saturated: number;
    cacheHits: number;
    singleFlightJoins: number;
  };
}

export interface WorkspaceGitRunnerInput {
  canonicalWorkspacePath: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  killGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface WorkspaceGitRunnerResult {
  stdout: string;
  stderr: string;
}

export type WorkspaceGitRunner = (
  input: WorkspaceGitRunnerInput,
) => Promise<WorkspaceGitRunnerResult>;

export interface WorkspaceGitOperationSchedulerOptions {
  concurrency?: number;
  queueCapacity?: number;
  timeoutMs?: number;
  killGraceMs?: number;
  defaultCacheTtlMs?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  warningIntervalMs?: number;
  gitBinary?: string;
  gitArgsPrefix?: readonly string[];
  runner?: WorkspaceGitRunner;
  now?: () => number;
}

interface Waiter {
  id: symbol;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (result: WorkspaceGitScanResult) => void;
  reject: (error: unknown) => void;
  joined: boolean;
}

interface PendingScan {
  key: string;
  operation: string;
  canonicalWorkspacePath: string;
  workspaceHash: string;
  args: readonly string[];
  fairnessKeys: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  cacheTtlMs: number;
  enqueuedAt: number;
  state: "queued" | "running";
  controller: AbortController;
  waiters: Map<symbol, Waiter>;
  joinCount: number;
}

interface CacheEntry {
  stdout: string;
  stderr: string;
  canonicalWorkspacePath: string;
  workspaceHash: string;
  expiresAt: number;
  bytes: number;
}

interface WarningBucket {
  lastLoggedAt: number;
  suppressed: number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_CAPACITY = 32;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_CACHE_ENTRIES = 64;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_WARNING_INTERVAL_MS = 10_000;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value!)));
}

function envInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return clampInteger(parsed, fallback, min, max);
}

export function workspaceGitSchedulerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<Pick<
  WorkspaceGitOperationSchedulerOptions,
  "concurrency" | "queueCapacity" | "timeoutMs" | "defaultCacheTtlMs"
>> {
  return {
    concurrency: envInteger(env, "PAPERCLIP_WORKSPACE_GIT_SCAN_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 16),
    queueCapacity: envInteger(env, "PAPERCLIP_WORKSPACE_GIT_SCAN_QUEUE_CAPACITY", DEFAULT_QUEUE_CAPACITY, 0, 1_024),
    timeoutMs: envInteger(env, "PAPERCLIP_WORKSPACE_GIT_SCAN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 100, 120_000),
    defaultCacheTtlMs: envInteger(env, "PAPERCLIP_WORKSPACE_GIT_SCAN_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS, 0, 60_000),
  };
}

function workspaceIdentity(canonicalWorkspacePath: string): string {
  return createHash("sha256").update(canonicalWorkspacePath).digest("hex").slice(0, 16);
}

function scanKey(input: {
  canonicalWorkspacePath: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}): string {
  // These variables can change status semantics. Hash values so neither keys nor
  // telemetry expose credentials or private config contents.
  const effectiveEnv = input.env ?? process.env;
  const semanticEnv = [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OPTIONAL_LOCKS",
    "GIT_WORK_TREE",
  ].map((key) => [key, effectiveEnv[key] ?? null]);
  return createHash("sha256")
    .update(JSON.stringify({
      workspacePath: input.canonicalWorkspacePath,
      args: input.args,
      semanticEnv,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      maxStderrBytes: input.maxStderrBytes,
    }))
    .digest("hex");
}

function abortError(workspaceHash: string): WorkspaceGitScanError {
  return new WorkspaceGitScanError(
    WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled,
    "Workspace Git scan was cancelled",
    { workspaceHash },
  );
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group already disappeared.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close/error handler owns settlement; an already-dead child is benign.
  }
}

function createSpawnRunner(input: {
  gitBinary: string;
  gitArgsPrefix: readonly string[];
}): WorkspaceGitRunner {
  return (runInput) => new Promise<WorkspaceGitRunnerResult>((resolve, reject) => {
    if (runInput.signal.aborted) {
      reject(abortError(workspaceIdentity(runInput.canonicalWorkspacePath)));
      return;
    }

    const child = spawn(
      input.gitBinary,
      [...input.gitArgsPrefix, "-C", runInput.canonicalWorkspacePath, ...runInput.args],
      {
        cwd: runInput.canonicalWorkspacePath,
        env: runInput.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: "timeout" | "cancelled" | "output_limit" | null = null;
    let spawnError: Error | null = null;
    let settled = false;

    const terminate = (reason: NonNullable<typeof termination>) => {
      if (termination) return;
      termination = reason;
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => signalChild(child, "SIGKILL"), runInput.killGraceMs);
      killTimer.unref?.();
    };

    const append = (
      chunk: Buffer | string,
      chunks: Buffer[],
      currentBytes: number,
      maxBytes: number,
    ): number => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - currentBytes);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      const nextBytes = currentBytes + buffer.length;
      if (nextBytes > maxBytes) terminate("output_limit");
      return nextBytes;
    };

    const onAbort = () => terminate("cancelled");
    runInput.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdoutBytes = append(chunk, stdoutChunks, stdoutBytes, runInput.maxStdoutBytes);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes = append(chunk, stderrChunks, stderrBytes, runInput.maxStderrBytes);
    });
    child.once("error", (error) => {
      spawnError = error;
    });

    const timeoutTimer = setTimeout(() => terminate("timeout"), runInput.timeoutMs);
    timeoutTimer.unref?.();
    let killTimer: NodeJS.Timeout | null = null;

    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      runInput.signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const workspaceHash = workspaceIdentity(runInput.canonicalWorkspacePath);

      if (termination === "timeout") {
        reject(new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.timeout,
          `Workspace Git scan timed out after ${runInput.timeoutMs}ms`,
          { workspaceHash, timeoutMs: runInput.timeoutMs },
        ));
        return;
      }
      if (termination === "cancelled") {
        reject(abortError(workspaceHash));
        return;
      }
      if (termination === "output_limit") {
        reject(new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.outputLimit,
          "Workspace Git scan exceeded its output limit",
          {
            workspaceHash,
            stdoutBytes,
            stderrBytes,
            maxStdoutBytes: runInput.maxStdoutBytes,
            maxStderrBytes: runInput.maxStderrBytes,
          },
        ));
        return;
      }
      if (spawnError) {
        reject(new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.failed,
          "Workspace Git scan could not start",
          { workspaceHash, cause: spawnError.message },
        ));
        return;
      }
      if (code !== 0) {
        reject(new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.failed,
          "Workspace Git scan failed",
          {
            workspaceHash,
            exitCode: code,
            signal: childSignal,
            // Keep the diagnostic bounded; callers never receive raw paths in telemetry.
            stderr: stderr.trim().slice(0, 1_000),
          },
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class WorkspaceGitOperationScheduler {
  private readonly concurrency: number;
  private readonly queueCapacity: number;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly defaultCacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly warningIntervalMs: number;
  private readonly runner: WorkspaceGitRunner;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, PendingScan>();
  private readonly queue: PendingScan[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastServedByFairnessKey = new Map<string, number>();
  private readonly warningBuckets = new Map<string, WarningBucket>();
  private cacheBytes = 0;
  private activeCount = 0;
  private serviceSequence = 0;
  private readonly totals = {
    started: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    saturated: 0,
    cacheHits: 0,
    singleFlightJoins: 0,
  };

  constructor(options: WorkspaceGitOperationSchedulerOptions = {}) {
    this.concurrency = clampInteger(options.concurrency, DEFAULT_CONCURRENCY, 1, 16);
    this.queueCapacity = clampInteger(options.queueCapacity, DEFAULT_QUEUE_CAPACITY, 0, 1_024);
    this.timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
    this.killGraceMs = clampInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS, 1, 10_000);
    this.defaultCacheTtlMs = clampInteger(options.defaultCacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 60_000);
    this.maxCacheEntries = clampInteger(options.maxCacheEntries, DEFAULT_CACHE_ENTRIES, 0, 10_000);
    this.maxCacheBytes = clampInteger(options.maxCacheBytes, DEFAULT_CACHE_BYTES, 0, 1024 * 1024 * 1024);
    this.maxStdoutBytes = clampInteger(options.maxStdoutBytes, DEFAULT_OUTPUT_BYTES, 1, 128 * 1024 * 1024);
    this.maxStderrBytes = clampInteger(options.maxStderrBytes, DEFAULT_OUTPUT_BYTES, 1, 128 * 1024 * 1024);
    this.warningIntervalMs = clampInteger(options.warningIntervalMs, DEFAULT_WARNING_INTERVAL_MS, 1, 60 * 60_000);
    this.now = options.now ?? Date.now;
    this.runner = options.runner ?? createSpawnRunner({
      gitBinary: options.gitBinary ?? "git",
      gitArgsPrefix: options.gitArgsPrefix ?? [],
    });
  }

  snapshot(): WorkspaceGitSchedulerSnapshot {
    this.pruneExpiredCache();
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      inFlightCount: this.inFlight.size,
      cacheEntryCount: this.cache.size,
      cacheBytes: this.cacheBytes,
      totals: { ...this.totals },
    };
  }

  async run(input: WorkspaceGitScanInput): Promise<WorkspaceGitScanResult> {
    if (input.signal?.aborted) throw abortError("unresolved");
    let canonicalWorkspacePath: string;
    try {
      canonicalWorkspacePath = await fs.realpath(input.workspacePath);
    } catch (error) {
      throw new WorkspaceGitScanError(
        WORKSPACE_GIT_SCAN_ERROR_CODES.failed,
        "Workspace Git scan path is unavailable",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (input.signal?.aborted) throw abortError(workspaceIdentity(canonicalWorkspacePath));

    const workspaceHash = workspaceIdentity(canonicalWorkspacePath);
    const timeoutMs = clampInteger(input.timeoutMs, this.timeoutMs, 1, 120_000);
    const maxStdoutBytes = clampInteger(input.maxStdoutBytes, this.maxStdoutBytes, 1, 128 * 1024 * 1024);
    const maxStderrBytes = clampInteger(input.maxStderrBytes, this.maxStderrBytes, 1, 128 * 1024 * 1024);
    const key = scanKey({
      canonicalWorkspacePath,
      args: input.args,
      env: input.env,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    });
    const cacheTtlMs = clampInteger(input.cacheTtlMs, this.defaultCacheTtlMs, 0, 60_000);
    // A correctness-sensitive caller that explicitly disables caching must not
    // consume a result populated earlier by the file browser.
    const cached = cacheTtlMs > 0 ? this.readCache(key) : null;
    if (cached) {
      this.totals.cacheHits += 1;
      logger.debug({
        event: "workspace_git_scan",
        operation: input.operation,
        workspaceHash,
        cacheHit: true,
        singleFlightJoined: false,
        activeCount: this.activeCount,
        queuedCount: this.queue.length,
        cacheHitCount: this.totals.cacheHits,
      }, "workspace Git scan cache hit");
      return {
        stdout: cached.stdout,
        stderr: cached.stderr,
        canonicalWorkspacePath,
        workspaceHash,
        cacheHit: true,
        singleFlightJoined: false,
      };
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      existing.joinCount += 1;
      this.totals.singleFlightJoins += 1;
      return this.addWaiter(existing, input.signal, true);
    }

    if (this.activeCount >= this.concurrency && this.queue.length >= this.queueCapacity) {
      this.totals.saturated += 1;
      this.warnRateLimited("saturated", {
        event: "workspace_git_scan",
        operation: input.operation,
        workspaceHash,
        outcome: "saturated",
        activeCount: this.activeCount,
        queuedCount: this.queue.length,
        saturationCount: this.totals.saturated,
      }, "workspace Git scan queue saturated");
      throw new WorkspaceGitScanError(
        WORKSPACE_GIT_SCAN_ERROR_CODES.saturated,
        "Changed files are temporarily unavailable because the Git scan queue is full",
        {
          workspaceHash,
          activeCount: this.activeCount,
          queuedCount: this.queue.length,
          retryAfterSeconds: 1,
        },
      );
    }

    const fairnessKeys = Array.from(new Set([
      `repository:${workspaceHash}`,
      ...(input.fairnessKeys ?? []).filter(Boolean),
    ])).sort();
    const scan: PendingScan = {
      key,
      operation: input.operation,
      canonicalWorkspacePath,
      workspaceHash,
      args: [...input.args],
      fairnessKeys,
      env: input.env,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      cacheTtlMs,
      enqueuedAt: this.now(),
      state: "queued",
      controller: new AbortController(),
      waiters: new Map(),
      joinCount: 0,
    };
    this.inFlight.set(key, scan);
    this.queue.push(scan);
    const promise = this.addWaiter(scan, input.signal, false);
    this.drain();
    return promise;
  }

  private addWaiter(
    scan: PendingScan,
    signal: AbortSignal | undefined,
    joined: boolean,
  ): Promise<WorkspaceGitScanResult> {
    if (signal?.aborted) return Promise.reject(abortError(scan.workspaceHash));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        id: Symbol("workspace-git-waiter"),
        signal,
        resolve,
        reject,
        joined,
      };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(scan, waiter);
          reject(abortError(scan.workspaceHash));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      scan.waiters.set(waiter.id, waiter);
    });
  }

  private removeWaiter(scan: PendingScan, waiter: Waiter): void {
    if (!scan.waiters.delete(waiter.id)) return;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (scan.waiters.size > 0) return;

    if (scan.state === "queued") {
      const index = this.queue.indexOf(scan);
      if (index >= 0) this.queue.splice(index, 1);
      this.inFlight.delete(scan.key);
      this.totals.cancelled += 1;
      logger.debug({
        event: "workspace_git_scan",
        operation: scan.operation,
        workspaceHash: scan.workspaceHash,
        outcome: "cancelled_before_start",
        activeCount: this.activeCount,
        queuedCount: this.queue.length,
      }, "queued workspace Git scan cancelled");
      this.drain();
      this.pruneFairnessState();
      return;
    }
    // Detach the doomed single-flight entry immediately. A new caller arriving
    // while the child is terminating may enqueue a fresh scan instead of
    // joining an already-aborted promise; the active slot remains occupied
    // until the child actually closes.
    if (this.inFlight.get(scan.key) === scan) this.inFlight.delete(scan.key);
    scan.controller.abort();
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const index = this.nextFairQueueIndex();
      const scan = this.queue.splice(index, 1)[0]!;
      if (scan.waiters.size === 0) {
        this.inFlight.delete(scan.key);
        continue;
      }
      this.start(scan);
    }
  }

  private nextFairQueueIndex(): number {
    let selectedIndex = 0;
    let selectedScore = Number.POSITIVE_INFINITY;
    let selectedEnqueuedAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.queue.length; index += 1) {
      const scan = this.queue[index]!;
      // Average recency across every dimension so a common repository/company
      // key cannot mask a fresh actor or issue. Repeatedly changing only one
      // dimension therefore cannot jump ahead of a wholly unserved group.
      const score = scan.fairnessKeys.reduce(
        (total, key) => total + (this.lastServedByFairnessKey.get(key) ?? 0),
        0,
      ) / scan.fairnessKeys.length;
      if (score < selectedScore || (score === selectedScore && scan.enqueuedAt < selectedEnqueuedAt)) {
        selectedIndex = index;
        selectedScore = score;
        selectedEnqueuedAt = scan.enqueuedAt;
      }
    }
    return selectedIndex;
  }

  private start(scan: PendingScan): void {
    scan.state = "running";
    this.activeCount += 1;
    this.totals.started += 1;
    this.serviceSequence += 1;
    for (const key of scan.fairnessKeys) this.lastServedByFairnessKey.set(key, this.serviceSequence);
    const startedAt = this.now();
    const queueWaitMs = Math.max(0, startedAt - scan.enqueuedAt);

    void this.runner({
      canonicalWorkspacePath: scan.canonicalWorkspacePath,
      args: scan.args,
      env: scan.env,
      signal: scan.controller.signal,
      timeoutMs: scan.timeoutMs,
      killGraceMs: this.killGraceMs,
      maxStdoutBytes: scan.maxStdoutBytes,
      maxStderrBytes: scan.maxStderrBytes,
    }).then(
      (result) => this.finishSuccess(scan, result, queueWaitMs, startedAt),
      (error) => this.finishFailure(scan, error, queueWaitMs, startedAt),
    );
  }

  private finishSuccess(
    scan: PendingScan,
    result: WorkspaceGitRunnerResult,
    queueWaitMs: number,
    startedAt: number,
  ): void {
    this.totals.succeeded += 1;
    if (scan.cacheTtlMs > 0) this.writeCache(scan.key, scan, result);
    const responseBase = {
      stdout: result.stdout,
      stderr: result.stderr,
      canonicalWorkspacePath: scan.canonicalWorkspacePath,
      workspaceHash: scan.workspaceHash,
      cacheHit: false,
    };
    for (const waiter of scan.waiters.values()) {
      this.detachWaiter(waiter);
      waiter.resolve({ ...responseBase, singleFlightJoined: waiter.joined });
    }
    logger.info({
      event: "workspace_git_scan",
      operation: scan.operation,
      workspaceHash: scan.workspaceHash,
      outcome: "success",
      queueWaitMs,
      executionMs: Math.max(0, this.now() - startedAt),
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      cacheHit: false,
      singleFlightJoinCount: scan.joinCount,
      exitOutcome: "zero",
    }, "workspace Git scan completed");
    this.release(scan);
  }

  private finishFailure(
    scan: PendingScan,
    error: unknown,
    queueWaitMs: number,
    startedAt: number,
  ): void {
    const normalized = isWorkspaceGitScanError(error)
      ? error
      : new WorkspaceGitScanError(
          WORKSPACE_GIT_SCAN_ERROR_CODES.failed,
          "Workspace Git scan failed",
          { cause: error instanceof Error ? error.message : String(error), workspaceHash: scan.workspaceHash },
        );
    if (normalized.code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout) {
      this.totals.timedOut += 1;
      this.warnRateLimited("timeout", {
        event: "workspace_git_scan",
        operation: scan.operation,
        workspaceHash: scan.workspaceHash,
        outcome: "timeout",
        queueWaitMs,
        executionMs: Math.max(0, this.now() - startedAt),
        activeCount: this.activeCount,
        queuedCount: this.queue.length,
        timeoutCount: this.totals.timedOut,
      }, "workspace Git scan timed out");
    } else if (normalized.code === WORKSPACE_GIT_SCAN_ERROR_CODES.cancelled) {
      this.totals.cancelled += 1;
    } else {
      this.totals.failed += 1;
    }
    for (const waiter of scan.waiters.values()) {
      this.detachWaiter(waiter);
      waiter.reject(normalized);
    }
    logger.info({
      event: "workspace_git_scan",
      operation: scan.operation,
      workspaceHash: scan.workspaceHash,
      outcome: normalized.code,
      queueWaitMs,
      executionMs: Math.max(0, this.now() - startedAt),
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      cacheHit: false,
      singleFlightJoinCount: scan.joinCount,
      exitOutcome: normalized.code,
    }, "workspace Git scan finished without a result");
    this.release(scan);
  }

  private detachWaiter(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private release(scan: PendingScan): void {
    scan.waiters.clear();
    if (this.inFlight.get(scan.key) === scan) this.inFlight.delete(scan.key);
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.drain();
    this.pruneFairnessState();
  }

  private pruneFairnessState(): void {
    if (this.lastServedByFairnessKey.size === 0) return;
    const liveKeys = new Set<string>();
    for (const scan of this.inFlight.values()) {
      for (const key of scan.fairnessKeys) liveKeys.add(key);
    }
    for (const key of this.lastServedByFairnessKey.keys()) {
      if (!liveKeys.has(key)) this.lastServedByFairnessKey.delete(key);
    }
  }

  private readCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.deleteCacheEntry(key, entry);
      return null;
    }
    // LRU touch.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private writeCache(key: string, scan: PendingScan, result: WorkspaceGitRunnerResult): void {
    if (this.maxCacheEntries === 0 || this.maxCacheBytes === 0) return;
    const bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (bytes > this.maxCacheBytes) return;
    const existing = this.cache.get(key);
    if (existing) this.deleteCacheEntry(key, existing);
    const entry: CacheEntry = {
      ...result,
      canonicalWorkspacePath: scan.canonicalWorkspacePath,
      workspaceHash: scan.workspaceHash,
      expiresAt: this.now() + scan.cacheTtlMs,
      bytes,
    };
    this.cache.set(key, entry);
    this.cacheBytes += bytes;
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.deleteCacheEntry(oldest[0], oldest[1]);
    }
  }

  private deleteCacheEntry(key: string, entry: CacheEntry): void {
    if (!this.cache.delete(key)) return;
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes);
  }

  private pruneExpiredCache(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.deleteCacheEntry(key, entry);
    }
  }

  private warnRateLimited(
    key: string,
    fields: Record<string, unknown>,
    message: string,
  ): void {
    const now = this.now();
    const bucket = this.warningBuckets.get(key);
    if (bucket && now - bucket.lastLoggedAt < this.warningIntervalMs) {
      bucket.suppressed += 1;
      return;
    }
    const suppressedSinceLastWarning = bucket?.suppressed ?? 0;
    this.warningBuckets.set(key, { lastLoggedAt: now, suppressed: 0 });
    logger.warn({ ...fields, suppressedSinceLastWarning }, message);
  }
}

export function createWorkspaceGitOperationScheduler(
  options: WorkspaceGitOperationSchedulerOptions = {},
): WorkspaceGitOperationScheduler {
  return new WorkspaceGitOperationScheduler(options);
}

const envOptions = workspaceGitSchedulerOptionsFromEnv();
export const workspaceGitOperationScheduler = createWorkspaceGitOperationScheduler(envOptions);

setExpensiveWorkspaceGitExecutor(async (input) => {
  const result = await workspaceGitOperationScheduler.run({
    workspacePath: input.localDir,
    args: input.args,
    operation: input.operation,
    cacheTtlMs: 0,
    timeoutMs: input.timeout,
    maxStdoutBytes: input.maxBuffer,
    maxStderrBytes: input.maxBuffer,
    // Absent for the anchor workspace's own reads (they inherit the process
    // environment, a directory this process already controls). A
    // referenced-project scan sets this to its hardened environment, so the
    // hardening survives the hop through this shared scheduler.
    env: input.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
});

export function getWorkspaceGitOperationSchedulerSnapshot(): WorkspaceGitSchedulerSnapshot {
  return workspaceGitOperationScheduler.snapshot();
}
