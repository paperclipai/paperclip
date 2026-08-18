import { CalendarClock, CheckCircle2, CircleDot, Repeat, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CalendarEvent, CalendarEventKind } from "@paperclipai/shared";

export interface CalendarKindMeta {
  label: string;
  /**
   * True for kinds that describe something that has not happened yet. The
   * legend draws these as a dashed outline rather than a filled swatch, which
   * is the same forecast-versus-fact language the chips themselves use.
   */
  projected: boolean;
  /** Short label for the filter row, where space is tight. */
  shortLabel: string;
  icon: LucideIcon;
  /** Base hue fed to the shared `.status-chip` helper via `--sc`. */
  hue: string;
  description: string;
}

/**
 * One entry per event kind. `hue` reuses the product's existing status palette
 * rather than introducing calendar-specific colours, so light/dark and the
 * contrast rules already hold.
 */
export const CALENDAR_KIND_META: Record<CalendarEventKind, CalendarKindMeta> = {
  routine_scheduled: {
    projected: true,
    label: "Scheduled routines",
    shortLabel: "Scheduled",
    icon: CalendarClock,
    hue: "var(--status-task-in_progress)",
    description: "Cron occurrences that have not run yet",
  },
  routine_run: {
    projected: false,
    label: "Routine runs",
    shortLabel: "Runs",
    icon: Repeat,
    hue: "var(--status-task-in_progress)",
    description: "Routine executions that already happened",
  },
  task_monitor: {
    projected: true,
    label: "Task monitors",
    shortLabel: "Monitors",
    icon: CircleDot,
    hue: "var(--status-task-todo)",
    description: "The next scheduled check on a task",
  },
  task_activity: {
    projected: false,
    label: "Task activity",
    shortLabel: "Tasks",
    icon: CheckCircle2,
    hue: "var(--status-task-done)",
    description: "Tasks that started or completed",
  },
  agent_run: {
    projected: false,
    label: "Agent runs",
    shortLabel: "Agents",
    icon: Zap,
    hue: "var(--status-agent-idle)",
    description: "Agent heartbeat runs",
  },
};

/** Failures take the blocked hue whatever kind they belong to. */
export function eventHue(event: CalendarEvent): string {
  if (event.status === "failed") return "var(--status-task-blocked)";
  if (event.status === "cancelled" || event.status === "skipped") {
    return "var(--status-task-cancelled)";
  }
  return CALENDAR_KIND_META[event.kind].hue;
}

export function eventStatusLabel(event: CalendarEvent): string {
  if (event.tense === "projected") return "Projected";
  if (event.status === "failed") return "Failed";
  if (event.status === "skipped") return "Skipped";
  if (event.status === "cancelled") return "Cancelled";
  if (event.status === "running") return "Running";
  return "Completed";
}
