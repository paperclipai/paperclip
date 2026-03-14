import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

interface BulkResult {
  succeeded: number;
  failed: number;
}

function summarize(results: PromiseSettledResult<unknown>[]): BulkResult {
  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") succeeded++;
    else failed++;
  }
  return { succeeded, failed };
}

function formatResult(verb: string, { succeeded, failed }: BulkResult) {
  const s = succeeded !== 1 ? "s" : "";
  if (failed === 0) return { title: `${verb} ${succeeded} agent${s}`, tone: "success" as const };
  if (succeeded === 0) return { title: `Failed to ${verb.toLowerCase()} ${failed} agent${failed !== 1 ? "s" : ""}`, tone: "error" as const };
  return { title: `${verb} ${succeeded} agent${s}, ${failed} failed`, tone: "warn" as const };
}

export function useAgentBulkActions(agents: Agent[], companyId: string) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const stoppable = useMemo(
    () => agents.filter((a) => a.status === "active" || a.status === "idle"),
    [agents],
  );
  const startable = useMemo(
    () => agents.filter((a) => a.status === "paused"),
    [agents],
  );
  const retryable = useMemo(
    () => agents.filter((a) => a.status === "error"),
    [agents],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
  };

  const stopAll = useMutation({
    mutationFn: () =>
      Promise.allSettled(stoppable.map((a) => agentsApi.pause(a.id, companyId))).then(summarize),
    onSuccess: (r) => {
      pushToast(formatResult("Paused", r));
      invalidate();
    },
    onError: () => pushToast({ title: "Failed to pause agents", tone: "error" }),
  });

  const startAll = useMutation({
    mutationFn: () =>
      Promise.allSettled(startable.map((a) => agentsApi.resume(a.id, companyId))).then(summarize),
    onSuccess: (r) => {
      pushToast(formatResult("Resumed", r));
      invalidate();
    },
    onError: () => pushToast({ title: "Failed to resume agents", tone: "error" }),
  });

  const retryFailed = useMutation({
    mutationFn: () =>
      Promise.allSettled(retryable.map((a) => agentsApi.invoke(a.id, companyId))).then(summarize),
    onSuccess: (r) => {
      pushToast(formatResult("Retried", r));
      invalidate();
    },
    onError: () => pushToast({ title: "Failed to retry agents", tone: "error" }),
  });

  return {
    stoppableCount: stoppable.length,
    startableCount: startable.length,
    retryableCount: retryable.length,
    stopAll,
    startAll,
    retryFailed,
  };
}
