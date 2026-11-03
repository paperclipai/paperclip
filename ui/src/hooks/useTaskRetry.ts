import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

export function useTaskRetry(issue: Issue | undefined) {
  const queryClient = useQueryClient();
  const request = useRef<{ issueId: string; idempotencyKey: string; observedRunId: string | null } | null>(null);
  const [optimistic, setOptimistic] = useState(false);
  const [takingLonger, setTakingLonger] = useState(false);
  const [reconcile, setReconcile] = useState<{ issueId: string; sourceRunId: string | null } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ issueId, ...body }: { issueId: string; idempotencyKey: string; observedRunId: string | null }) =>
      issuesApi.retryTask(issueId, body),
    onSuccess: async (result, variables) => {
      const isCurrent = request.current?.idempotencyKey === variables.idempotencyKey;
      if (isCurrent) request.current = null;
      if (isCurrent && result.accepted) setReconcile({ issueId: variables.issueId, sourceRunId: variables.observedRunId });
      {
        queryClient.setQueryData<Issue>(queryKeys.issues.detail(variables.issueId), current =>
          current ? { ...current, interruption: result.presentation } : current);
        await Promise.all([queryKeys.issues.detail(variables.issueId), queryKeys.issues.runs(variables.issueId),
          queryKeys.issues.liveRuns(variables.issueId), queryKeys.issues.activeRun(variables.issueId)].map(queryKey =>
          queryClient.invalidateQueries({ queryKey })));
      }
      if (isCurrent && !request.current) { setOptimistic(false); setTakingLonger(false); }
    },
    onError: (error, variables) => {
      if (request.current?.idempotencyKey !== variables.idempotencyKey) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        request.current = null;
        setOptimistic(false);
        setTakingLonger(false);
      } else {
        setTakingLonger(true);
      }
    },
  });
  useEffect(() => {
    if (!reconcile || issue?.id !== reconcile.issueId || issue.interruption?.retryWait ||
        issue.interruption?.observedRunId !== reconcile.sourceRunId) return;
    // Dispatch follows the committed HTTP receipt. Read its admission reason
    // after that handoff, including the existing ten-second presentation grace.
    // These bounded reads end with this click; idle tasks do not poll.
    const timers = [1_000, 10_000].map(delay => window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(reconcile.issueId) });
    }, delay));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [reconcile, issue?.id, issue?.interruption?.observedRunId, issue?.interruption?.retryWait, queryClient]);
  useEffect(() => {
    if (!optimistic) return;
    const timer = window.setTimeout(() => {
      setTakingLonger(true);
      // Reconcile the identical durable request after a lost response. This
      // creates neither a second generation nor a second optimistic tail.
      if (request.current) mutation.mutate(request.current);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [optimistic]);
  useEffect(() => {
    request.current = null;
    setOptimistic(false);
    setTakingLonger(false);
    setReconcile(null);
    mutation.reset();
  }, [issue?.id]);
  return { retry: () => {
    if (!issue) return;
    setReconcile(null);
    mutation.reset();
    request.current ??= { issueId: issue.id, idempotencyKey: crypto.randomUUID(),
      observedRunId: issue.interruption?.observedRunId ?? issue.executionBlocker?.runId ?? null };
    setOptimistic(true);
    setTakingLonger(false);
    mutation.mutate(request.current);
  }, optimistic, takingLonger, error: mutation.error };
}
