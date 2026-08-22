import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CLOSE_READINESS_ERROR_CODES = {
  saturated: "close_readiness_saturated",
} as const;

export interface CloseReadinessDemandSnapshot {
  waiterCount: number;
  workspaceKeyCount: number;
  tenantKeyCount: number;
  maxWaiters: number;
  maxWaitersPerWorkspace: number;
  maxWaitersPerTenant: number;
  peakWaiters: number;
  totals: {
    admitted: number;
    rejected: number;
    aborted: number;
    timedOut: number;
    degraded: number;
  };
}

export interface CloseReadinessDemandLimiterOptions {
  maxWaiters?: number;
  maxWaitersPerWorkspace?: number;
  maxWaitersPerTenant?: number;
  warningIntervalMs?: number;
  now?: () => number;
}

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
  return clampInteger(Number(raw), fallback, min, max);
}

export function closeReadinessDemandOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxWaiters: envInteger(env, "PAPERCLIP_CLOSE_READINESS_GLOBAL_WAITER_CAP", 64, 1, 4_096),
    maxWaitersPerWorkspace: envInteger(env, "PAPERCLIP_CLOSE_READINESS_PER_WORKSPACE_WAITER_CAP", 8, 1, 1_024),
    maxWaitersPerTenant: envInteger(env, "PAPERCLIP_CLOSE_READINESS_PER_TENANT_WAITER_CAP", 32, 1, 2_048),
  };
}

export class CloseReadinessDemandLimiter {
  private readonly maxWaiters: number;
  private readonly maxWaitersPerWorkspace: number;
  private readonly maxWaitersPerTenant: number;
  private readonly warningIntervalMs: number;
  private readonly now: () => number;
  private readonly byWorkspace = new Map<string, number>();
  private readonly byTenant = new Map<string, number>();
  private waiterCount = 0;
  private peakWaiters = 0;
  private lastWarningAt = 0;
  private suppressedWarnings = 0;
  private readonly totals = {
    admitted: 0,
    rejected: 0,
    aborted: 0,
    timedOut: 0,
    degraded: 0,
  };

  constructor(options: CloseReadinessDemandLimiterOptions = {}) {
    this.maxWaiters = clampInteger(options.maxWaiters, 64, 1, 4_096);
    this.maxWaitersPerWorkspace = clampInteger(options.maxWaitersPerWorkspace, 8, 1, 1_024);
    this.maxWaitersPerTenant = clampInteger(options.maxWaitersPerTenant, 32, 1, 2_048);
    this.warningIntervalMs = clampInteger(options.warningIntervalMs, 10_000, 1, 60 * 60_000);
    this.now = options.now ?? Date.now;
  }

  acquire(input: { workspaceKey: string; tenantKey: string }): () => void {
    const workspaceWaiters = this.byWorkspace.get(input.workspaceKey) ?? 0;
    const tenantWaiters = this.byTenant.get(input.tenantKey) ?? 0;
    const phase = this.waiterCount >= this.maxWaiters
      ? "global"
      : workspaceWaiters >= this.maxWaitersPerWorkspace
        ? "workspace"
        : tenantWaiters >= this.maxWaitersPerTenant
          ? "tenant"
          : null;
    if (phase) {
      this.totals.rejected += 1;
      this.warnRateLimited(phase, input.workspaceKey, input.tenantKey);
      throw new HttpError(
        503,
        "Workspace close readiness is temporarily at capacity",
        {
          code: CLOSE_READINESS_ERROR_CODES.saturated,
          retryable: false,
          retryAfterSeconds: 1,
          phase,
        },
      );
    }

    this.waiterCount += 1;
    this.peakWaiters = Math.max(this.peakWaiters, this.waiterCount);
    this.byWorkspace.set(input.workspaceKey, workspaceWaiters + 1);
    this.byTenant.set(input.tenantKey, tenantWaiters + 1);
    this.totals.admitted += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waiterCount = Math.max(0, this.waiterCount - 1);
      this.decrement(this.byWorkspace, input.workspaceKey);
      this.decrement(this.byTenant, input.tenantKey);
    };
  }

  recordAborted(): void {
    this.totals.aborted += 1;
  }

  recordTimedOut(): void {
    this.totals.timedOut += 1;
  }

  recordDegraded(): void {
    this.totals.degraded += 1;
  }

  snapshot(): CloseReadinessDemandSnapshot {
    return {
      waiterCount: this.waiterCount,
      workspaceKeyCount: this.byWorkspace.size,
      tenantKeyCount: this.byTenant.size,
      maxWaiters: this.maxWaiters,
      maxWaitersPerWorkspace: this.maxWaitersPerWorkspace,
      maxWaitersPerTenant: this.maxWaitersPerTenant,
      peakWaiters: this.peakWaiters,
      totals: { ...this.totals },
    };
  }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  private warnRateLimited(phase: string, workspaceKey: string, tenantKey: string): void {
    const now = this.now();
    if (now - this.lastWarningAt < this.warningIntervalMs) {
      this.suppressedWarnings += 1;
      return;
    }
    const suppressedSinceLastWarning = this.suppressedWarnings;
    this.lastWarningAt = now;
    this.suppressedWarnings = 0;
    logger.warn({
      event: "execution_workspace_close_readiness_demand",
      outcome: "rejected",
      phase,
      workspaceKey,
      tenantKey,
      waiterCount: this.waiterCount,
      rejectedCount: this.totals.rejected,
      suppressedSinceLastWarning,
    }, "execution workspace close-readiness demand saturated");
  }
}

export function createCloseReadinessDemandLimiter(options: CloseReadinessDemandLimiterOptions = {}) {
  return new CloseReadinessDemandLimiter(options);
}

export const closeReadinessDemandLimiter = createCloseReadinessDemandLimiter(
  closeReadinessDemandOptionsFromEnv(),
);

export function getCloseReadinessDemandSnapshot(): CloseReadinessDemandSnapshot {
  return closeReadinessDemandLimiter.snapshot();
}
