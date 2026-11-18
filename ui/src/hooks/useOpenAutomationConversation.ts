import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AutomationConversationRef } from "@paperclipai/shared";
import { automationConversationsApi } from "@/api/automation-conversations";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { issueUrl } from "@/lib/utils";

/**
 * The one primary action on a manual task (experimental `enableResponsibilities`):
 * open the conversation with the responsible agent about automating it and go
 * there. An open conversation is one tap away; otherwise the server opens one
 * (or returns the one already open) and wakes the agent.
 */
export function useOpenAutomationConversation() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: (input: { issueId: string; agentId?: string | null; responsibilityId?: string }) =>
      automationConversationsApi.start(input.issueId, {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.responsibilityId ? { responsibilityId: input.responsibilityId } : {}),
      }),
    onSuccess: async (state) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
      if (state.conversation) navigate(issueUrl({ id: state.conversation.issueId, identifier: state.conversation.identifier }));
    },
  });
  const open = (input: { issueId: string; agentId?: string | null; responsibilityId?: string; conversation?: AutomationConversationRef | null }) => {
    if (input.conversation) {
      navigate(issueUrl({ id: input.conversation.issueId, identifier: input.conversation.identifier }));
      return;
    }
    start.mutate(input);
  };
  return { open, isPending: start.isPending, error: start.error };
}
