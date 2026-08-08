import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
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
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";

interface AttentionInteractionResolverProps {
  companyId: string;
  issueId: string;
  interactionId: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  /** Called after a resolution so the parent can refresh the feed. */
  onResolved?: () => void;
}

/**
 * Lazily fetches the full issue-thread interaction referenced by an attention
 * row and renders the existing {@link IssueThreadInteractionCard} inline, so
 * confirmations and questions are answerable in-row without leaving the queue
 * (converged PAP-12628). Reviews never reach here — they deep-link.
 */
export function AttentionInteractionResolver({
  companyId,
  issueId,
  interactionId,
  agentMap,
  currentUserId,
  userLabelMap,
  onResolved,
}: AttentionInteractionResolverProps) {
  const queryClient = useQueryClient();

  const { data: interactions, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    enabled: !!issueId,
  });

  const interaction = useMemo<IssueThreadInteraction | null>(() => {
    const match = (interactions ?? []).find((entry) => entry.id === interactionId);
    return match && isIssueThreadInteraction(match) ? match : null;
  }, [interactions, interactionId]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    onResolved?.();
  };

  const acceptMutation = useMutation({
    mutationFn: (input: {
      interaction: SuggestTasksInteraction | RequestConfirmationInteraction | RequestCheckboxConfirmationInteraction;
      selectedClientKeys?: string[];
      selectedOptionIds?: string[];
    }) =>
      issuesApi.acceptInteraction(issueId, input.interaction.id, {
        selectedClientKeys: input.selectedClientKeys,
        selectedOptionIds: input.selectedOptionIds,
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

  const cancelMutation = useMutation({
    mutationFn: (input: { interactionId: string }) =>
      issuesApi.cancelInteraction(issueId, input.interactionId),
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
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading decision…
      </div>
    );
  }

  if (error || !interaction) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        This decision is no longer available — it may have been resolved elsewhere.
      </p>
    );
  }

  return (
    <IssueThreadInteractionCard
      interaction={interaction}
      agentMap={agentMap}
      currentUserId={currentUserId}
      userLabelMap={userLabelMap}
      onAcceptInteraction={(target, selectedClientKeys, selectedOptionIds) =>
        acceptMutation.mutateAsync({ interaction: target, selectedClientKeys, selectedOptionIds }).then(() => undefined)
      }
      onRejectInteraction={(target, reason) =>
        rejectMutation.mutateAsync({ interactionId: target.id, reason }).then(() => undefined)
      }
      onSubmitInteractionAnswers={(target: AskUserQuestionsInteraction, answers) =>
        respondMutation.mutateAsync({ interactionId: target.id, answers }).then(() => undefined)
      }
      onCancelInteraction={(target: AskUserQuestionsInteraction) =>
        cancelMutation.mutateAsync({ interactionId: target.id }).then(() => undefined)
      }
      onSubmitInteractionVerdicts={(target: RequestItemVerdictsInteraction, verdicts) =>
        verdictsMutation.mutateAsync({ interactionId: target.id, verdicts }).then(() => undefined)
      }
    />
  );
}
