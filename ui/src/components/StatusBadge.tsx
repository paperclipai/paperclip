import { cn } from "../lib/utils";
import {
  statusBadge,
  statusBadgeClassic,
  statusBadgeDefault,
  agentStatusColor,
  agentStatusColorDefault,
  agentStatusBadge,
  agentStatusCapsule,
  agentStatusMotion,
  brandChipBadge,
  issueStatusColor,
  issueStatusColorDefault,
} from "../lib/status-colors";
import { useConferenceRoomChatEnabled } from "../hooks/useConferenceRoomChatEnabled";

export function StatusBadge({ status }: { status: string }) {
  // PAP-75 brand hues for issue statuses (todo/in_progress) ship behind the
  // Conference Room Chat flag (PAP-139); OFF keeps master's palette. Non-issue
  // entries are identical in both records.
  const { enabled: conferenceRoomChatEnabled } = useConferenceRoomChatEnabled();
  const palette = conferenceRoomChatEnabled ? statusBadge : statusBadgeClassic;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        palette[status] ?? statusBadgeDefault
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status chip — brand `.task-chip` (1px border, light/dark variants).
 * Distinct from the shared {@link StatusBadge} so the agents section can carry
 * the brand state colours without affecting run/issue/goal badges. `active`
 * renders as "idle" (alias for dead code).
 */
export function AgentStatusBadge({ status }: { status: string }) {
  const color = agentStatusColor[status] ?? agentStatusColorDefault;
  const label = status === "active" ? "idle" : status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0",
        agentStatusBadge[color]
      )}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status indicator — brand heartbeat capsule (vertical 8x16, r4). Running
 * agents pulse, broken (error) agents blink; both honor `prefers-reduced-motion`.
 */
export function AgentStatusCapsule({ status }: { status: string }) {
  const color = agentStatusColor[status] ?? agentStatusColorDefault;
  const motion = agentStatusMotion[status] ?? "";
  return (
    <span
      aria-hidden
      className={cn("inline-block h-4 w-2 rounded-[4px] shrink-0", agentStatusCapsule[color], motion)}
    />
  );
}

/**
 * Brand status glyph (12px) for the issue/task chip — paths lifted verbatim
 * from the PAP-75 `status-reference.html` guide (12px, `currentColor`). The
 * `in_progress` ring is half-filled (liveness), `done` is a filled circle with
 * a knocked-out check, `in_review` a ring + centre dot, `blocked` a ring + bar.
 */
export function IssueStatusGlyph({ status }: { status: string }) {
  const svgProps = {
    viewBox: "0 0 12 12",
    className: "h-3 w-3 shrink-0",
    "aria-hidden": true,
  } as const;

  switch (status) {
    case "todo":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />
        </svg>
      );
    case "in_review":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="6" cy="6" r="2" fill="currentColor" />
        </svg>
      );
    case "done":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
          <path
            d="M3.5 6 5.5 8 8.5 4.5"
            fill="none"
            className="stroke-background"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "blocked":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <rect x="3.5" y="5.2" width="5" height="1.6" rx="0.4" fill="currentColor" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 9 9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "backlog":
    default:
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      );
  }
}

/**
 * Issue/task status chip — brand `.task-chip` (1px border, 12px glyph,
 * light/dark), the same surface used by projects + agents. Maps the 7
 * `ISSUE_STATUSES` onto PAP-75 brand colours (todo → amber, in_progress → blue
 * "liveness", in_review → violet, done → green, blocked → red,
 * backlog/cancelled → gray). Each chip carries its glyph; `cancelled` is struck
 * through. Distinct from the shared {@link StatusBadge} so run/goal/approval
 * badges are unaffected.
 */
export function IssueStatusBadge({ status }: { status: string }) {
  // Conference Room Chat flag OFF (PAP-139): fall back to the plain master
  // badge — same markup master rendered at this badge's call sites.
  const { enabled: conferenceRoomChatEnabled } = useConferenceRoomChatEnabled();
  const color = issueStatusColor[status] ?? issueStatusColorDefault;
  if (!conferenceRoomChatEnabled) {
    return <StatusBadge status={status} />;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0",
        brandChipBadge[color],
        status === "cancelled" && "line-through"
      )}
    >
      <IssueStatusGlyph status={status} />
      {status.replace(/_/g, " ")}
    </span>
  );
}
