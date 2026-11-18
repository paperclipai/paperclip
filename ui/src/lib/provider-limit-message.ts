import { formatDateTime } from "./utils";

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });
const relativeUnits = [
  [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"],
] as const;

export function formatProviderLimitMessage(message: string): string {
  if (!message.includes("provider usage limit")) return message;
  return message.replace(
    /\b(resets?|starts) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/g,
    (match: string, verb: string, timestamp: string) => {
      const resetAt = new Date(timestamp);
      const remainingMs = resetAt.getTime() - Date.now();
      if (!Number.isFinite(remainingMs)) return match;
      const [unitMs, unit] = relativeUnits.find(([size]) => Math.abs(remainingMs) >= size) ?? relativeUnits[3];
      const amount = Math.round(remainingMs / unitMs);
      const relative = amount === 0 ? "now" : relativeTimeFormatter.format(amount, unit);
      return `${verb} ${relative} (${formatDateTime(resetAt, { includeTimeZone: true })})`;
    },
  );
}
