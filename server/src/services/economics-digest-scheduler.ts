import { logger } from "../middleware/logger.js";
import type { Db } from "@paperclipai/db";
import { executeEconomicsDigest, type EconomicsDigest } from "./economics-digest.js";

const DEFAULT_DAY_OF_WEEK = 1; // Monday
const DEFAULT_HOUR = 9; // 09:00 AM
const DEFAULT_MINUTE = 0;
const DEFAULT_TIMEZONE = "America/New_York";

export interface EconomicsDigestSchedulerOptions {
  db: Db;
  companyId: string;
  dayOfWeek?: number;
  hour?: number;
  minute?: number;
  timezone?: string;
  slackWebhookUrl?: string | null;
  now?: () => Date;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  log?: {
    info: (meta: Record<string, unknown>, message: string) => void;
    warn: (meta: Record<string, unknown>, message: string) => void;
    error: (meta: Record<string, unknown>, message: string) => void;
  };
}

export interface EconomicsDigestScheduler {
  readonly running: boolean;
  start(): void;
  stop(): void;
  fireOnce(): Promise<EconomicsDigest>;
  nextDelayMs(): number | null;
}

/**
 * Calculates next fire time for a weekly cron pattern: dayOfWeek, hour, minute.
 */
export function nextWeeklyFireAt(params: {
  now: Date;
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ...
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const { now, dayOfWeek, hour, minute, timezone } = params;

  const localToday = localYmdInTz(now, timezone);
  let candidate = wallClockUtc({
    year: localToday.year,
    month: localToday.month,
    day: localToday.day,
    hour,
    minute,
    timezone,
  });

  // Check days starting from today up to 8 days in future
  for (let i = 0; i < 8; i++) {
    const parts = getZonedMinuteParts(candidate, timezone);
    if (parts.weekday === dayOfWeek && candidate.getTime() > now.getTime()) {
      return candidate;
    }
    // Advance by 1 calendar day
    const nextDay = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    const ymd = localYmdInTz(nextDay, timezone);
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

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function localYmdInTz(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

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
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function wallClockUtc(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const { year, month, day, hour, minute, timezone } = params;
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetMin = offsetMinutesAt(new Date(naiveUtc), timezone);
  let candidate = new Date(naiveUtc - offsetMin * 60_000);
  const offsetMin2 = offsetMinutesAt(candidate, timezone);
  if (offsetMin2 !== offsetMin) {
    candidate = new Date(naiveUtc - offsetMin2 * 60_000);
  }
  return candidate;
}

export function createEconomicsDigestScheduler(
  options: EconomicsDigestSchedulerOptions,
): EconomicsDigestScheduler {
  const dayOfWeek = clampInt(options.dayOfWeek ?? DEFAULT_DAY_OF_WEEK, 0, 6);
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

  async function fireOnce(): Promise<EconomicsDigest> {
    const stamp = now();
    const digest = await executeEconomicsDigest(
      options.db,
      options.companyId,
      stamp,
      options.slackWebhookUrl,
    );
    return digest;
  }

  function arm() {
    const stamp = now();
    const next = nextWeeklyFireAt({ now: stamp, dayOfWeek, hour, minute, timezone });
    const delay = Math.max(0, next.getTime() - stamp.getTime());
    nextFireAtMs = next.getTime();
    handle = setT(() => {
      void fireOnce().finally(() => {
        if (running) arm();
      });
    }, delay);
    log.info(
      { timezone, dayOfWeek, hour, minute, nextFireAt: next.toISOString(), delayMs: delay },
      "economics-digest scheduler armed",
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

export function economicsDigestSchedulerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
} {
  const enabledRaw = env.PAPERCLIP_ECONOMICS_DIGEST_SCHEDULER_ENABLED;
  const enabled = enabledRaw == null ? true : enabledRaw.toLowerCase() !== "false";
  const dayOfWeek = parsePositiveInt(env.PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_DAY_OF_WEEK, DEFAULT_DAY_OF_WEEK);
  const hour = parsePositiveInt(env.PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_HOUR, DEFAULT_HOUR);
  const minute = parsePositiveInt(env.PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_MINUTE, DEFAULT_MINUTE);
  const timezone = env.PAPERCLIP_ECONOMICS_DIGEST_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  return { enabled, dayOfWeek, hour, minute, timezone };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}
