import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { IssueThreadInteractionCard } from "../../components/IssueThreadInteractionCard";
import { queryKeys } from "../../lib/queryKeys";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../../lib/issue-thread-interactions";

type ActionableIssueThreadInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

interface BoardChatHitlCardsProps {
  boardIssueId: string;
  agentMap: Map<string, Agent>;
  onUploadImage?: (file: File) => Promise<string>;
}

function isPendingInteraction(interaction: IssueThreadInteraction): boolean {
  return interaction.status === "pending";
}

/**
 * Pending HITL cards for the Board Operations issue — same card + APIs as
 * IssueChatThread, rendered inline near the bottom of the Conference Room.
 */
export function BoardChatHitlCards({
  boardIssueId,
  agentMap,
  onUploadImage,
}: BoardChatHitlCardsProps) {
  const queryClient = useQueryClient();

  const { data: interactions = [] } = useQuery({
    queryKey: queryKeys.issues.interactions(boardIssueId),
    queryFn: () => issuesApi.listInteractions(boardIssueId),
    enabled: Boolean(boardIssueId),
  });

  const pendingInteractions = useMemo(
    () =>
      interactions
        .filter(isPendingInteraction)
        .slice()
        .sort((left, right) => {
          const createdAtDelta =
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          return createdAtDelta === 0
            ? left.id.localeCompare(right.id)
            : createdAtDelta;
        }),
    [interactions],
  );

  const invalidateAfterMutation = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.interactions(boardIssueId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(boardIssueId),
      }),
    ]);
  }, [boardIssueId, queryClient]);

  const upsertInteractionInCache = useCallback(
    (interaction: IssueThreadInteraction) => {
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(boardIssueId),
        (current) => {
          const existing = current ?? [];
          const next = existing.filter((entry) => entry.id !== interaction.id);
          next.push(interaction);
          next.sort((left, right) => {
            const createdAtDelta =
              new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
            return createdAtDelta === 0
              ? left.id.localeCompare(right.id)
              : createdAtDelta;
          });
          return next;
        },
      );
    },
    [boardIssueId, queryClient],
  );

  const acceptInteraction = useMutation({
    mutationFn: ({
      interaction,
      selectedClientKeys,
      selectedOptionIds,
    }: {
      interaction: ActionableIssueThreadInteraction;
      selectedClientKeys?: string[];
      selectedOptionIds?: string[];
    }) =>
      issuesApi.acceptInteraction(boardIssueId, interaction.id, {
        selectedClientKeys,
        selectedOptionIds,
      }),
    onSuccess: async (interaction) => {
      upsertInteractionInCache(interaction);
      await invalidateAfterMutation();
    },
  });

  const rejectInteraction = useMutation({
    mutationFn: ({
      interaction,
      reason,
    }: {
      interaction: ActionableIssueThreadInteraction;
      reason?: string;
    }) => issuesApi.rejectInteraction(boardIssueId, interaction.id, reason),
    onSuccess: async (interaction) => {
      upsertInteractionInCache(interaction);
      await invalidateAfterMutation();
    },
  });

  const answerInteraction = useMutation({
    mutationFn: ({
      interaction,
      answers,
    }: {
      interaction: AskUserQuestionsInteraction;
      answers: AskUserQuestionsAnswer[];
    }) =>
      issuesApi.respondToInteraction(boardIssueId, interaction.id, { answers }),
    onSuccess: async (interaction) => {
      upsertInteractionInCache(interaction);
      await invalidateAfterMutation();
    },
  });

  const cancelInteraction = useMutation({
    mutationFn: ({ interaction }: { interaction: AskUserQuestionsInteraction }) =>
      issuesApi.cancelInteraction(boardIssueId, interaction.id),
    onSuccess: async (interaction) => {
      upsertInteractionInCache(interaction);
      await invalidateAfterMutation();
    },
  });

  const handleAcceptInteraction = useCallback(
    async (
      interaction: ActionableIssueThreadInteraction,
      selectedClientKeys?: string[],
      selectedOptionIds?: string[],
    ) => {
      await acceptInteraction.mutateAsync({
        interaction,
        selectedClientKeys,
        selectedOptionIds,
      });
    },
    [acceptInteraction],
  );

  const handleRejectInteraction = useCallback(
    async (interaction: ActionableIssueThreadInteraction, reason?: string) => {
      await rejectInteraction.mutateAsync({ interaction, reason });
    },
    [rejectInteraction],
  );

  const handleSubmitInteractionAnswers = useCallback(
    async (interaction: AskUserQuestionsInteraction, answers: AskUserQuestionsAnswer[]) => {
      await answerInteraction.mutateAsync({ interaction, answers });
    },
    [answerInteraction],
  );

  const handleCancelInteraction = useCallback(
    async (interaction: AskUserQuestionsInteraction) => {
      await cancelInteraction.mutateAsync({ interaction });
    },
    [cancelInteraction],
  );

  if (pendingInteractions.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="board-chat-hitl-cards"
      aria-label="Ações pendentes na sala"
    >
      {pendingInteractions.map((interaction) => (
        <IssueThreadInteractionCard
          key={interaction.id}
          interaction={interaction}
          agentMap={agentMap}
          onAcceptInteraction={handleAcceptInteraction}
          onRejectInteraction={handleRejectInteraction}
          onSubmitInteractionAnswers={handleSubmitInteractionAnswers}
          onCancelInteraction={handleCancelInteraction}
          onUploadImage={onUploadImage}
        />
      ))}
    </div>
  );
}
