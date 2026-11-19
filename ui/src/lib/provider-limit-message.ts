import { formatDateTime } from "./utils";

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });
const relativeUnits = [
  [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"],
] as const;
const resetTimestampPattern = /\b(resets?|starts) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/g;

export function providerLimitMessageResetAt(message: string): number | null {
  if (!message.includes("provider usage limit")) return null;
  let latest: number | null = null;
  for (const match of message.matchAll(resetTimestampPattern)) {
    const resetAt = Date.parse(match[2]);
    if (Number.isFinite(resetAt)) latest = Math.max(latest ?? resetAt, resetAt);
  }
  return latest;
}

export function formatProviderLimitTime(timestamp: string, now = Date.now()): string {
  const at = new Date(timestamp);
  const remainingMs = at.getTime() - now;
  if (!Number.isFinite(remainingMs)) return timestamp;
  const [unitMs, unit] = relativeUnits.find(([size]) => Math.abs(remainingMs) >= size) ?? relativeUnits[3];
  const amount = Math.round(remainingMs / unitMs);
  const relative = amount === 0 ? "now" : relativeTimeFormatter.format(amount, unit);
  return `${relative} (${formatDateTime(at, { includeTimeZone: true })})`;
}

export function formatProviderLimitMessage(message: string, now = Date.now()): string {
  if (!message.includes("provider usage limit")) return message;
  return message.replace(
    resetTimestampPattern,
    (match: string, verb: string, timestamp: string) => {
      if (!Number.isFinite(Date.parse(timestamp))) return match;
      return `${verb} ${formatProviderLimitTime(timestamp, now)}`;
    },
  );
}
