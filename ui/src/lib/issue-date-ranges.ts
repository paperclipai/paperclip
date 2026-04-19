export type TaskDatePreset = "today" | "tomorrow" | "next7";

export interface MonthGridDay {
  date: string;
  dayOfMonth: number;
  inCurrentMonth: boolean;
  isToday: boolean;
}

export interface TaskDateRange {
  dueDate?: string;
  dueFrom?: string;
  dueTo?: string;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatDateOnly(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-");
}

export function parseDateOnly(dateOnly: string): Date {
  const match = DATE_ONLY_RE.exec(dateOnly);
  if (!match) return new Date(dateOnly);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addDays(dateOnly: string, days: number): string {
  const date = parseDateOnly(dateOnly);
  date.setDate(date.getDate() + days);
  return formatDateOnly(date);
}

export function firstOfMonth(dateOnly: string): string {
  const date = parseDateOnly(dateOnly);
  return formatDateOnly(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function addMonths(dateOnly: string, months: number): string {
  const date = parseDateOnly(dateOnly);
  return formatDateOnly(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

export function monthLabel(dateOnly: string): string {
  return parseDateOnly(dateOnly).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function dateHeading(dateOnly: string, today: string = formatDateOnly()): string {
  if (dateOnly === today) return "Today";
  if (dateOnly === addDays(today, 1)) return "Tomorrow";
  return parseDateOnly(dateOnly).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function dateLongLabel(dateOnly: string): string {
  return parseDateOnly(dateOnly).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function taskDateRange(preset: TaskDatePreset, today: string = formatDateOnly()): TaskDateRange {
  if (preset === "today") return { dueDate: today };
  if (preset === "tomorrow") return { dueDate: addDays(today, 1) };
  return { dueFrom: today, dueTo: addDays(today, 6) };
}

export function monthGrid(monthDate: string, today: string = formatDateOnly()): MonthGridDay[] {
  const monthStart = parseDateOnly(firstOfMonth(monthDate));
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const days: MonthGridDay[] = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const date = formatDateOnly(cursor);
    days.push({
      date,
      dayOfMonth: cursor.getDate(),
      inCurrentMonth: cursor.getMonth() === monthStart.getMonth(),
      isToday: date === today,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function visibleMonthRange(monthDate: string, today: string = formatDateOnly()): { from: string; to: string } {
  const days = monthGrid(monthDate, today);
  return {
    from: days[0]?.date ?? firstOfMonth(monthDate),
    to: days.at(-1)?.date ?? firstOfMonth(monthDate),
  };
}
