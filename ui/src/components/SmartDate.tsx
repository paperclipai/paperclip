import { useMemo } from "react";

/**
 * SmartDate - renders dates in a human-friendly format:
 *  - Today: "Today 2:30 PM"
 *  - Yesterday: "Yesterday 2:30 PM"
 *  - Within this year: "Mar 5"
 *  - Older: "Dec 15, 2025"
 *
 * Always shows the full absolute date/time on hover via title attribute.
 */

function formatSmartDate(date: Date): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const ts = date.getTime();

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (ts >= todayStart.getTime()) {
    return `Today ${timeStr}`;
  }

  if (ts >= yesterdayStart.getTime()) {
    return `Yesterday ${timeStr}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface SmartDateProps {
  date: Date | string;
  className?: string;
}

export function SmartDate({ date, className }: SmartDateProps) {
  const d = useMemo(() => (typeof date === "string" ? new Date(date) : date), [date]);

  const display = useMemo(() => formatSmartDate(d), [d]);

  const absolute = useMemo(
    () =>
      d.toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    [d],
  );

  return (
    <time dateTime={d.toISOString()} title={absolute} className={className}>
      {display}
    </time>
  );
}
