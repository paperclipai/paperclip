import type { IssueStatus } from "@paperclipai/shared";

export type IssueDueState = "none" | "overdue" | "today" | "upcoming" | "neutral";
export type IssueDueFilterState = Exclude<IssueDueState, "neutral">;
export const ISSUE_DUE_FILTER_STATES = [
  "overdue",
  "today",
  "upcoming",
  "none",
] as const satisfies readonly IssueDueFilterState[];

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatLocalDateOnly(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-");
}

export function isValidDateOnly(value: string): boolean {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;

  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

export function formatIssueDueDate(dueDate: string): string {
  const match = DATE_ONLY_RE.exec(dueDate);
  if (!match) return dueDate;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatIssueDueDateShort(dueDate: string): string {
  const match = DATE_ONLY_RE.exec(dueDate);
  if (!match) return dueDate;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function getIssueDueState(
  dueDate: string | null | undefined,
  status: IssueStatus,
  today: string = formatLocalDateOnly(),
): IssueDueState {
  if (!dueDate) return "none";
  if (TERMINAL_ISSUE_STATUSES.has(status)) return "neutral";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}
