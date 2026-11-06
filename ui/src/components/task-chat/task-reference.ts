import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The identifier ("PIX-3") of a task a tool call named by UUID. Shares the
 * issue detail cache, so a task the thread already loaded costs no request.
 * Until it resolves, or when it cannot, the row says "task" — never the id.
 */
export function useTaskReferenceLabel(taskId: string): string {
  const { data } = useQuery({
    queryKey: queryKeys.issues.detail(taskId),
    queryFn: () => issuesApi.get(taskId),
    staleTime: 5 * 60_000,
  });
  return data?.identifier?.trim() || "task";
}

/** A tool row's subject: the referenced task first, then any other argument. */
export function withTaskReference(target: string | undefined, taskLabel: string | undefined): string | undefined {
  if (!taskLabel) return target;
  return target ? `${taskLabel} · ${target}` : taskLabel;
}
