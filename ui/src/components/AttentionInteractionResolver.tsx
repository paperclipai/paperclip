import { useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { invalidateInteractionRecordViews } from "../lib/attention-record-views";
import {
  interactionReadinessRefetchInterval,
  isIssueThreadInteraction,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictValue,
  type SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import { useAttentionActionConfirmation } from "./AttentionCloseMenu";
import { DecisionCardFooter } from "./DecisionCardFooter";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";

interface AttentionInteractionResolverProps {
  companyId: string;
  issueId: string;
  interactionId: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  footerSlot?: ReactNode;
  /** A ready-made panel row for the decision's artifact, first in the compact
   * card's context panel (PAP-775). */
  artifactRow?: ReactNode;
  /** The same decision is shown in another view (card + Review side panel):
   * share one Revise… draft between them (PAP-773). */
  shareReviseDraft?: boolean;
  presentation?: "default" | "coordinator-decision";
  /** The card's audience line already names who may answer (PAP-767). */
  audienceStated?: boolean;
  /** Successful updates include partial item reviews; inspect status before settling the whole card. */
  onResolved?: (interaction?: IssueThreadInteraction) => void;
}

export function replaceResolvedInteraction(
  current: IssueThreadInteraction[] | undefined,
  resolvedInteraction: IssueThreadInteraction,
): IssueThreadInteraction[] {
  const existing = current ?? [];
  const index = existing.findIndex((entry) => entry.id === resolvedInteraction.id);
  if (index < 0) return [...existing, resolvedInteraction];
  return existing.map((entry, entryIndex) =>
    entryIndex === index ? resolvedInteraction : entry,
  );
}

/**
 * Lazily fetches the full issue-thread interaction referenced by an attention
 * row and renders the existing {@link IssueThreadInteractionCard} inline, so
 * confirmations and questions are answerable in-row without leaving the queue
 * (converged PAP-12628). Reviews never reach here — they deep-link.
 *
 * There is no Cancel here: closing a request is the card's Close… menu
 * ("Withdraw request"), which works for every interaction kind (PAP-749 plan
 * §2, Rule 6). The task page keeps its own controls.
 */
export function AttentionInteractionResolver({
  companyId,
  issueId,
  interactionId,
  agentMap,
  currentUserId,
  userLabelMap,
  presentation,
  audienceStated,
  footerSlot,
  artifactRow,
  shareReviseDraft,
  onResolved,
}: AttentionInteractionResolverProps) {
  const queryClient = useQueryClient();
  const confirmAction = useAttentionActionConfirmation();

  const { data: interactions, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    enabled: !!issueId,
    refetchInterval: (query) => interactionReadinessRefetchInterval(query.state.data),
  });

  const interaction = useMemo<IssueThreadInteraction | null>(() => {
    const match = (interactions ?? []).find((entry) => entry.id === interactionId);
    return match && isIssueThreadInteraction(match) ? match : null;
  }, [interactions, interactionId]);

  const invalidate = (resolvedInteraction?: IssueThreadInteraction) => {
    // The accept route returns the fully stitched interaction (including
    // secretProposal.executed/failed). Put that receipt in the cache before
    // invalidating so the attention surface never flashes a generic Accepted
    // state while the refetch catches up.
    if (resolvedInteraction) {
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(issueId),
        (current) => replaceResolvedInteraction(current, resolvedInteraction),
      );
    }
    // Task detail keys the same list by identifier, so refresh every view (UX2).
    invalidateInteractionRecordViews(queryClient, companyId);
    onResolved?.(resolvedInteraction);
  };

  const acceptMutation = useMutation({
    mutationFn: (input: {
      interaction: SuggestTasksInteraction | RequestConfirmationInteraction | RequestCheckboxConfirmationInteraction;
      selectedClientKeys?: string[];
      selectedOptionIds?: string[];
      rememberAction?: boolean;
    }) =>
      issuesApi.acceptInteraction(issueId, input.interaction.id, {
        selectedClientKeys: input.selectedClientKeys,
        selectedOptionIds: input.selectedOptionIds,
        rememberAction: input.rememberAction,
      }),
    onSuccess: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: (input: { interactionId: string; reason?: string }) =>
      issuesApi.rejectInteraction(issueId, input.interactionId, input.reason),
    onSuccess: invalidate,
  });

  const respondMutation = useMutation({
    mutationFn: (input: { interactionId: string; answers: AskUserQuestionsAnswer[] }) =>
      issuesApi.respondToInteraction(issueId, input.interactionId, { answers: input.answers }),
    onSuccess: invalidate,
  });

  const verdictsMutation = useMutation({
    mutationFn: (input: {
      interactionId: string;
      verdicts: { id: string; verdict: RequestItemVerdictValue; reason?: string }[];
    }) => issuesApi.submitInteractionVerdicts(issueId, input.interactionId, input.verdicts),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return (
      <div className="space-y-3 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading decision…
        </div>
        <DecisionCardFooter leading={footerSlot} />
      </div>
    );
  }

  if (error || !interaction) {
    return (
      <div className="space-y-3 py-3">
        <p className="text-xs text-muted-foreground">
          This decision is no longer available — it may have been resolved elsewhere.
        </p>
        <DecisionCardFooter leading={footerSlot} />
      </div>
    );
  }

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      presentationVariant={presentation}
      audienceStated={audienceStated}
      footerSlot={footerSlot}
      artifactRow={artifactRow}
      primaryActionOnRight={presentation === "coordinator-decision"}
      shareReviseDraft={shareReviseDraft}
      agentMap={agentMap}
      currentUserId={currentUserId}
      userLabelMap={userLabelMap}
      onAcceptInteraction={async (target, selectedClientKeys, selectedOptionIds, rememberAction) => {
        await confirmAction();
        await acceptMutation.mutateAsync({ interaction: target, selectedClientKeys, selectedOptionIds, rememberAction });
      }}
      onRejectInteraction={async (target, reason) => {
        await confirmAction();
        await rejectMutation.mutateAsync({ interactionId: target.id, reason });
      }}
      onSubmitInteractionAnswers={async (target: AskUserQuestionsInteraction, answers) => {
        await confirmAction();
        await respondMutation.mutateAsync({ interactionId: target.id, answers });
      }}
      onSubmitInteractionVerdicts={async (target: RequestItemVerdictsInteraction, verdicts) => {
        await confirmAction();
        await verdictsMutation.mutateAsync({ interactionId: target.id, verdicts });
      }}
    />
  );
}
