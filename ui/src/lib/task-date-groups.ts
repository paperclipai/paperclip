export type TaskDateGroup = "today" | "yesterday" | "earlier";

export const taskDateGroupLabels: Record<TaskDateGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

function localCalendarOrdinal(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Groups timestamps by the operator's local calendar, including across DST. */
export function taskDateGroup(value: Date | string | number, now: Date = new Date()): TaskDateGroup {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "earlier";

  const dayDifference = Math.round(
    (localCalendarOrdinal(now) - localCalendarOrdinal(date)) / (24 * 60 * 60 * 1000),
  );
  if (dayDifference <= 0) return "today";
  if (dayDifference === 1) return "yesterday";
  return "earlier";
}

/**
 * Returns the label to insert before the current row. A list made entirely of
 * older work does not begin with a redundant "Earlier" heading.
 */
export function taskDateGroupSeparator(
  previous: TaskDateGroup | null,
  current: TaskDateGroup,
): string | null {
  if (previous === current) return null;
  if (previous === null && current === "earlier") return null;
  return taskDateGroupLabels[current];
}
