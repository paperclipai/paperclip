import { useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccountBoundMutation } from "@/hooks/useAccountBoundMutation";
import { bindAccount } from "@/lib/account-scope";
import type { PrimaryAgentPreference } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { primaryAgentApi } from "@/api/primaryAgent";
import { describeError } from "@/api/errors";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { usePrimaryAgent } from "@/hooks/usePrimaryAgent";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "./CompanyContext";
import { useToastActions } from "./ToastContext";
import { useTranslation } from "@/i18n";

export function PrimaryAgentProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("platform");
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
  const mutation = useAccountBoundMutation({
    mutationFn: (choice: Choice) => primaryAgentApi.set(choice.companyId, { primaryAgentId: choice.agentId }),
    onMutate: async choice => {
      const account = bindAccount(client);
      const key = keyFor(choice);
      await client.cancelQueries({ queryKey: key });
      if (!account.isCurrentAccount()) return;
      const previous = client.getQueryData<PrimaryAgentPreference>(key);
      const optimistic = { companyId: choice.companyId, userId: choice.userId, primaryAgentId: choice.agentId, initialized: true };
      client.setQueryData<PrimaryAgentPreference>(key, optimistic);
      return { previous, optimistic: client.getQueryData(key), optimisticRevision: client.getQueryState(key)?.dataUpdateCount, account };
    },
    onError: (error, choice, context) => {
      if (context) client.setQueryData(keyFor(choice), context.previous);
      if (!isCurrentScope(choice)) return;
      pushToast({ title: t("primaryAgentChangeFailed"), body: describeError(error).body, tone: "error",
        action: { label: t("retry"), onClick: () => { if (isCurrentScope(choice)) mutation.mutate(choice); } } });
    },
    onSuccess: (data, choice) => client.setQueryData(keyFor(choice), data),
    onFinished: (choice, context) => {
      if (context && !context.account.isCurrentScope()
        && client.getQueryData(keyFor(choice)) === context.optimistic
        && client.getQueryState(keyFor(choice))?.dataUpdateCount === context.optimisticRevision) {
        client.setQueryData(keyFor(choice), context.previous);
      }
    },
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
