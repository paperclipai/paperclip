import type { Issue, IssueStatus } from "@paperclipai/shared";

// MyHive 5-column board. Plans column holds plan-root issues (workMode='planning');
// the other four project the 7 backend statuses into the operator's mental model.
export type HiveColumnId = "plans" | "open" | "in_development" | "in_review" | "done";

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
    statuses: ["in_progress", "blocked"],
    dropTarget: "in_progress",
  },
  { id: "in_review", label: "In Review", statuses: ["in_review"], dropTarget: "in_review" },
  { id: "done", label: "Done", statuses: ["done", "cancelled"], dropTarget: "done" },
];

// Forward-only ordering index for drag rules. Plans is -1 (never a drop target).
const COLUMN_ORDER: Record<HiveColumnId, number> = {
  plans: -1,
  open: 0,
  in_development: 1,
  in_review: 2,
  done: 3,
};

const STATUS_TO_COLUMN: Record<IssueStatus, HiveColumnId> = {
  backlog: "open",
  todo: "open",
  in_progress: "in_development",
  blocked: "in_development",
  in_review: "in_review",
  done: "done",
  cancelled: "done",
};

export function columnForIssue(issue: Pick<Issue, "status" | "workMode">): HiveColumnId {
  if (issue.workMode === "planning") return "plans";
  return STATUS_TO_COLUMN[issue.status] ?? "open";
}

export interface HiveColumns {
  plans: Issue[];
  open: Issue[];
  in_development: Issue[];
  in_review: Issue[];
  done: Issue[];
}

// Project issues into columns. Plan-root issues go to Plans; everything else by
// status. (E7) A plan's own children are ordinary tickets and DO show in their
// status columns — we only keep the planning root out of Open.
export function projectIssuesToHiveColumns(issues: Issue[]): HiveColumns {
  const columns: HiveColumns = {
    plans: [],
    open: [],
    in_development: [],
    in_review: [],
    done: [],
  };
  for (const issue of issues) {
    columns[columnForIssue(issue)].push(issue);
  }
  return columns;
}

// Drag rules: forward-only across Open → In Development → In Review → Done.
// Plans column is locked (cards never drop in or out via drag). Backward moves
// are rejected here so the UI never even fires a doomed transition; the server
// stage machine is the backstop.
export function canDropOnColumn(from: HiveColumnId, to: HiveColumnId): boolean {
  if (from === "plans" || to === "plans") return false;
  if (from === to) return false;
  return COLUMN_ORDER[to] > COLUMN_ORDER[from];
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
