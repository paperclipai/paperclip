import { useQuery } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";

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
      ? c.provider === binding.provider && c.isDefault
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  return routing
    ? {
        models: routing.models.map((m) => ({
          id: aiRoutingModel(routing, harness, m.id),
          label: m.label ?? m.id,
        })),
        resolveModel: (model: string) =>
          aiRoutingModel(routing, harness, model),
      }
    : undefined;
}
