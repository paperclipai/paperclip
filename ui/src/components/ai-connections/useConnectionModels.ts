import { useMutation, useQuery } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModelsState(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
) {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && binding),
  });
  const connection = accounts.data?.connections.find((c) =>
    binding?.mode === "responsible_user"
      ? c.provider === binding.provider && c.isDefault && c.ownerUserId === accounts.data?.currentUserId && c.ownership === "personal"
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  const openRouter = routing?.kind === "openrouter" || (!routing && binding?.provider === "openrouter");
  const discover = openRouter && !routing?.models.length;
  // Reuse the existing public catalog and its query cache. It returns OpenCode IDs;
  // strip only that transport prefix for other harnesses (openrouter/auto is
  // itself a valid upstream model ID).
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discover),
    staleTime: 60_000,
  });
  // Local and gateway connections have no public catalog: the model picker's
  // refresh lists their endpoint directly, with the stored credential resolved
  // server-side. All probe state (data, error, pending) is tagged with the
  // connection it targeted, so switching connections never shows another
  // endpoint's results, errors, or progress.
  const endpointRoute = routing?.kind === "local" || routing?.kind === "gateway";
  const endpointProbe = useMutation({
    mutationFn: (target: { companyId: string; connectionId: string; grantId: string }) =>
      aiConnectionsApi.probeRoutingModels(target.companyId, {
        connectionId: target.connectionId,
        grantId: target.grantId,
      }).then((result) => ({ connectionId: target.connectionId, models: result.models })),
  });
  const probeForCurrent = endpointProbe.variables?.connectionId === connection?.id
    ? endpointProbe
    : undefined;
  // undefined = no successful probe for this connection yet; an empty array is a
  // successful reply and must override any stale saved list.
  const probedModels =
    probeForCurrent?.data && probeForCurrent.data.connectionId === connection?.id
      ? probeForCurrent.data.models
      : undefined;
  const catalogView = useQueryView(catalog);
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : undefined);
  const modelOptions = discover
    ? (catalog.data ?? []).map((m) => ({ ...m, id: ["opencode_local", "pi_local"].includes(harness) ? m.id : m.id.replace(/^openrouter\//, "") }))
    : endpointRoute && probedModels !== undefined
      ? probedModels
      : routing?.models ?? [];
  const connectionModels = effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: discover && (catalog.isLoading || catalogView.kind === "reconnecting"),
        error: discover && catalogView.kind === "error" ? catalog.error : endpointRoute ? probeForCurrent?.error ?? null : null,
        refreshing: (discover && catalog.isFetching) || (probeForCurrent?.isPending ?? false),
        refreshModels: discover
          ? async () => { await catalog.refetch(); }
          : endpointRoute
            ? async () => {
                await endpointProbe.mutateAsync({
                  companyId: companyId!,
                  connectionId: connection!.id,
                  grantId: connection!.grantId,
                }).catch(() => {});
              }
            : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
  return {
    connectionModels,
    loading: accounts.isLoading,
    refreshing: accounts.isFetching,
    error: accounts.error,
    refresh: async () => { await accounts.refetch(); },
  };
}

export function useConnectionModels(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
) {
  return useConnectionModelsState(companyId, binding, harness).connectionModels;
}
