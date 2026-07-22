export function formatRoutineTime(
  value: Date | string,
  timezone: string | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);

  try {
    return date.toLocaleString([], {
      ...options,
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return date.toLocaleString([], options);
  }
}
