import { t, useTranslation } from "@/i18n";
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


const STATUS_DISPLAY_KEYS: Record<string, string> = {
  "idle": "final-components-b:status.idle_c2a5bf",
  "running": "final-components-b:status.running_ea296e",
  "paused": "final-components-b:status.paused_2d478d",
  "error": "final-components-b:status.error_b2352a",
  "terminated": "final-components-b:status.terminated_9ec4d6",
  "pending_approval": "final-components-b:status.pending_approval_6869a1",
  "active": "final-components-b:status.active_bc241e",
  "backlog": "final-components-b:status.backlog_0fbb44",
  "todo": "final-components-b:status.todo_fc39e6",
  "in_progress": "final-components-b:status.in_progress_36e434",
  "monitoring": "final-components-b:status.monitoring_7c10bb",
  "in_review": "final-components-b:status.in_review_5784fc",
  "done": "final-components-b:status.done_243a89",
  "blocked": "final-components-b:status.blocked_dac981",
  "cancelled": "final-components-b:status.cancelled_7c6cc9",
  "pending": "final-components-b:status.pending_56759b",
  "queued": "final-components-b:status.queued_c7ff83",
  "succeeded": "final-components-b:status.succeeded_94bb70",
  "failed": "final-components-b:status.failed_60691e",
  "timed_out": "final-components-b:status.timed_out_70d81d",
  "approved": "final-components-b:status.approved_5e720c",
  "rejected": "final-components-b:status.rejected_815469",
  "revision_requested": "final-components-b:status.revision_requested_ca4396",
  "draft": "final-components-b:status.draft_247fa1",
  "completed": "final-components-b:status.completed_4801d4",
};

export function displayStatusLabel(status: string, sentenceCase = false): string {
  if (!Object.hasOwn(STATUS_DISPLAY_KEYS, status)) return status;
  const label = t(STATUS_DISPLAY_KEYS[status]);
  return sentenceCase ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/** Inline `--sc` local var pointing a status helper at a base-hue CSS var. */
function scStyle(cssVar: string): CSSProperties {
  return { "--sc": `var(${cssVar})` } as CSSProperties;
}

/** "in_review" → "In review" (sentence case). */
function sentenceCaseStatus(status: string): string {
  return displayStatusLabel(status, true);
}

/**
 * Generic status badge for runs / goals / approvals (not task status).
 */
// design-allow(pill-pattern): DECISION-SHEET.md C8 - status badges keep the bespoke WCAG-tuned
// .status-chip color-mix mechanic and do not wrap the Badge primitive.
export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  useTranslation("final-components-b");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault,
        className
      )}
    >
      {label ?? displayStatusLabel(status)}
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
  useTranslation("final-components-b");
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0"
      style={scStyle(cssVar)}
    >
      {displayStatusLabel(label)}
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
  useTranslation("final-components-b");
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
export function IssueStatusBadge({ status: taskStatus, displayStatus, externalConversationState }: { status: string; displayStatus?: string | null; externalConversationState?: "active" | "waiting" | null }) {
  const status = taskStatus === "in_review" && externalConversationState === "waiting" ? "idle" : taskStatus === "in_progress" && displayStatus === "monitoring" ? "monitoring" : taskStatus;
  const cssVar = taskStatusVar[status] ?? taskStatusVarDefault;
  useTranslation("final-components-b");
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
