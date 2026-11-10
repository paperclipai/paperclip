import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import type { ResolvedPluginSlot } from "./slots";

/** Environment requirements affect navigation, including manual task panels. */
export function useAgentEnvironmentSlots(slots: ResolvedPluginSlot[], agentId: string | null | undefined, companyId: string | null | undefined) {
  const required = slots.some(slot => slot.agentEnvironmentDriver);
  const enabled = required && Boolean(agentId && companyId);
  const agent = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId ?? "pending"), companyId ?? null],
    queryFn: () => agentsApi.get(agentId!, companyId!),
    enabled,
  });
  const inherits = enabled && !!agent.data && !agent.data.defaultEnvironmentId;
  const instance = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: inherits,
  });
  const environmentId = agent.data?.defaultEnvironmentId ?? (inherits ? instance.data?.defaultEnvironmentId : null);
  const environments = useQuery({
    queryKey: queryKeys.environments.list(companyId ?? "pending"),
    queryFn: () => environmentsApi.list(companyId!),
    enabled: enabled && Boolean(environmentId),
  });
  const environment = enabled && !agent.isError && agent.data?.companyId === companyId
    && (!inherits || !instance.isError) && !environments.isError
    ? environments.data?.find(environment => environment.id === environmentId) : undefined;
  const filtered = useMemo(() => slots.filter(slot => !slot.agentEnvironmentDriver
    || (environment?.driver === "plugin" && environment.config.pluginKey === slot.pluginKey
      && environment.config.driverKey === slot.agentEnvironmentDriver)), [slots, environment]);
  return {
    slots: filtered,
    isLoading: enabled && (agent.isPending || (inherits && instance.isPending) || (Boolean(environmentId) && environments.isPending)),
  };
}
