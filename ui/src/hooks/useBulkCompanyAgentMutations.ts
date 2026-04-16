/**
 * useBulkCompanyAgentMutations
 *
 * Bulk pause / resume all agents in a company with toast feedback.
 *
 * Based on community work by @aronprins:
 *   PR:    https://github.com/paperclipai/paperclip/pull/466
 *   Post:  https://x.com/aronprins/status/2042965786277347530
 *
 * Thank you Aaron for pioneering this UX and sharing it with the community! 🙌
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

export function useBulkCompanyAgentMutations(companyId: string | null) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const invalidate = useCallback(() => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
  }, [queryClient, companyId]);

  const bulkPause = useMutation({
    mutationFn: async () => {
      if (!companyId) return 0;
      const agents = await agentsApi.list(companyId);
      const targets = agents.filter(
        (a) => a.status !== "terminated" && a.status !== "paused" && a.status !== "pending_approval",
      );
      const results = await Promise.allSettled(
        targets.map((a) => agentsApi.pause(a.id, companyId)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) throw new Error(`${failed} of ${targets.length} agents failed to pause`);
      return targets.length;
    },
    onSuccess: (count) => {
      pushToast({ title: `Paused ${count} agent${count === 1 ? "" : "s"}`, tone: "success" });
      invalidate();
    },
    onError: (err: Error) => pushToast({ title: err.message, tone: "error" }),
  });

  const bulkResume = useMutation({
    mutationFn: async () => {
      if (!companyId) return 0;
      const agents = await agentsApi.list(companyId);
      const targets = agents.filter((a) => a.status === "paused");
      const results = await Promise.allSettled(
        targets.map((a) => agentsApi.resume(a.id, companyId)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) throw new Error(`${failed} of ${targets.length} agents failed to resume`);
      return targets.length;
    },
    onSuccess: (count) => {
      pushToast({ title: `Resumed ${count} agent${count === 1 ? "" : "s"}`, tone: "success" });
      invalidate();
    },
    onError: (err: Error) => pushToast({ title: err.message, tone: "error" }),
  });

  return { bulkPause, bulkResume };
}
