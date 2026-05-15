import type { Project } from "@paperclipai/shared";

export type ProjectSidebarStatusIndicator = "default" | "active" | "waiting" | "inactive";

type ProjectStatusInput = Pick<Project, "status" | "pauseReason" | "issueStatusSummary">;

const WAITING_ISSUE_STATUSES = ["blocked", "in_review", "todo", "backlog"] as const;

function issueStatusCount(project: ProjectStatusInput, status: keyof NonNullable<Project["issueStatusSummary"]>): number {
  return project.issueStatusSummary?.[status] ?? 0;
}

function hasIssueStatusSummary(project: ProjectStatusInput): boolean {
  return project.issueStatusSummary != null;
}

export function getProjectSidebarStatusIndicator(project: ProjectStatusInput): ProjectSidebarStatusIndicator {
  // Sidebar status is derived from issue state first, then project state:
  // blocked/in_review/todo/backlog issues -> waiting, in_progress issue/project -> active,
  // completed/cancelled/empty projects -> inactive, unknown legacy state -> default outline.
  const hasWaitingWork = WAITING_ISSUE_STATUSES.some((status) => issueStatusCount(project, status) > 0);
  if (project.pauseReason || hasWaitingWork) return "waiting";

  if (project.status === "in_progress" || issueStatusCount(project, "in_progress") > 0) return "active";

  if (project.status === "completed" || project.status === "cancelled") return "inactive";

  if (hasIssueStatusSummary(project)) return "inactive";

  if (project.status === "backlog" || project.status === "planned") return "waiting";

  return "default";
}

export const projectSidebarStatusIndicatorLabel: Record<ProjectSidebarStatusIndicator, string> = {
  default: "Project status: unset",
  active: "Project status: active work",
  waiting: "Project status: blocked or pending",
  inactive: "Project status: finished, empty, or inactive",
};

export const projectSidebarStatusIndicatorClass: Record<ProjectSidebarStatusIndicator, string> = {
  default: "border-foreground bg-transparent",
  active: "border-emerald-600 bg-emerald-500",
  waiting: "border-amber-500 bg-amber-400",
  inactive: "border-muted-foreground/55 bg-muted-foreground/45",
};
