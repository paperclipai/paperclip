import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrimaryAgentPreference } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { primaryAgentApi } from "@/api/primaryAgent";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { usePrimaryAgent } from "@/hooks/usePrimaryAgent";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "./CompanyContext";
import { useToastActions } from "./ToastContext";

export function PrimaryAgentProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId: companyId } = useCompany();
  const preference = usePrimaryAgent(companyId);
  return <CompanyPrimaryAgentProvider key={`${companyId}:${preference.userId}`} companyId={companyId} preference={preference}>
    {children}
  </CompanyPrimaryAgentProvider>;
}

function CompanyPrimaryAgentProvider({ children, companyId, preference }: {
  children: ReactNode; companyId: string | null; preference: ReturnType<typeof usePrimaryAgent>;
}) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const key = queryKeys.primaryAgent.mine(companyId ?? "__none__", preference.userId);
  const roster = useQuery({ queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const mutation = useMutation({
    mutationFn: (agentId: string) => primaryAgentApi.set(companyId!, { primaryAgentId: agentId }),
    onMutate: async agentId => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<PrimaryAgentPreference>(key);
      client.setQueryData<PrimaryAgentPreference>(key, { companyId: companyId!, userId: preference.userId, primaryAgentId: agentId, initialized: true });
      return { previous };
    },
    onError: (error, agentId, context) => {
      client.setQueryData(key, context?.previous);
      pushToast({ title: "Couldn't change your primary agent.", body: error.message, tone: "error",
        action: { label: "Retry", onClick: () => mutation.mutate(agentId) } });
    },
    onSuccess: data => client.setQueryData(key, data),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: queryKeys.resourceMemberships.mine(companyId!) });
    },
  });
  const primaryAgent = roster.data?.find(agent => agent.id === preference.data?.primaryAgentId && agent.status !== "terminated") ?? null;
  const error = preference.error ?? roster.error;
  return <PrimaryAgentPresentationProvider value={companyId ? {
    companyId, primaryAgentId: primaryAgent?.id ?? null, primaryAgent,
    loading: preference.loading || roster.isPending,
    error: error?.message,
    onRetry: () => { void preference.retry(); void roster.refetch(); },
    pendingAgentId: mutation.isPending ? mutation.variables : null,
    onChange: agentId => mutation.mutate(agentId),
  } : null}>{children}</PrimaryAgentPresentationProvider>;
}
