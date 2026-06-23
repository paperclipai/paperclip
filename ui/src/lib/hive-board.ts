import type { Issue, IssueStatus } from "@paperclipai/shared";

// MyHive board. Plans column holds plan-root issues (workMode='planning'); the
// rest project the 7 backend statuses. Blocked and Cancelled are split into their
// own lanes: Blocked is an orthogonal side-lane (a task is blocked *while* in
// development, and returns there when unblocked), Cancelled is a terminal archive
// lane (droppable into, never out). The four pipeline lanes (Open → In Dev → In
// Review → Done) keep strict forward-only drag.
export type HiveColumnId =
  | "plans"
  | "open"
  | "in_development"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export interface HiveColumnDef {
  id: HiveColumnId;
  label: string;
  // Backend statuses that land in this column (plans column matched by workMode).
  statuses: IssueStatus[];
  // Status a card takes when dragged INTO this column.
  dropTarget: IssueStatus | null;
}

export const HIVE_COLUMNS: HiveColumnDef[] = [
  { id: "plans", label: "Plans", statuses: [], dropTarget: null },
  { id: "open", label: "Open", statuses: ["backlog", "todo"], dropTarget: "todo" },
  {
    id: "in_development",
    label: "In Development",
    statuses: ["in_progress"],
    dropTarget: "in_progress",
  },
  { id: "blocked", label: "Blocked", statuses: ["blocked"], dropTarget: "blocked" },
  { id: "in_review", label: "In Review", statuses: ["in_review"], dropTarget: "in_review" },
  { id: "done", label: "Done", statuses: ["done"], dropTarget: "done" },
  { id: "cancelled", label: "Cancelled", statuses: ["cancelled"], dropTarget: "cancelled" },
];

// Forward-only ordering index for the linear pipeline lanes only. Plans (-1),
// Blocked, and Cancelled are NOT linear stages — their drag rules are special-cased
// in canDropOnColumn, so they are deliberately absent here.
const PIPELINE_ORDER: Partial<Record<HiveColumnId, number>> = {
  open: 0,
  in_development: 1,
  in_review: 2,
  done: 3,
};

const STATUS_TO_COLUMN: Record<IssueStatus, HiveColumnId> = {
  backlog: "open",
  todo: "open",
  in_progress: "in_development",
  blocked: "blocked",
  in_review: "in_review",
  done: "done",
  cancelled: "cancelled",
};

export function columnForIssue(issue: Pick<Issue, "status" | "workMode">): HiveColumnId {
  if (issue.workMode === "planning") return "plans";
  return STATUS_TO_COLUMN[issue.status] ?? "open";
}

export interface HiveColumns {
  plans: Issue[];
  open: Issue[];
  in_development: Issue[];
  blocked: Issue[];
  in_review: Issue[];
  done: Issue[];
  cancelled: Issue[];
}

// Project issues into columns. Plan-root issues go to Plans; everything else by
// status. (E7) A plan's own children are ordinary tickets and DO show in their
// status columns — we only keep the planning root out of Open.
export function projectIssuesToHiveColumns(issues: Issue[]): HiveColumns {
  const columns: HiveColumns = {
    plans: [],
    open: [],
    in_development: [],
    blocked: [],
    in_review: [],
    done: [],
    cancelled: [],
  };
  for (const issue of issues) {
    columns[columnForIssue(issue)].push(issue);
  }
  return columns;
}

// Drag rules:
//  - Pipeline lanes (Open → In Dev → In Review → Done): forward-only.
//  - Blocked: a side-lane off In Development. You can mark an in-dev task blocked,
//    and drag a blocked task back to In Development (unblock) or on to In Review.
//  - Cancelled: terminal. Any live lane can drop into it; nothing drags out.
//  - Plans: locked (use Activate).
// Backward/illegal moves are rejected here so the UI never fires a doomed
// transition; the server stage machine is the backstop.
export function canDropOnColumn(from: HiveColumnId, to: HiveColumnId): boolean {
  if (from === "plans" || to === "plans") return false;
  if (from === to) return false;

  // Cancelled is a terminal sink: droppable into from any live lane, never out.
  if (to === "cancelled") return from !== "done";
  if (from === "cancelled") return false;

  // Blocked is a side-lane bound to In Development.
  if (to === "blocked") return from === "in_development";
  if (from === "blocked") return to === "in_development" || to === "in_review";

  // Remaining moves are within the linear pipeline.
  const fromOrder = PIPELINE_ORDER[from];
  const toOrder = PIPELINE_ORDER[to];
  if (fromOrder === undefined || toOrder === undefined) return false;
  return toOrder > fromOrder;
}

export function targetStatusForColumn(to: HiveColumnId): IssueStatus | null {
  return HIVE_COLUMNS.find((c) => c.id === to)?.dropTarget ?? null;
}

// Number of first-tier tickets a draft plan would materialize on Activate.
// Mirrors the server activation rule exactly: server/src/services/plans.ts
// activate() materializes ONLY tiers[0].requestedChildren and rejects when that
// list is empty ("Plan has no first-tier tickets to activate"). The UI gates the
// Activate button on this so an empty plan never reaches that failing call.
// Keep in sync if the server ever materializes more than the first tier.
export function planFirstTierTicketCount(
  tiers: { requestedChildren?: unknown[] }[] | undefined,
): number {
  return tiers?.[0]?.requestedChildren?.length ?? 0;
}

// Build the first-tier requested children for a manually-authored plan. When an
// assignee is given, each task carries assigneeAgentId so the materialized
// tickets are assigned on Activate and the agent wakes (issue-assignment-wakeup
// only fires for assigned issues). Empty/blank assignee → unassigned tasks.
export function manualRequestedChildren(
  titles: string[],
  assigneeAgentId?: string,
): Record<string, unknown>[] {
  return titles.map((title) =>
    assigneeAgentId ? { title, assigneeAgentId } : { title },
  );
}
