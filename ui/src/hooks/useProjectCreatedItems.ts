import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { ActivityEvent, Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { projectCreatedItems } from "@/components/task-chat/project-created-items";

function availableProjects(results: UseQueryResult<Project>[]) {
  return results.flatMap((result) => (result.isSuccess ? [result.data] : []));
}

/** Creation receipts establish the cards; authorized project reads keep their
 * repository lists current as the same run adds or edits workspaces.
 */
export function useProjectCreatedItems(
  events: readonly ActivityEvent[],
  companyId?: string | null,
) {
  const receipts = useMemo(() => projectCreatedItems(events), [events]);
  const projects = useQueries({
    queries: receipts.map((receipt) => ({
      queryKey: queryKeys.projects.detail(receipt.projectId),
      queryFn: () => projectsApi.get(receipt.projectId, companyId!),
      enabled: Boolean(companyId),
      retry: false,
    })),
    combine: availableProjects,
  });
  return useMemo(
    () => projectCreatedItems(events, projects),
    [events, projects],
  );
}
