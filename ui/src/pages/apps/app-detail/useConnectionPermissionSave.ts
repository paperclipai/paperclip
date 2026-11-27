import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolConnection, ToolPolicy, ToolProfileConfiguration } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { withoutUnavailableActions } from "./action-permissions";
import type { AccessDraft } from "./types";

export interface PermissionDraft {
  enabled: Set<string>;
  askFirst: Set<string>;
  access: AccessDraft;
  reviewed?: Set<string>;
}

export function finishAppPermissions(next: PermissionDraft, catalog: ReadonlyArray<Pick<ToolCatalogEntry, "id" | "status" | "quarantineReason">>) {
  const enabled = new Set(withoutUnavailableActions(next.enabled, catalog));
  return {
    enabledCatalogEntryIds: [...enabled],
    askFirstCatalogEntryIds: [...next.askFirst].filter(id => enabled.has(id)),
    ...(next.reviewed ? { reviewedCatalogEntryIds: [...next.reviewed] } : {}),
    access: next.access.mode === "all" ? "all_agents" as const : { agentIds: [...next.access.agentIds] },
  };
}

export function useConnectionPermissionSave({ companyId, connectionId, connection, catalog, onError }: {
  companyId: string | null;
  connectionId: string;
  connection: ToolConnection | undefined;
  catalog: ReadonlyArray<Pick<ToolCatalogEntry, "id" | "status" | "quarantineReason">>;
  onError: (error: Error) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<PermissionDraft | null>(null);
  const mutation = useMutation({
    mutationFn: async (next: PermissionDraft) => connection?.connectionPurpose === "ai"
      ? toolsApi.putConnectionInstalls(connectionId, next.access.mode === "all"
        ? [{ targetType: "company", targetId: companyId! }]
        : [...next.access.agentIds].map(targetId => ({ targetType: "agent" as const, targetId })))
      : toolsApi.finishApp(companyId!, connectionId, finishAppPermissions(next, catalog)),
    onMutate: async (next) => {
      setDraft(next);
      await Promise.all([
        queryKeys.tools.connectionProfileConfiguration(companyId!, connectionId),
        queryKeys.tools.policies(companyId!),
        queryKeys.tools.connection(connectionId),
        queryKeys.tools.connectionInstalls(connectionId),
      ].map(queryKey => client.cancelQueries({ queryKey })));
    },
    onSuccess: (result) => {
      if ("profile" in result) {
        const configuration = { ...result.profile, entries: result.profileEntries, bindings: result.profileBindings };
        client.setQueryData<{ profiles: ToolProfileConfiguration[] }>(
          queryKeys.tools.connectionProfileConfiguration(companyId!, connectionId),
          previous => ({ profiles: [...(previous?.profiles ?? []).filter(profile => profile.profileKey !== result.profile.profileKey), configuration] }),
        );
        client.setQueryData<{ policies: ToolPolicy[] }>(queryKeys.tools.policies(companyId!), previous => ({
          policies: [...(previous?.policies ?? []).filter(policy => !(policy.policyType === "require_approval"
            && policy.config?.source === "app_gallery_finish" && policy.config.connectionId === connectionId)), ...result.policies],
        }));
        client.setQueryData(queryKeys.tools.connection(connectionId), result.connection);
      } else if ("installs" in result) {
        client.setQueryData(queryKeys.tools.connectionInstalls(connectionId), result);
      }
      for (const queryKey of [
        queryKeys.tools.connectionInstalls(connectionId),
        queryKeys.tools.testAgentAccessesForConnection(connectionId),
        queryKeys.tools.connection(connectionId),
        queryKeys.tools.catalog(connectionId),
        queryKeys.tools.profiles(companyId!),
        queryKeys.tools.policies(companyId!),
        queryKeys.tools.connections(companyId!),
        queryKeys.apps.attention(companyId!),
      ]) void client.invalidateQueries({ queryKey });
    },
    onError,
    onSettled: () => setDraft(null),
  });
  return { draft, pending: mutation.isPending, save: mutation.mutate };
}
