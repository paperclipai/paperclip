// ROCAA-25 Slice 3: daily-cron scheduler for the tier-mix digest.
//
// Fires once per day at the configured wall-clock time in America/New_York
// (default 08:15) and pushes the digest through the webhook dispatcher.
// The scheduler self-re-arms with a fresh setTimeout after each fire so
// we don't drift across DST boundaries.
//
// Configuration:
//   PAPERCLIP_TIER_DIGEST_SCHEDULE_HOUR     (0-23, default 8)
//   PAPERCLIP_TIER_DIGEST_SCHEDULE_MINUTE   (0-59, default 15)
//   PAPERCLIP_TIER_DIGEST_TIMEZONE          (IANA, default America/New_York)
//   PAPERCLIP_TIER_DIGEST_SCHEDULER_ENABLED (default "true" — set "false" to skip)
//
// Note: this module is intentionally decoupled from `heartbeatService` —
// the digest reads the observability SQLite store directly via the
// `buildTierDigest` pure builder.

import { logger } from "../middleware/logger.js";
import type { ObservabilityStore } from "./observability-store.js";
import { buildTierDigest, type TierDigest } from "./tier-digest.js";
import type { TierDigestWebhookDispatcher } from "./tier-digest-webhook.js";

const DEFAULT_HOUR = 8;
const DEFAULT_MINUTE = 15;
const DEFAULT_TIMEZONE = "America/New_York";

export interface TierDigestSchedulerOptions {
  store: ObservabilityStore;
  dispatcher: TierDigestWebhookDispatcher;
  /** Local wall-clock hour (0-23) in `timezone`. */
  hour?: number;
  /** Local wall-clock minute (0-59) in `timezone`. */
  minute?: number;
  /** IANA timezone identifier. */
  timezone?: string;
  /** Provide the current time. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override timer to enable deterministic tests. */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  log?: {
    info: (meta: Record<string, unknown>, message: string) => void;
    warn: (meta: Record<string, unknown>, message: string) => void;
    error: (meta: Record<string, unknown>, message: string) => void;
  };
}

export interface TierDigestScheduler {
  /** True once `start()` has armed a timer. */
  readonly running: boolean;
  /** Arms the next-tick timer. Safe to call multiple times (no-op if running). */
  start(): void;
  /** Cancels the pending timer and stops re-arming. */
  stop(): void;
  /** Fires a digest synchronously (for manual ops triggers / tests). */
  fireOnce(): Promise<TierDigest>;
  /** ms remaining until the next scheduled fire. Returns null when stopped. */
  nextDelayMs(): number | null;
}

/**
 * Compute the timestamp of the next `hour:minute` in `timezone` strictly
 * after `now`. Uses `Intl.DateTimeFormat` with the IANA tz to walk the
 * local-wall-clock representation across the DST boundary; we then binary-
 * search the UTC offset (which is at most ±14h) to land on a UTC instant
 * whose wall-clock projection in `timezone` matches the target.
 */
export function nextFireAt(params: {
  now: Date;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const { now, hour, minute, timezone } = params;
  // Step 1: figure out today's local-wall-clock date in `timezone`.
  const localToday = localYmdInTz(now, timezone);
  let candidate = wallClockUtc({
    year: localToday.year,
    month: localToday.month,
    day: localToday.day,
    hour,
    minute,
    timezone,
  });
  if (candidate.getTime() <= now.getTime()) {
    // Roll forward one calendar day (24h is enough since DST is at most ±1h).
    const tomorrow = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    const ymd = localYmdInTz(tomorrow, timezone);
    candidate = wallClockUtc({
      year: ymd.year,
      month: ymd.month,
      day: ymd.day,
      hour,
      minute,
      timezone,
    });
  }
  return candidate;
}

interface LocalYmd {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

function localYmdInTz(date: Date, timezone: string): LocalYmd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Given a target wall-clock (`y/m/d h:m` in `timezone`), return the UTC
 * `Date` that projects to that wall clock. Handles DST by iterating once:
 * compute the offset that `timezone` had at the naive-UTC interpretation,
 * subtract it, then re-check and adjust.
 */
function wallClockUtc(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const { year, month, day, hour, minute, timezone } = params;
  // First guess: treat the wall clock as if it were UTC.
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // What wall clock does that UTC produce in `timezone`?
  const offsetMin = offsetMinutesAt(new Date(naiveUtc), timezone);
  let candidate = new Date(naiveUtc - offsetMin * 60_000);
  // Re-evaluate offset at the candidate (handles spring-forward / fall-back).
  const offsetMin2 = offsetMinutesAt(candidate, timezone);
  if (offsetMin2 !== offsetMin) {
    candidate = new Date(naiveUtc - offsetMin2 * 60_000);
  }
  return candidate;
}

/**
 * Offset in minutes between `timezone` wall clock and UTC at `date`.
 * Positive when the timezone is ahead of UTC (e.g. +60 for CET).
 * Returns negative values for the Americas (e.g. -240 for EDT, -300 for EST).
 */
function offsetMinutesAt(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  // Intl reports `24` for midnight in some locales; normalize.
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function createTierDigestScheduler(
  options: TierDigestSchedulerOptions,
): TierDigestScheduler {
  const hour = clampInt(options.hour ?? DEFAULT_HOUR, 0, 23);
  const minute = clampInt(options.minute ?? DEFAULT_MINUTE, 0, 59);
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? (() => new Date());
  const setT = options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = options.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  const log = options.log ?? {
    info: (meta, message) => logger.info(meta, message),
    warn: (meta, message) => logger.warn(meta, message),
    error: (meta, message) => logger.error(meta, message),
  };

  let handle: ReturnType<typeof setTimeout> | null = null;
  let nextFireAtMs: number | null = null;
  let running = false;

  async function fireOnce(): Promise<TierDigest> {
    const stamp = now();
    const digest = buildTierDigest({ store: options.store, now: stamp });
    try {
      const outcome = await options.dispatcher.dispatchAndWait(digest);
      log.info(
        {
          outcome,
          totalInvocations: digest.totalInvocations,
          tier1Share24h: digest.tier1Share24h,
          tier1SaturationAlert: digest.tier1SaturationAlert,
          windowStart: digest.windowStart,
          windowEnd: digest.windowEnd,
        },
        "tier-digest fired",
      );
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "tier-digest dispatch threw",
      );
    }
    return digest;
  }

  function arm() {
    const stamp = now();
    const next = nextFireAt({ now: stamp, hour, minute, timezone });
    const delay = Math.max(0, next.getTime() - stamp.getTime());
    nextFireAtMs = next.getTime();
    handle = setT(() => {
      void fireOnce().finally(() => {
        if (running) arm();
      });
    }, delay);
    log.info(
      { timezone, hour, minute, nextFireAt: next.toISOString(), delayMs: delay },
      "tier-digest scheduler armed",
    );
  }

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      arm();
    },
    stop() {
      running = false;
      if (handle) {
        clearT(handle);
        handle = null;
      }
      nextFireAtMs = null;
    },
    fireOnce,
    nextDelayMs() {
      if (!running || nextFireAtMs == null) return null;
      return Math.max(0, nextFireAtMs - now().getTime());
    },
  };
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const v = Math.floor(value);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Resolve scheduler options from environment variables. */
export function tierDigestSchedulerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
} {
  const enabledRaw = env.PAPERCLIP_TIER_DIGEST_SCHEDULER_ENABLED;
  const enabled = enabledRaw == null ? true : enabledRaw.toLowerCase() !== "false";
  const hour = parsePositiveInt(env.PAPERCLIP_TIER_DIGEST_SCHEDULE_HOUR, DEFAULT_HOUR);
  const minute = parsePositiveInt(env.PAPERCLIP_TIER_DIGEST_SCHEDULE_MINUTE, DEFAULT_MINUTE);
  const timezone = env.PAPERCLIP_TIER_DIGEST_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  return { enabled, hour, minute, timezone };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}
