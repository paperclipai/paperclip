import { useQuery } from "@tanstack/react-query";
import type { Approval, RequestConfirmationInteraction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "./queryKeys";

export function findToolActionBoardApproval(
  approvals: Approval[] | undefined,
  interaction: RequestConfirmationInteraction,
): Approval | undefined {
  const action = interaction.payload.toolAction;
  if (!action) return undefined;
  return approvals?.find((approval) =>
    approval.companyId === interaction.companyId
    && approval.type === "request_board_approval"
    && approval.payload.source === "tool_gateway"
    && approval.payload.actionRequestId === action.actionRequestId,
  );
}

export function useToolActionBoardApproval(
  interaction: RequestConfirmationInteraction,
  pending: boolean,
) {
  const required = pending && interaction.payload.toolAction?.risk === "destructive";
  const query = useQuery({
    queryKey: queryKeys.issues.approvals(interaction.issueId),
    queryFn: () => issuesApi.listApprovals(interaction.issueId),
    enabled: required,
    refetchInterval: required ? 5000 : false,
  });
  const approval = findToolActionBoardApproval(query.data, interaction);
  return {
    required,
    approval,
    blocked: required && (query.isError || approval?.status !== "approved"),
    loading: query.isPending,
    error: query.isError,
    refresh: query.refetch,
  };
}
