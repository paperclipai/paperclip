import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryViewKind } from "@/components/QueryView";
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
  const config = enabled && agent.data?.companyId === companyId && queryViewKind(agent) !== "error"
    ? agent.data : undefined;
  const inherits = !!config && config.defaultEnvironmentId == null;
  const instance = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: inherits,
  });
  const environmentId = config?.defaultEnvironmentId
    ?? (inherits && queryViewKind(instance) !== "error" ? instance.data?.defaultEnvironmentId : null);
  const environments = useQuery({
    queryKey: queryKeys.environments.list(companyId ?? "pending"),
    queryFn: () => environmentsApi.list(companyId!),
    enabled: Boolean(environmentId),
  });
  const environment = environmentId && queryViewKind(environments) !== "error"
    ? environments.data?.find(environment => environment.id === environmentId) : undefined;
  const filtered = useMemo(() => slots.filter(slot => !slot.agentEnvironmentDriver
    || (environment?.driver === "plugin" && environment.pluginDriver?.pluginKey === slot.pluginKey
      && environment.pluginDriver?.driverKey === slot.agentEnvironmentDriver)), [slots, environment]);
  return {
    slots: filtered,
    isLoading: enabled && (agent.isPending || (inherits && instance.isPending) || (Boolean(environmentId) && environments.isPending)),
  };
}
