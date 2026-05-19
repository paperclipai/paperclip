// Pure helpers behind the LET-484 `/eaos/projects` zone. Source of truth:
// `projectsApi.list` + `goalsApi.list`. This module wires the two reads
// together into a roadmap view — one row per project, with the project's
// linked goals + ownership and a status group bucket. Action (start /
// archive / configure workspace) stays inside the kernel project detail
// page; this surface is read-only.

import type { Goal, Project } from "@paperclipai/shared";

export type RoadmapBucketId = "in_progress" | "planned" | "backlog" | "shipped" | "stopped";

export interface ProjectRoadmapRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: Project["status"];
  readonly leadAgentId: string | null;
  readonly targetDate: string | null;
  readonly goalCount: number;
  readonly goalTitles: readonly string[];
  readonly workspaceCount: number;
  readonly pauseReason: string | null;
  readonly archivedAt: Date | null;
  readonly kernelRoute: string;
}

export interface ProjectRoadmapCounts {
  readonly total: number;
  readonly inProgress: number;
  readonly planned: number;
  readonly backlog: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly archived: number;
  readonly paused: number;
  readonly activeGoals: number;
}

export interface ProjectRoadmapBucket {
  readonly id: RoadmapBucketId;
  readonly label: string;
  readonly rows: readonly ProjectRoadmapRow[];
}

function toDate(value: Project["archivedAt"]): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as unknown as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildProjectRoadmapRow(
  project: Project,
  goalsById: Map<string, Goal>,
): ProjectRoadmapRow {
  const goalIds = project.goalIds && project.goalIds.length > 0
    ? project.goalIds
    : project.goalId
      ? [project.goalId]
      : [];
  const goalTitles = goalIds
    .map((id) => goalsById.get(id)?.title ?? null)
    .filter((title): title is string => Boolean(title));
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    leadAgentId: project.leadAgentId,
    targetDate: project.targetDate,
    goalCount: goalIds.length,
    goalTitles,
    workspaceCount: project.workspaces.length,
    pauseReason: project.pauseReason,
    archivedAt: toDate(project.archivedAt),
    kernelRoute: `/projects/${project.id}`,
  };
}

export function summarizeRoadmap(
  projects: readonly Project[],
  goals: readonly Goal[],
): ProjectRoadmapCounts {
  let inProgress = 0;
  let planned = 0;
  let backlog = 0;
  let completed = 0;
  let cancelled = 0;
  let archived = 0;
  let paused = 0;
  for (const project of projects) {
    if (project.archivedAt) archived += 1;
    if (project.pausedAt) paused += 1;
    switch (project.status) {
      case "in_progress":
        inProgress += 1;
        break;
      case "planned":
        planned += 1;
        break;
      case "backlog":
        backlog += 1;
        break;
      case "completed":
        completed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }
  }
  const activeGoals = goals.filter((goal) => goal.status === "active").length;
  return {
    total: projects.length,
    inProgress,
    planned,
    backlog,
    completed,
    cancelled,
    archived,
    paused,
    activeGoals,
  };
}

export function groupRoadmap(
  projects: readonly Project[],
  goals: readonly Goal[],
): readonly ProjectRoadmapBucket[] {
  const goalsById = new Map(goals.map((goal) => [goal.id, goal] as const));
  const rows = projects.map((project) => buildProjectRoadmapRow(project, goalsById));
  // Stable bucketing — `shipped` covers completed; `stopped` covers cancelled
  // OR archived (operator perspective: this work is no longer on the board).
  const inProgress = rows.filter((row) => row.status === "in_progress" && !row.archivedAt);
  const planned = rows.filter((row) => row.status === "planned" && !row.archivedAt);
  const backlog = rows.filter((row) => row.status === "backlog" && !row.archivedAt);
  const shipped = rows.filter((row) => row.status === "completed" && !row.archivedAt);
  const stopped = rows.filter((row) => row.status === "cancelled" || Boolean(row.archivedAt));
  // Sort each bucket by name for deterministic rendering.
  const byName = (a: ProjectRoadmapRow, b: ProjectRoadmapRow) => a.name.localeCompare(b.name);
  return [
    { id: "in_progress", label: "In progress", rows: [...inProgress].sort(byName) },
    { id: "planned", label: "Planned", rows: [...planned].sort(byName) },
    { id: "backlog", label: "Backlog", rows: [...backlog].sort(byName) },
    { id: "shipped", label: "Shipped", rows: [...shipped].sort(byName) },
    { id: "stopped", label: "Stopped or archived", rows: [...stopped].sort(byName) },
  ];
}
