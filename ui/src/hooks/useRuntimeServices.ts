import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CreateRuntimeService, RuntimeService, RuntimeServiceAction, RuntimeServicePolicy, RuntimeServiceCompanyPolicy } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { canBoardManageRuntime } from "../lib/recovery-reconcile";

export const serviceKeys = {
  companyPolicy: (companyId: string) => ["runtime-services", companyId, "company-policy"] as const,
  company: (companyId: string) => ["runtime-services", companyId] as const,
  list: (companyId: string, issueId?: string) => ["runtime-services", companyId, "list", issueId ?? null] as const,
  detail: (companyId: string, id: string) => ["runtime-services", companyId, "detail", id] as const,
  logs: (companyId: string, id: string) => ["runtime-services", companyId, "logs", id] as const,
  environment: (companyId: string, id: string) => ["runtime-services", companyId, "environment", id] as const,
  mutation: (companyId: string, id: string) => ["runtime-service-operation", companyId, id] as const,
};

/** A poll that began before an action must not overwrite its accepted revision. */
export function newestService(previous: RuntimeService | undefined, incoming: RuntimeService): RuntimeService {
  if (!previous || previous.id !== incoming.id || previous.companyId !== incoming.companyId) return incoming;
  const state = previous.revision > incoming.revision ? previous : incoming;
  const deletion = previous.dataDeletion && (!incoming.dataDeletion || previous.dataDeletion.updatedAt > incoming.dataDeletion.updatedAt) ? previous.dataDeletion : incoming.dataDeletion;
  const service = deletion ? { ...state, dataDeletion: deletion } : state;
  const company = (previous.companyPolicyRevision ?? -1) > (incoming.companyPolicyRevision ?? -1) ? previous : incoming;
  if (company.companyMaxRunningSeconds === undefined) return service;
  const maximum = company.companyMaxRunningSeconds;
  return { ...service, companyPolicyRevision: company.companyPolicyRevision, companyMaxRunningSeconds: maximum,
    effectivePolicy: { ...service.policy, maxRunningSeconds: maximum === null ? service.policy.maxRunningSeconds : Math.min(service.policy.maxRunningSeconds ?? maximum, maximum) } };
}

export function publishRuntimeService(client: QueryClient, service: RuntimeService) {
  client.setQueryData<RuntimeService>(serviceKeys.detail(service.companyId, service.id), (old) => newestService(old, service));
  client.setQueriesData<RuntimeService[]>({ queryKey: [...serviceKeys.company(service.companyId), "list"] }, (old) => old?.map(
    (item) => item.id === service.id ? newestService(item, service) : item,
  ));
}

export function useRuntimeServiceCompanyPolicy(companyId: string) {
  return useQuery({ queryKey: serviceKeys.companyPolicy(companyId),
    queryFn: ({ signal }) => runtimeServicesApi.companyPolicy(companyId, { signal }),
    refetchInterval: 2_000, refetchIntervalInBackground: false, retry: 1,
    structuralSharing: (old, incoming) => {
      const previous = old as RuntimeServiceCompanyPolicy | undefined;
      const next = incoming as RuntimeServiceCompanyPolicy;
      return previous && previous.revision > next.revision ? previous : next;
    },
  });
}

export function useRuntimeServices(companyId: string | null | undefined, issueId?: string) {
  return useQuery({
    queryKey: serviceKeys.list(companyId ?? "", issueId),
    queryFn: ({ signal }) => runtimeServicesApi.list(companyId!, issueId, { signal }),
    enabled: !!companyId,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    retry: 1,
    structuralSharing: (previous, incoming) => {
      const old = new Map(((previous ?? []) as RuntimeService[]).map((item) => [item.id, item]));
      return (incoming as RuntimeService[]).map((item) => newestService(old.get(item.id), item));
    },
  });
}

export function useRuntimeService(companyId: string | null | undefined, id: string | undefined) {
  return useQuery({
    queryKey: serviceKeys.detail(companyId ?? "", id ?? ""),
    queryFn: ({ signal }) => runtimeServicesApi.get(companyId!, id!, { signal }),
    enabled: !!companyId && !!id,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    retry: 1,
    structuralSharing: (old, incoming) => newestService(old as RuntimeService | undefined, incoming as RuntimeService),
  });
}

export function useCanManageRuntimeServices(companyId: string | null | undefined) {
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!companyId,
    retry: false,
  });
  return canBoardManageRuntime(companyId, access.data);
}

type Operation = { requestId: string; expectedRevision: number } & (
  | { action: RuntimeServiceAction }
  | { policy: Partial<RuntimeServicePolicy>; expectedPolicy?: RuntimeServicePolicy }
  | { env: CreateRuntimeService["env"] }
);

export function useRuntimeServiceOperation(service: RuntimeService) {
  const client = useQueryClient();
  const mutationKey = serviceKeys.mutation(service.companyId, service.id);
  const pending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    mutationFn: (input: Operation) => {
      const options = { signal: AbortSignal.timeout(20_000) };
      return "action" in input
        ? runtimeServicesApi.control(service.companyId, service.id, input, options)
        : "env" in input
          ? runtimeServicesApi.updateEnvironment(service.companyId, service.id, input, options)
          : runtimeServicesApi.updatePolicy(service.companyId, service.id, input, options);
    },
    onSuccess: (updated) => publishRuntimeService(client, updated),
    // Refresh after ambiguous timeouts and 409s, too. Retry never invents a new
    // request identity for an operation the server may already have accepted.
    onSettled: () => { void client.invalidateQueries({ queryKey: serviceKeys.company(service.companyId) }); },
  });
  const send = (input: Operation) => {
    if (!client.isMutating({ mutationKey })) mutation.mutate(input);
  };
  return {
    ...mutation,
    pending,
    run: (input: { action: RuntimeServiceAction } | { policy: Partial<RuntimeServicePolicy>; expectedPolicy?: RuntimeServicePolicy } | { env: CreateRuntimeService["env"] }, expectedRevision = service.revision) => send({ ...input, requestId: crypto.randomUUID(), expectedRevision }),
    retryRequest: () => { if (mutation.variables) send(mutation.variables); },
    ambiguous: mutation.isError && !(mutation.error instanceof ApiError),
  };
}
