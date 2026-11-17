import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { getIssueCoreQueryOptions } from "@/lib/issueDetailCache";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The identifier ("PIX-3") of a task a tool call named by UUID. A task the
 * thread already loaded costs no request; otherwise only the core issue view
 * is read, under the cache key other surfaces share. Until it resolves, or
 * when it cannot, the row says "task" — never the id.
 */
export function useTaskReferenceLabel(taskId: string): string {
  const queryClient = useQueryClient();
  const cached = queryClient
    .getQueryData<Pick<Issue, "identifier">>(queryKeys.issues.detail(taskId))
    ?.identifier?.trim();
  const { data } = useQuery({
    ...getIssueCoreQueryOptions(queryClient, taskId),
    enabled: !cached,
    staleTime: 5 * 60_000,
  });
  return cached || data?.identifier?.trim() || "task";
}

/** A tool row's subject: the referenced task first, then any other argument. */
export function withTaskReference(target: string | undefined, taskLabel: string | undefined): string | undefined {
  if (!taskLabel) return target;
  return target ? `${taskLabel} · ${target}` : taskLabel;
}
