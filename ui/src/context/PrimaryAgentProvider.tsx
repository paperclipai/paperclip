import { useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrimaryAgentPreference } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { primaryAgentApi } from "@/api/primaryAgent";
import { describeError } from "@/api/errors";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { usePrimaryAgent } from "@/hooks/usePrimaryAgent";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "./CompanyContext";
import { useToastActions } from "./ToastContext";

export function PrimaryAgentProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId: companyId } = useCompany();
  const preference = usePrimaryAgent(companyId);
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const scope = useRef({ companyId, userId: preference.userId });
  scope.current = { companyId, userId: preference.userId };
  type Choice = { companyId: string; userId: string; agentId: string };
  const keyFor = (choice: Choice) => queryKeys.primaryAgent.mine(choice.companyId, choice.userId);
  const isCurrentScope = (choice: Choice) => choice.companyId === scope.current.companyId && choice.userId === scope.current.userId;
  const roster = useQuery({ queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const mutation = useMutation({
    mutationFn: (choice: Choice) => primaryAgentApi.set(choice.companyId, { primaryAgentId: choice.agentId }),
    onMutate: async choice => {
      const key = keyFor(choice);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<PrimaryAgentPreference>(key);
      client.setQueryData<PrimaryAgentPreference>(key, { companyId: choice.companyId, userId: choice.userId, primaryAgentId: choice.agentId, initialized: true });
      return { previous };
    },
    onError: (error, choice, context) => {
      client.setQueryData(keyFor(choice), context?.previous);
      if (!isCurrentScope(choice)) return;
      pushToast({ title: "Couldn't change your primary agent.", body: describeError(error).body, tone: "error",
        action: { label: "Retry", onClick: () => { if (isCurrentScope(choice)) mutation.mutate(choice); } } });
    },
    onSuccess: (data, choice) => client.setQueryData(keyFor(choice), data),
    onSettled: (_data, _error, choice) => {
      void client.invalidateQueries({ queryKey: keyFor(choice) });
      void client.invalidateQueries({ queryKey: queryKeys.resourceMemberships.mine(choice.companyId) });
    },
  });
  const primaryAgent = roster.data?.find(agent => agent.id === preference.data?.primaryAgentId && agent.status !== "terminated") ?? null;
  const error = preference.error ?? roster.error;
  return <PrimaryAgentPresentationProvider value={companyId ? {
    companyId, primaryAgentId: primaryAgent?.id ?? null, primaryAgent,
    loading: preference.loading || roster.isPending,
    error: error ? describeError(error).body : undefined,
    onRetry: () => { void preference.retry(); void roster.refetch(); },
    pendingAgentId: mutation.isPending && isCurrentScope(mutation.variables) ? mutation.variables.agentId : null,
    onChange: agentId => mutation.mutate({ companyId, userId: preference.userId, agentId }),
  } : null}>{children}</PrimaryAgentPresentationProvider>;
}
