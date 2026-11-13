import { useQuery } from "@tanstack/react-query";
import { emailApi } from "@/api/email";

export function useEmailThread(companyId: string, issueId: string) {
  return useQuery({
    queryKey: ["email-thread", companyId, issueId],
    queryFn: () => emailApi.thread(companyId, issueId),
    enabled: Boolean(companyId && issueId) && !issueId.startsWith("chat:"),
    // A null response identifies an ordinary task. It can still refetch on
    // focus or invalidation, but only email tasks need recurring updates.
    refetchInterval: (query) => query.state.data === null ? false : 3000,
  });
}
