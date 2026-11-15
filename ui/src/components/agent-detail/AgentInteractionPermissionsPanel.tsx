import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_INTERACTION_PERMISSION_KEYS, type AgentInteractionPermissionKey } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { AgentPanel } from "./AgentPanels";

const INTERACTION_PERMISSION_COPY: Record<AgentInteractionPermissionKey, { label: string; description: string }> = {
  canAssignTasksToAgents: { label: "Can assign tasks to other agents", description: "Delegate or assign work to another agent." },
  canReceiveAssignmentsFromAgents: { label: "Can receive tasks from other agents", description: "Other agents can assign or delegate work to this agent." },
  canAssignTasksToHumans: { label: "Can assign tasks to people", description: "Assign work to a person in the company." },
  canAskHumans: {
    label: "Can ask people directly",
    description: "Open question, confirmation and checkbox cards for people. When off, this agent asks its manager instead.",
  },
  canMentionAgents: { label: "Can mention other agents", description: "Mention another agent in a comment or task." },
  canReceiveMentionsFromAgents: { label: "Can be mentioned by other agents", description: "Other agents can mention this agent." },
  canCommentOnOtherTasks: { label: "Can comment on other tasks", description: "Comment on tasks that another agent or a person owns." },
  canReceiveCommentsFromAgents: { label: "Can receive comments from other agents", description: "Other agents can comment on this agent's tasks." },
  canEditOtherTasks: { label: "Can edit other tasks", description: "Change tasks that another agent or a person owns." },
  canReceiveTaskEditsFromAgents: { label: "Can have its tasks edited by other agents", description: "Other agents can change this agent's tasks." },
  canConfigureOtherAgents: { label: "Can configure other agents", description: "Change another agent's settings." },
  canReceiveConfigurationChangesFromAgents: { label: "Can be configured by other agents", description: "Other agents can change this agent's settings." },
};

export function agentInteractionPermissionsQueryKey(agentId: string) {
  return ["agents", agentId, "interaction-permissions"] as const;
}

export function AgentInteractionPermissionsPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const queryKey = agentInteractionPermissionsQueryKey(agentId);
  const state = useQuery({ queryKey, queryFn: () => agentsApi.interactionPermissions(agentId) });
  const update = useMutation({
    mutationFn: (patch: Partial<Record<AgentInteractionPermissionKey, boolean | null>>) =>
      agentsApi.updateInteractionPermissions(agentId, patch),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });
  const effective = state.data?.effective;

  return (
    <AgentPanel title="Interaction permissions" aria-label="Interaction permissions">
      <div className="flex flex-col pb-3">
        <p className="px-(--agent-detail-module-inset) py-2 text-xs text-muted-foreground">
          Limits on what this agent can do with other agents and people. Everything is allowed until you turn it off.
        </p>
        {state.isError ? (
          <p role="alert" className="px-(--agent-detail-module-inset) py-2 text-xs text-destructive">
            Could not load interaction permissions.
          </p>
        ) : null}
        {update.isError ? (
          <p role="alert" className="px-(--agent-detail-module-inset) py-2 text-xs text-destructive">
            {update.error instanceof Error ? update.error.message : "Could not save the change."}
          </p>
        ) : null}
        {AGENT_INTERACTION_PERMISSION_KEYS.map((key) => {
          const copy = INTERACTION_PERMISSION_COPY[key];
          const checked = effective ? effective[key] : true;
          return (
            <div key={key} className="flex min-h-11 items-center justify-between gap-4 px-(--agent-detail-module-inset) py-2 text-sm">
              <div className="space-y-1">
                <div>{copy.label}</div>
                <p className="text-xs text-muted-foreground">{copy.description}</p>
              </div>
              <ToggleSwitch
                aria-label={copy.label}
                checked={checked}
                onCheckedChange={() => update.mutate({ [key]: checked ? false : null })}
                disabled={!effective || update.isPending}
              />
            </div>
          );
        })}
      </div>
    </AgentPanel>
  );
}
