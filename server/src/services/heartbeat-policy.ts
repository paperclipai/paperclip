function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CLOCK_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function normalizeClockTime(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const match = CLOCK_TIME_PATTERN.exec(raw);
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function toMinuteOfDay(clockTime: string): number {
  const [hourPart, minutePart] = clockTime.split(":");
  const hour = Number.parseInt(hourPart ?? "", 10);
  const minute = Number.parseInt(minutePart ?? "", 10);
  return hour * 60 + minute;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function minuteOfDayInTimeZone(now: Date, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hourRaw = parts.find((part) => part.type === "hour")?.value;
  const minuteRaw = parts.find((part) => part.type === "minute")?.value;
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export interface HeartbeatExecutionWindowPolicy {
  startTime: string;
  endTime: string;
  timeZone: string;
}

export function parseHeartbeatExecutionWindowPolicy(
  heartbeatConfig: unknown,
): HeartbeatExecutionWindowPolicy | null {
  const heartbeat = asRecord(heartbeatConfig);
  if (!heartbeat) return null;
  const executionWindow = asRecord(heartbeat.executionWindow);
  if (!executionWindow) return null;

  const startTime = normalizeClockTime(executionWindow.startTime ?? executionWindow.start);
  const endTime = normalizeClockTime(executionWindow.endTime ?? executionWindow.end);
  const timeZone = asNonEmptyString(executionWindow.timeZone ?? executionWindow.timezone) ?? "UTC";
  if (!startTime || !endTime || !isValidTimeZone(timeZone)) return null;

  return {
    startTime,
    endTime,
    timeZone,
  };
}

export function isHeartbeatExecutionWindowActive(
  policy: HeartbeatExecutionWindowPolicy,
  now: Date,
): boolean {
  const nowMinute = minuteOfDayInTimeZone(now, policy.timeZone);
  if (nowMinute == null) return false;
  const startMinute = toMinuteOfDay(policy.startTime);
  const endMinute = toMinuteOfDay(policy.endTime);

  // start == end means "all day".
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) {
    return nowMinute >= startMinute && nowMinute < endMinute;
  }
  return nowMinute >= startMinute || nowMinute < endMinute;
}
