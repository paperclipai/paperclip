import type { ReactNode, Ref } from "react";

import type { CapabilityTaskStatus } from "../../../src/mock-core/capability-control-plane-types";

/**
 * Package-local equivalents of the product StatusBadge/chip anatomy. Every
 * state pairs color with a glyph and text so the surface stays readable
 * without color (contract §9.5).
 */

const STATUS_COPY: Record<CapabilityTaskStatus, { label: string; glyph: string }> = {
  backlog: { label: "Backlog", glyph: "○" },
  todo: { label: "Todo", glyph: "○" },
  in_progress: { label: "In progress", glyph: "◐" },
  in_review: { label: "In review", glyph: "◑" },
  done: { label: "Done", glyph: "✓" },
  blocked: { label: "Blocked", glyph: "✕" },
  cancelled: { label: "Cancelled", glyph: "–" },
};

const PRIORITY_GLYPH: Record<string, string> = {
  critical: "▲▲",
  high: "▲",
  medium: "▬",
  low: "▼",
};

export function StatusBadge({ status }: { status: CapabilityTaskStatus }) {
  const copy = STATUS_COPY[status];
  return (
    <span className="pit-status-badge" data-status={status}>
      <span aria-hidden="true">{copy.glyph}</span>
      {copy.label}
    </span>
  );
}

export function PriorityIcon({ priority }: { priority: string }) {
  return (
    <span className="pit-priority">
      <span aria-hidden="true">{PRIORITY_GLYPH[priority] ?? "▬"}</span>{" "}
      {priority.charAt(0).toUpperCase() + priority.slice(1)} priority
    </span>
  );
}

export function Chip({
  tone,
  children,
  title,
  testId,
  /** Set to -1 so focus management can land on a chip without adding a tab stop. */
  tabIndex,
  chipRef,
}: {
  tone?: "live" | "mock" | "accent" | "success" | "danger";
  children: ReactNode;
  title?: string;
  testId?: string;
  tabIndex?: number;
  chipRef?: Ref<HTMLSpanElement>;
}) {
  return (
    <span
      className="pit-chip"
      data-tone={tone}
      title={title}
      data-testid={testId}
      tabIndex={tabIndex}
      ref={chipRef}
    >
      {children}
    </span>
  );
}

export function Timestamp({ value }: { value: string }) {
  // Rendered from fixture data with a fixed locale so captures stay stable.
  const stamp = new Date(value);
  const hours = String(stamp.getUTCHours()).padStart(2, "0");
  const minutes = String(stamp.getUTCMinutes()).padStart(2, "0");
  const seconds = String(stamp.getUTCSeconds()).padStart(2, "0");
  return (
    <time className="pit-card-meta" dateTime={value}>
      {hours}:{minutes}:{seconds}
    </time>
  );
}

/** Re-exported so the thread strip and the deliverable card share one unit. */
export { capabilityFormatBytes as formatBytes } from "../../../src/issue-thread/types";
