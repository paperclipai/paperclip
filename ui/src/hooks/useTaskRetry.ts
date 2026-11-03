import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

type RetryRequest = { issueId: string; identifier?: string | null; idempotencyKey: string; observedRunId: string | null };

export function useTaskRetry(issue: Issue | undefined) {
  const queryClient = useQueryClient();
  const request = useRef<RetryRequest | null>(null);
  const [optimistic, setOptimistic] = useState(false);
  const [takingLonger, setTakingLonger] = useState(false);
  const [reconcile, setReconcile] = useState<{ refs: string[]; sourceRunId: string | null } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ issueId, identifier: _identifier, ...body }: RetryRequest) =>
      issuesApi.retryTask(issueId, body),
    onSuccess: async (result, variables) => {
      const isCurrent = request.current?.idempotencyKey === variables.idempotencyKey;
      if (isCurrent) request.current = null;
      const refs = [...new Set([variables.issueId, variables.identifier].filter((ref): ref is string => Boolean(ref)))];
      if (isCurrent && result.accepted) setReconcile({ refs, sourceRunId: variables.observedRunId });
      {
        for (const ref of refs) queryClient.setQueryData<Issue>(queryKeys.issues.detail(ref), current =>
          current ? { ...current, interruption: result.presentation } : current);
        await Promise.all(refs.flatMap(ref => [queryKeys.issues.detail(ref), queryKeys.issues.runs(ref),
          queryKeys.issues.liveRuns(ref), queryKeys.issues.activeRun(ref)]).map(queryKey =>
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
    if (!reconcile || !issue || !reconcile.refs.includes(issue.id) || issue.interruption?.retryWait ||
        issue.interruption?.observedRunId !== reconcile.sourceRunId) return;
    // Dispatch follows the committed HTTP receipt. Read its admission reason
    // after that handoff, including the existing ten-second presentation grace.
    // These bounded reads end with this click; idle tasks do not poll.
    const timers = [1_000, 10_000].map(delay => window.setTimeout(() => {
      for (const ref of reconcile.refs) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
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
    request.current ??= { issueId: issue.id, identifier: issue.identifier, idempotencyKey: crypto.randomUUID(),
      observedRunId: issue.interruption?.observedRunId ?? issue.executionBlocker?.runId ?? null };
    setOptimistic(true);
    setTakingLonger(false);
    mutation.mutate(request.current);
  }, optimistic, takingLonger, error: mutation.error };
}
