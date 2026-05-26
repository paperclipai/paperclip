import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ResourceMembershipResourceType,
  ResourceMembershipState,
  ResourceMemberships,
} from "@paperclipai/shared";
import { resourceMembershipsApi } from "../api/resourceMemberships";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

type MutationVariables = {
  resourceType: ResourceMembershipResourceType;
  resourceId: string;
  resourceName: string;
  state: ResourceMembershipState;
};

function emptyMemberships(): ResourceMemberships {
  return {
    projectMemberships: {},
    agentMemberships: {},
    updatedAt: null,
  };
}

function applyMembershipState(
  current: ResourceMemberships | undefined,
  resourceType: ResourceMembershipResourceType,
  resourceId: string,
  state: ResourceMembershipState,
): ResourceMemberships {
  const base = current ?? emptyMemberships();
  if (resourceType === "project") {
    return {
      ...base,
      projectMemberships: {
        ...base.projectMemberships,
        [resourceId]: state,
      },
      updatedAt: new Date(),
    };
  }
  return {
    ...base,
    agentMemberships: {
      ...base.agentMemberships,
      [resourceId]: state,
    },
    updatedAt: new Date(),
  };
}

export function resourceMembershipState(
  memberships: ResourceMemberships | undefined,
  resourceType: ResourceMembershipResourceType,
  resourceId: string,
): ResourceMembershipState {
  const state = resourceType === "project"
    ? memberships?.projectMemberships[resourceId]
    : memberships?.agentMemberships[resourceId];
  return state === "left" ? "left" : "joined";
}

export function useResourceMemberships(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.resourceMemberships.mine(companyId ?? "__none__"),
    queryFn: () => resourceMembershipsApi.listMine(companyId!),
    enabled: !!companyId,
  });
}

export function useResourceMembershipMutation(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const queryKey = queryKeys.resourceMemberships.mine(companyId ?? "__none__");

  return useMutation({
    mutationFn: (variables: MutationVariables) => {
      if (!companyId) throw new Error("Select a company first.");
      return variables.resourceType === "project"
        ? resourceMembershipsApi.updateProject(companyId, variables.resourceId, { state: variables.state })
        : resourceMembershipsApi.updateAgent(companyId, variables.resourceId, { state: variables.state });
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ResourceMemberships>(queryKey);
      queryClient.setQueryData<ResourceMemberships>(
        queryKey,
        applyMembershipState(previous, variables.resourceType, variables.resourceId, variables.state),
      );
      return { previous };
    },
    onError: (error, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      const verb = variables.state === "left" ? "leave" : "join";
      pushToast({
        title: `Couldn't ${verb} ${variables.resourceName}.`,
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ResourceMemberships>(
        queryKey,
        (current) => applyMembershipState(current, variables.resourceType, result.resourceId, result.state),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}
