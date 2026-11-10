import { queryOptions } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";

/** Active projects are exactly those the server would return without `includeArchived`. */
export function selectActiveProjects(projects: Project[]): Project[] {
  return projects.filter((project) => !project.archivedAt);
}

/**
 * The company project list. Every consumer shares the single
 * `includeArchived=true` read; active-only consumers filter it with `select`.
 * Two lists under separate keys used to fetch the same large payload twice on
 * one page (for example the sidebar and the Mine inbox).
 * `queryKeys.projects.all(companyId)` invalidation still reaches it.
 */
export function companyProjectsQuery(companyId: string, opts: { includeArchived?: boolean } = {}) {
  const base = {
    queryKey: queryKeys.projects.list(companyId, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
  };
  return opts.includeArchived
    ? queryOptions(base)
    : queryOptions({ ...base, select: selectActiveProjects });
}
