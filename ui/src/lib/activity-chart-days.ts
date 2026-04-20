export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function getDatePartsInTimeZone(date: Date | string, timeZone: string): { year: number; month: number; day: number } {
  const value = new Date(date);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(value);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "0");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0");
  return { year, month, day };
}

export function formatDayKeyForTimeZone(date: Date | string, timeZone = getLocalTimeZone()): string {
  const { year, month, day } = getDatePartsInTimeZone(date, timeZone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function getLast14Days(now: Date = new Date(), timeZone = getLocalTimeZone()): string[] {
  const { year, month, day } = getDatePartsInTimeZone(now, timeZone);
  return Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1, day - (13 - i)));
    return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
  });
}
