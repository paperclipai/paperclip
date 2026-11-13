import { useEffect, useMemo, useRef } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiConnectionList, AiManagedConnectionSummary, AiProvider, ToolConnection } from "@paperclipai/shared";
import { aiConnectionRouterPluginKey } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";
import { useOptionalToastActions } from "@/context/ToastContext";
import { retryTransientOnly } from "@/lib/query-client";
import { AI_PROVIDERS } from "./model";

export function isOwnAiAccount(account: Pick<AiManagedConnectionSummary, "ownership" | "ownerUserId" | "routing">, userId: string) {
  return account.ownership === "personal" && account.ownerUserId === userId && !account.routing;
}

export function indexAiAccounts(accounts: AiManagedConnectionSummary[], userId: string) {
  const groups = new Map<string, AiManagedConnectionSummary[]>();
  for (const account of accounts) {
    if (!isOwnAiAccount(account, userId)) continue;
    const key = JSON.stringify([account.companyId, account.id]);
    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  }
  return new Map([...groups].map(([key, candidates]) => [key,
    candidates.length === 1 ? candidates[0] : candidates.find(account => account.isDefault),
  ]));
}

type DefaultTarget = { account: AiManagedConnectionSummary; retry: boolean; scope: string };

export function useAiConnectionDefaults(companyId: string | null, identity: { userId: string | null; settled: boolean }, enabled = true) {
  const client = useQueryClient();
  const toast = useOptionalToastActions();
  const scope = JSON.stringify([companyId, identity.userId, identity.settled]);
  const activeScope = useRef<string | null>(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => { activeScope.current = null; };
  }, [scope]);
  const listKey = ["ai-connections", companyId, undefined, identity.userId];
  const accounts = useQuery({
    queryKey: listKey,
    queryFn: async ({ signal }) => {
      const result = await aiConnectionsApi.list(companyId!, undefined, { signal, fresh: true });
      if (identity.userId && result.currentUserId !== identity.userId) throw new Error("Your account changed. Refresh your connections.");
      return result;
    },
    enabled: Boolean(companyId) && identity.settled && enabled,
    retry: retryTransientOnly(1),
    refetchOnWindowFocus: "always",
  });
  const mutationKey = ["ai-default", companyId, identity.userId];
  const pendingProviders = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: mutation => (mutation.state.variables as DefaultTarget).account.provider,
  });
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (target: DefaultTarget) => {
      const snapshot = target.retry ? (await accounts.refetch({ throwOnError: true })).data : accounts.data;
      const account = snapshot?.connections.find(candidate => candidate.id === target.account.id && candidate.grantId === target.account.grantId);
      if (activeScope.current !== target.scope || !identity.settled || !snapshot || !account ||
          account.companyId !== companyId || !isOwnAiAccount(account, snapshot.currentUserId) ||
          !account.canSetDefault || account.status !== "connected" || account.unavailableReason) {
        throw new Error("This account is unavailable as your default. Refresh or reconnect it, then try again.");
      }
      if (!account.isDefault) await aiConnectionsApi.setDefault(account.companyId, account.grantId);
    },
    onSuccess: async (_result, target) => {
      await client.invalidateQueries({ queryKey: ["ai-connections", target.account.companyId] });
      if (activeScope.current !== target.scope) return;
      const saved = client.getQueryData<AiConnectionList>(listKey)?.connections.find(account => account.grantId === target.account.grantId);
      toast?.pushToast(saved?.isDefault
        ? { tone: "success", title: `${target.account.name} is now your ${AI_PROVIDERS[target.account.provider].name} default` }
        : { tone: "info", title: `Your ${AI_PROVIDERS[target.account.provider].name} default was updated`, body: "The latest saved selection is shown in Connectors." });
    },
    onError: (error, target) => {
      if (activeScope.current !== target.scope) return;
      toast?.pushToast({ tone: "error", title: `Couldn’t change your ${AI_PROVIDERS[target.account.provider].name} default`,
        body: describeError(error).body, action: { label: "Retry", onClick: () => choose(target.account, true, target.scope) } });
    },
  });
  function choose(account: AiManagedConnectionSummary, retry = false, targetScope = scope) {
    if (activeScope.current !== targetScope || !identity.settled || !companyId) return;
    if (client.getMutationCache().findAll({ mutationKey, status: "pending" }).some(
      entry => (entry.state.variables as DefaultTarget).account.provider === account.provider,
    )) return;
    mutation.mutate({ account, retry, scope: targetScope });
  }
  const data = identity.settled && (!identity.userId || accounts.data?.currentUserId === identity.userId) ? accounts.data : undefined;
  const indexedAccounts = useMemo(() => data ? indexAiAccounts(data.connections, data.currentUserId) : undefined, [data]);
  return {
    accounts,
    data,
    accountForConnection: (connection: ToolConnection) => connection.connectionPurpose === "ai" && !aiConnectionRouterPluginKey(connection)
      ? indexedAccounts?.get(JSON.stringify([connection.companyId, connection.id])) : undefined,
    choose,
    pending: (provider: AiProvider) => pendingProviders.includes(provider),
    error: mutation.variables?.scope === scope ? mutation.error : null,
    failedProvider: mutation.variables?.account.provider,
    retry: () => { if (mutation.variables) choose(mutation.variables.account, true, mutation.variables.scope); },
  };
}
