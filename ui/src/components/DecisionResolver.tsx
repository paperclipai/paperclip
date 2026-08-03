import { useCallback, useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Agent, AttentionSubject } from "@paperclipai/shared";
import { decisionsApi, type DecisionOutcome } from "../api/decisions";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { DecisionCard, type DecisionIssueRef } from "./DecisionCard";

interface DecisionResolverProps {
  companyId: string;
  decisionId: string;
  /** Origin issue subject from the attention row (already carries identifier/href). */
  originIssue?: AttentionSubject | null;
  agentMap?: Map<string, Agent>;
  /** Complete terminal list item used to avoid one detail request per history row. */
  initialDecision?: DecisionOutcome;
  /** Called after a decide/dismiss so the parent can refresh the feed row. */
  onResolved?: () => void;
}

type IssueDetail = Awaited<ReturnType<typeof issuesApi.get>>;

// A module-level combine function lets TanStack Query structurally share this
// projection until issue data actually changes. Depending on useQueries' raw
// result array would invalidate resolveIssue on every render.
function combineIssueData(results: Array<{ data?: IssueDetail }>) {
  return results.map((result) => result.data);
}

export function signedCancelTreePreviewIds(targetIssueId: string, snapshot: { descendantIds?: string[] } | undefined) {
  return snapshot?.descendantIds ? [targetIssueId, ...snapshot.descendantIds] : null;
}

/**
 * Container for a Decisions-v1 decision surfaced in the attention feed. Fetches
 * the full decision (`get`) plus the shared open-list (for `targetChanged`),
 * resolves referenced issue ids + the cancel-tree preview, owns the decide /
 * dismiss mutations, and invalidates the attention feed + target-issue keys on
 * success — same conventions as {@link AttentionInteractionResolver}.
 */
export function DecisionResolver({ companyId, decisionId, originIssue, agentMap, initialDecision, onResolved }: DecisionResolverProps) {
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const issueHref = useCallback(
    (idOrIdentifier: string) => (prefix ? `/${prefix}/issues/${idOrIdentifier}` : `/issues/${idOrIdentifier}`),
    [prefix],
  );

  const detail = useQuery({
    queryKey: queryKeys.decisions.detail(decisionId),
    queryFn: () => decisionsApi.get(decisionId),
    enabled: !!decisionId,
    initialData: initialDecision,
    staleTime: 30_000,
  });
  const decision = detail.data;

  // Shared across every open decision row → a single fetch carries `targetChanged`.
  const openList = useQuery({
    queryKey: queryKeys.decisions.list(companyId, "open"),
    queryFn: () => decisionsApi.list(companyId, { status: "open" }),
    enabled: !!companyId && decision?.status === "open",
  });
  const targetChanged = useMemo(
    () => openList.data?.find((entry) => entry.id === decisionId)?.targetChanged ?? null,
    [openList.data, decisionId],
  );

  // Issue ids referenced by snapshots / effects / results, resolved to labels.
  const referencedIds = useMemo(() => {
    if (!decision) return [] as string[];
    const ids = new Set<string>(Object.keys(decision.targetSnapshots ?? {}));
    for (const snapshot of Object.values(decision.targetSnapshots ?? {})) {
      for (const descendantId of snapshot.descendantIds ?? []) ids.add(descendantId);
    }
    for (const option of decision.options) {
      for (const effect of option.effects) {
        ids.add(effect.targetIssueId);
        if (effect.type === "create_issue" && effect.draft.parentId) ids.add(effect.draft.parentId);
      }
    }
    for (const execution of decision.executions ?? []) {
      ids.add(execution.targetIssueId);
      const created = (execution.result ?? {}).issueId;
      if (typeof created === "string") ids.add(created);
    }
    if (originIssue?.id) ids.delete(originIssue.id);
    return [...ids];
  }, [decision, originIssue?.id]);

  const issueData = useQueries({
    queries: referencedIds.map((id) => ({
      queryKey: queryKeys.issues.detail(id),
      queryFn: () => issuesApi.get(id),
      staleTime: 30_000,
    })),
    combine: combineIssueData,
  });

  const resolveIssue = useMemo(() => {
    const map = new Map<string, DecisionIssueRef>();
    if (originIssue?.id) {
      map.set(originIssue.id, {
        id: originIssue.id,
        identifier: originIssue.identifier,
        title: originIssue.title,
        href: originIssue.href ?? issueHref(originIssue.identifier ?? originIssue.id),
        status: originIssue.status,
      });
    }
    issueData.forEach((issue, index) => {
      const id = referencedIds[index];
      if (issue && id) {
        map.set(id, {
          id,
          identifier: issue.identifier ?? null,
          title: issue.title ?? null,
          href: issueHref(issue.identifier ?? id),
          status: issue.status ?? null,
        });
      }
    });
    return (id: string) => map.get(id) ?? null;
  }, [originIssue, referencedIds, issueData, issueHref]);

  const cancelTreePreview = useCallback((targetIssueId: string): DecisionIssueRef[] | null => {
    const snapshot = decision?.targetSnapshots?.[targetIssueId];
    const signedIds = signedCancelTreePreviewIds(targetIssueId, snapshot);
    if (!signedIds) return null;
    const refs = signedIds.map(resolveIssue);
    return refs.every((ref): ref is DecisionIssueRef => ref !== null) ? refs : null;
  }, [decision?.targetSnapshots, resolveIssue]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.detail(decisionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.list(companyId, "open") });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.list(companyId, "decided") });
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    for (const id of Object.keys(decision?.targetSnapshots ?? {})) {
      queryClient.invalidateQueries({ queryKey: queryKeys.decisions.forTargetIssue(companyId, id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(id) });
    }
    onResolved?.();
  };

  const decideMutation = useMutation({
    mutationFn: (input: { optionId: string; inputValues: Record<string, string>; idempotencyKey?: string | null }) =>
      decisionsApi.decide(decisionId, input),
    retry: 2,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.decisions.detail(decisionId), data);
      invalidate();
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (reason: string | undefined) => decisionsApi.dismiss(decisionId, reason),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.decisions.detail(decisionId), data);
      invalidate();
    },
  });

  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading decision…
      </div>
    );
  }

  if (detail.error || !decision) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        This decision is no longer available — it may have been resolved elsewhere.
      </p>
    );
  }

  const busy = decideMutation.isPending || dismissMutation.isPending;
  const errorMessage =
    (decideMutation.error instanceof Error && decideMutation.error.message) ||
    (dismissMutation.error instanceof Error && dismissMutation.error.message) ||
    null;

  return (
    <DecisionCard
      decision={decision}
      executions={decision.executions}
      targetChanged={targetChanged}
      resolveIssue={resolveIssue}
      cancelTreePreview={cancelTreePreview}
      originAgentName={agentMap?.get(decision.originAgentId)?.name ?? null}
      originIssue={
        originIssue
          ? {
              id: originIssue.id,
              identifier: originIssue.identifier,
              title: originIssue.title,
              href: originIssue.href ?? issueHref(originIssue.identifier ?? originIssue.id),
              status: originIssue.status,
            }
          : null
      }
      busy={busy}
      errorMessage={errorMessage}
      onDecide={(optionId, inputValues) => decideMutation.mutate({ optionId, inputValues, idempotencyKey: crypto.randomUUID() })}
      onDismiss={(reason) => dismissMutation.mutate(reason)}
    />
  );
}
