import type {
  ResponsibilityProjectSummary,
  ResponsibilityRecentRun,
  ResponsibilityRoutineSummary,
  ResponsibilityTaskSummary,
} from "@paperclipai/shared";
import { isTerminalTaskStatus, localDateKey } from "./responsibilities";

/**
 * The one fact each row of the "One screen v2" responsibility tables shows
 * (experimental, `enableResponsibilities`), in plain words.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/** "just now", "5m ago", "8h ago", "2d ago", "3w ago", "2mo ago", against `now`. */
export function ago(at: Date | string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(at).getTime());
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / WEEK)}w ago`;
  return `${Math.floor(elapsed / MONTH)}mo ago`;
}

/** "Paused", "Not run yet", "Last successful run 8h ago", "Failed 2d ago", "Running, started 3h ago". */
export function routineStat(routine: Pick<ResponsibilityRoutineSummary, "status" | "lastRun">, now: Date): string {
  if (routine.status === "paused") return "Paused";
  const run = routine.lastRun;
  if (!run) return "Not run yet";
  const when = ago(run.at, now);
  if (run.outcome === "succeeded") return `Last successful run ${when}`;
  if (run.outcome === "failed") return `Failed ${when}`;
  return `Running, started ${when}`;
}

/** Whole calendar days from today (local) to a `YYYY-MM-DD` date; negative once it has passed. */
function daysUntil(date: string, now: Date): number | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  const [todayYear, todayMonth, todayDay] = localDateKey(now).split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(todayYear!, todayMonth! - 1, todayDay!)) / DAY);
}

/** "Due in 14 days", "Due tomorrow", "Due today", "1 day late", "5 days late"; null without a date. */
export function projectDueStat(project: Pick<ResponsibilityProjectSummary, "targetDate">, now: Date): string | null {
  if (!project.targetDate) return null;
  const days = daysUntil(project.targetDate, now);
  if (days === null) return null;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 1) return `Due in ${days} days`;
  return days === -1 ? "1 day late" : `${-days} days late`;
}

/** "4 of 10 tasks done", for the progress meter's words. */
export function projectProgressLabel(progress: NonNullable<ResponsibilityProjectSummary["progress"]>): string {
  return `${progress.done} of ${progress.total} ${progress.total === 1 ? "task" : "tasks"} done`;
}

/** Open tasks in the order given, and the done ones the table can reveal (cancelled ones are not shown). */
export function splitTasksForTable(tasks: readonly ResponsibilityTaskSummary[]): {
  open: ResponsibilityTaskSummary[];
  done: ResponsibilityTaskSummary[];
} {
  return {
    open: tasks.filter((task) => !isTerminalTaskStatus(task.status)),
    done: tasks.filter((task) => task.status === "done"),
  };
}

const RUN_ENDED: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

/** "Succeeded 1d ago", "Failed 2d ago", "Running, started 3m ago", "Queued 3m ago". */
export function runStat(run: Pick<ResponsibilityRecentRun, "status" | "createdAt" | "startedAt" | "finishedAt">, now: Date): string {
  if (run.status === "running") return `Running, started ${ago(run.startedAt ?? run.createdAt, now)}`;
  if (run.status === "queued") return `Queued ${ago(run.createdAt, now)}`;
  const word = RUN_ENDED[run.status] ?? `${run.status.charAt(0).toUpperCase()}${run.status.slice(1).replace(/_/g, " ")}`;
  return `${word} ${ago(run.finishedAt ?? run.startedAt ?? run.createdAt, now)}`;
}
