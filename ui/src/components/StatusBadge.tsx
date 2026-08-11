import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import {
  statusBadge,
  statusBadgeDefault,
  agentStatusMotion,
  agentStatusVar,
  agentStatusVarDefault,
  taskStatusVar,
  taskStatusVarDefault,
} from "../lib/status-colors";
import { StatusGlyph } from "./StatusGlyph";

/** Inline `--sc` local var pointing a status helper at a base-hue CSS var. */
function scStyle(cssVar: string): CSSProperties {
  return { "--sc": `var(${cssVar})` } as CSSProperties;
}

/** "in_review" → "In review" (sentence case). */
function sentenceCaseStatus(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generic status badge for runs / goals / approvals (not task status).
 */
// design-allow(pill-pattern): DECISION-SHEET.md C8 - status badges keep the bespoke WCAG-tuned
// .status-chip color-mix mechanic and do not wrap the Badge primitive.
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {label ?? status.replace(/[_-]/g, " ")}
    </span>
  );
}

/**
 * Agent status chip — bordered chip recoloured from the editable
 * `--status-agent-*` base hue via the `.status-chip` color-mix helper. `active`
 * renders as "idle" (alias for dead code).
 */
export function AgentStatusBadge({ status }: { status: string }) {
  const cssVar = agentStatusVar[status] ?? agentStatusVarDefault;
  const label = status === "active" ? "idle" : status;
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0"
      style={scStyle(cssVar)}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status indicator — heartbeat capsule (vertical 8x16, r4) filled from the
 * editable `--status-agent-*` base hue. Running agents pulse, broken (error)
 * agents blink; both honor `prefers-reduced-motion`.
 */
export function AgentStatusCapsule({ status }: { status: string }) {
  const cssVar = agentStatusVar[status] ?? agentStatusVarDefault;
  const motion = agentStatusMotion[status] ?? "";
  return (
    <span
      aria-hidden
      className={cn("status-fill inline-block h-4 w-2 rounded-(--rad-4) shrink-0", motion)}
      style={scStyle(cssVar)}
    />
  );
}

/**
 * Issue/task status chip — bordered chip recoloured from the editable
 * `--status-task-*` base hue via `.status-chip`, carrying the unified
 * {@link StatusGlyph} (one distinct, color-blind-safe shape per status), a
 * sentence-cased label and regular weight. `cancelled` is struck through.
 * Distinct from the generic {@link StatusBadge} so run/goal/approval badges are
 * unaffected.
 */
export function IssueStatusBadge({ status }: { status: string }) {
  const cssVar = taskStatusVar[status] ?? taskStatusVarDefault;
  return (
    <span
      className={cn(
        "status-chip inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-normal leading-none whitespace-nowrap shrink-0",
        status === "cancelled" && "line-through"
      )}
      style={scStyle(cssVar)}
    >
      <StatusGlyph status={status} size="sm" />
      {sentenceCaseStatus(status)}
    </span>
  );
}
