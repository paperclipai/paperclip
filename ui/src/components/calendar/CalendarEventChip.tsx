import type { CSSProperties } from "react";
import type { CalendarEvent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { formatTime, scheduleLocalTime } from "@/lib/calendar-grid";
import { CALENDAR_KIND_META, eventHue, eventStatusLabel } from "./calendar-visuals";

interface CalendarEventChipProps {
  event: CalendarEvent;
  viewerTimeZone: string;
  /** `compact` is the month cell; `full` is the time grid and agenda. */
  variant?: "compact" | "full";
  /**
   * How many occurrences of the same series this chip stands for. Above 1 the
   * chip shows a count instead of the calendar repeating one routine hundreds
   * of times.
   */
  count?: number;
  /** ISO timestamp of the last occurrence, when `count` is above 1. */
  lastAt?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * One occurrence.
 *
 * The chip label uses an 11px size rather than the `text-xs` step. A month cell
 * has to fit three chips plus an overflow line inside ~96px of height, and a
 * week column has to fit a time and a title inside ~95px of width; at
 * `text-xs` the title truncates to a stub in both. This matches the existing
 * dense-list idiom in the sidebar and agent lists rather than inventing a new
 * one. Every *colour* comes from the semantic `--status-*` tokens.
 *
 * Projected and actual entries are told apart *structurally* — a projected chip
 * is a dashed outline with no fill, an actual chip is filled — rather than by
 * hue alone, so the distinction survives a monochrome display and does not
 * depend on colour vision. Text colour is identical either way, so the
 * forecast/fact distinction never costs contrast.
 */
export function CalendarEventChip({
  event,
  viewerTimeZone,
  variant = "full",
  count = 1,
  lastAt,
  style,
  className,
}: CalendarEventChipProps) {
  const meta = CALENDAR_KIND_META[event.kind];
  const Icon = meta.icon;
  const start = new Date(event.at);
  const localTime = formatTime(start);
  const scheduleTime = scheduleLocalTime(event, viewerTimeZone);
  const statusLabel = eventStatusLabel(event);
  const collapsed = count > 1;
  const timeLabel =
    collapsed && lastAt ? `${localTime}–${formatTime(new Date(lastAt))}` : localTime;

  const label = [
    statusLabel,
    meta.label,
    event.title,
    collapsed ? `${count} occurrences between ${timeLabel}` : `at ${localTime}`,
    scheduleTime ? `— ${scheduleTime} in ${event.scheduleTimezone}` : null,
    event.agentName ? `— ${event.agentName}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="tabular-nums shrink-0">{timeLabel}</span>
      <span className="truncate">{event.title}</span>
      {collapsed ? (
        <span className="ml-auto shrink-0 tabular-nums opacity-80">×{count}</span>
      ) : null}
    </>
  );

  const chipClassName = cn(
    "status-chip calendar-chip flex items-center gap-1.5 border px-1.5 text-[11px] leading-tight w-full text-left",
    variant === "compact" ? "py-0.5" : "py-1 h-full overflow-hidden items-start",
    event.href && "hover:brightness-95 dark:hover:brightness-125 transition-[filter]",
    className,
  );

  const chipStyle = { ...style, "--sc": eventHue(event) } as CSSProperties;

  if (!event.href) {
    return (
      <span
        className={chipClassName}
        style={chipStyle}
        data-tense={event.tense}
        data-kind={event.kind}
        title={label}
        aria-label={label}
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      to={event.href}
      className={chipClassName}
      style={chipStyle}
      data-tense={event.tense}
      data-kind={event.kind}
      title={label}
      aria-label={label}
    >
      {body}
    </Link>
  );
}
