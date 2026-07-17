import { useEffect, useState } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DUE_NOW_GRACE_MS = MINUTE_MS;

type MonitorDate = Date | string;

type MonitorDetails = {
  nextCheckAt?: MonitorDate | null;
  attemptCount?: number | null;
  serviceName?: string | null;
  status?: "scheduled" | "triggered" | "cleared" | null;
};

type MonitorPolicy = {
  nextCheckAt?: MonitorDate | null;
  serviceName?: string | null;
};

type ScheduledRetry = {
  status?: "scheduled_retry" | "queued" | "running" | "cancelled" | null;
  scheduledRetryAt?: MonitorDate | null;
  scheduledRetryAttempt?: number | null;
};

export interface MonitorIssueLike {
  executionState?: { monitor?: MonitorDetails | null } | null;
  executionPolicy?: { monitor?: MonitorPolicy | null } | null;
  monitorNextCheckAt?: MonitorDate | null;
  monitorAttemptCount?: number | null;
  scheduledRetry?: ScheduledRetry | null;
}

export type MonitorDisplayState =
  | "scheduled"
  | "retrying"
  | "due-now"
  | "overdue"
  | "cleared"
  | "none";

export interface DerivedMonitorState {
  state: MonitorDisplayState;
  nextCheckAt: MonitorDate | null;
  attemptCount: number;
  serviceName: string | null;
}

export interface MonitorDateTimeFormatOptions {
  locale?: Intl.LocalesArgument;
  timeZone?: string;
}

function toTimestamp(value: MonitorDate): number {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new RangeError("Invalid monitor date");
  return timestamp;
}

function formatDuration(durationMs: number): string {
  if (durationMs < MINUTE_MS) {
    return `${Math.max(1, Math.ceil(durationMs / SECOND_MS))}s`;
  }
  if (durationMs < HOUR_MS) {
    return `${Math.floor(durationMs / MINUTE_MS)}m`;
  }
  if (durationMs < DAY_MS) {
    const hours = Math.floor(durationMs / HOUR_MS);
    const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(durationMs / DAY_MS);
  const hours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatMonitorEta(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {
  const deltaMs = toTimestamp(nextCheckAt) - toTimestamp(now);
  if (deltaMs > 0) return `in ${formatDuration(deltaMs)}`;
  if (deltaMs > -DUE_NOW_GRACE_MS) return "due now";
  return `overdue by ${formatDuration(Math.abs(deltaMs))}`;
}

export function formatMonitorAbsolute(
  nextCheckAt: MonitorDate,
  options: MonitorDateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(new Date(toTimestamp(nextCheckAt)));
}

export function formatMonitorAbsoluteFull(
  nextCheckAt: MonitorDate,
  options: MonitorDateTimeFormatOptions = {},
): string {
  const date = new Date(toTimestamp(nextCheckAt));
  const datePart = new Intl.DateTimeFormat(options.locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: options.timeZone,
  }).format(date);
  const timePart = new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(date);
  return `${datePart}, ${timePart}`;
}

export function deriveMonitorState(issue: MonitorIssueLike, now: MonitorDate = new Date()): DerivedMonitorState {
  const runtimeMonitor = issue.executionState?.monitor ?? null;
  const policyMonitor = issue.executionPolicy?.monitor ?? null;
  const scheduledRetry = issue.scheduledRetry ?? null;
  const retryIsActive =
    scheduledRetry?.status === "scheduled_retry" ||
    scheduledRetry?.status === "queued" ||
    scheduledRetry?.status === "running";
  const nextCheckAt =
    runtimeMonitor?.nextCheckAt ??
    issue.monitorNextCheckAt ??
    policyMonitor?.nextCheckAt ??
    (retryIsActive ? scheduledRetry?.scheduledRetryAt : null) ??
    null;
  const hasMonitor = runtimeMonitor !== null || policyMonitor !== null || issue.monitorNextCheckAt != null;
  const attemptCount =
    runtimeMonitor?.attemptCount ??
    (hasMonitor ? issue.monitorAttemptCount : null) ??
    (retryIsActive ? scheduledRetry?.scheduledRetryAttempt : null) ??
    0;
  const serviceName = runtimeMonitor?.serviceName ?? policyMonitor?.serviceName ?? null;

  if (runtimeMonitor?.status === "cleared") {
    return { state: "cleared", nextCheckAt, attemptCount, serviceName };
  }

  if (!hasMonitor && !retryIsActive) {
    return { state: "none", nextCheckAt: null, attemptCount: 0, serviceName: null };
  }
  if (!nextCheckAt) {
    return { state: retryIsActive || attemptCount > 1 ? "retrying" : "scheduled", nextCheckAt, attemptCount, serviceName };
  }

  const deltaMs = toTimestamp(nextCheckAt) - toTimestamp(now);
  if (deltaMs <= -DUE_NOW_GRACE_MS) {
    return { state: "overdue", nextCheckAt, attemptCount, serviceName };
  }
  if (deltaMs <= 0) {
    return { state: "due-now", nextCheckAt, attemptCount, serviceName };
  }
  return {
    state: retryIsActive || attemptCount > 1 ? "retrying" : "scheduled",
    nextCheckAt,
    attemptCount,
    serviceName,
  };
}

function countdownCadence(nextCheckAt: MonitorDate): number {
  const deltaMs = toTimestamp(nextCheckAt) - Date.now();
  return deltaMs > -DUE_NOW_GRACE_MS && deltaMs < DUE_NOW_GRACE_MS ? SECOND_MS : 30 * SECOND_MS;
}

export function useMonitorCountdown(nextCheckAt: MonitorDate | null | undefined): Date {
  const [now, setNow] = useState(() => new Date());
  const nextCheckTimestamp = nextCheckAt == null ? null : toTimestamp(nextCheckAt);

  useEffect(() => {
    setNow(new Date());
    if (nextCheckTimestamp === null) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const scheduleNextTick = () => {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setNow(new Date());
        scheduleNextTick();
      }, countdownCadence(new Date(nextCheckTimestamp)));
    };

    scheduleNextTick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [nextCheckTimestamp]);

  return now;
}

export function formatMonitorOffset(nextCheckAt: MonitorDate): string {
  const eta = formatMonitorEta(nextCheckAt, new Date());
  if (eta === "due now") return "now";
  if (eta.startsWith("overdue by ")) return `${eta.slice("overdue by ".length)} ago`;
  return eta;
}
