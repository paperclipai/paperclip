import { useQuery } from "@tanstack/react-query";
import { aiRoutingModel, DEEPSEEK_MODELS, protocolForDeepSeekHarness, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModels(
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
  const deepseek = routing?.kind === "deepseek" || (!routing && binding?.provider === "deepseek");
  const discover = openRouter && !routing?.models.length;
  // Reuse the existing public catalog and its query cache. It returns OpenCode IDs;
  // strip only that transport prefix for other harnesses (openrouter/auto is
  // itself a valid upstream model ID).
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discover),
    staleTime: 60_000,
    retry: false,
  });
  // DeepSeek's live `/models` needs the stored key, so it is connection-scoped;
  // the shared static list is the fallback (and the pre-save default).
  const deepseekLive = useQuery<Array<{ id: string; label: string }>>({
    queryKey: ["ai-connections", "models", companyId, connection?.id, connection?.grantId],
    queryFn: () => aiConnectionsApi.listModels(companyId!, connection!.id, connection!.grantId),
    enabled: Boolean(companyId && deepseek && connection),
    staleTime: 60_000,
    retry: false,
  });
  const deepseekStatic = deepseek ? DEEPSEEK_MODELS.map((m) => ({ id: m.id, label: m.label })) : undefined;
  const deepseekModels = deepseek
    ? (deepseekLive.data && deepseekLive.data.length > 0 ? deepseekLive.data : deepseekStatic)
    : undefined;
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : deepseek
      ? { kind: "deepseek", protocol: protocolForDeepSeekHarness(harness), auth: "bearer", models: [] }
      : undefined);
  const modelOptions = discover
    ? (catalog.data ?? []).map((m) => ({ ...m, id: harness === "opencode_local" ? m.id : m.id.replace(/^openrouter\//, "") }))
    : deepseek
      ? deepseekModels ?? []
      : routing?.models ?? [];
  return effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: discover ? catalog.isLoading : deepseek ? deepseekLive.isLoading : false,
        error: discover ? catalog.error : deepseek ? deepseekLive.error : null,
        refreshing: discover ? catalog.isFetching : deepseek ? deepseekLive.isFetching : false,
        refreshModels: discover ? async () => { await catalog.refetch(); }
          : deepseek && companyId && connection ? async () => { await deepseekLive.refetch(); }
          : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
}
