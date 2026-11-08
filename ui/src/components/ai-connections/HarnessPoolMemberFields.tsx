import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiConnectionBinding, HarnessPoolMemberV2 } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { AdapterTypeDropdown, ModelDropdown, ThinkingEffortDropdown, harnessThinkingEffortOptions } from "@/components/HarnessConfigControls";
import { Field } from "@/components/agent-config-primitives";
import { useDisabledAdaptersSync } from "@/adapters/use-disabled-adapters";
import { adapterCuratesModelOrder } from "@/lib/model-utils";
import { queryKeys } from "@/lib/queryKeys";
import { AiConnectionField } from "./AiConnectionField";
import { useConnectionModelsState } from "./useConnectionModels";
import { QueryErrorState, useQueryView } from "@/components/QueryView";

export type HarnessPoolMemberDraft = Omit<HarnessPoolMemberV2, "connection"> & { connection?: AiConnectionBinding };

const harnessAdapters = { claude_code: "claude_local", codex: "codex_local", grok: "grok_local", opencode: "opencode_local" } as const;
const allowedTypes = new Set(Object.values(harnessAdapters));
const emptyModels: { id: string; label: string }[] = [];

export function HarnessPoolMemberFields({ companyId, member, readOnly, onChange }: {
  companyId: string;
  member: HarnessPoolMemberDraft;
  readOnly: boolean;
  onChange: (patch: Partial<HarnessPoolMemberDraft>) => void;
}) {
  const adapter = harnessAdapters[member.harness.type];
  const client = useQueryClient();
  const disabledTypes = useDisabledAdaptersSync();
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const connectionState = useConnectionModelsState(companyId, member.connection, adapter);
  const connectionModels = connectionState.connectionModels;
  const provider = adapter === "opencode_local" ? member.connection?.provider : undefined;
  const catalogKey = [...queryKeys.agents.adapterModels(companyId, adapter, null, provider), member.connection ?? null];
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: () => agentsApi.adapterModels(companyId, adapter, { provider, aiConnection: member.connection }),
    enabled: Boolean(member.connection) && !connectionModels && !connectionState.loading && !connectionState.error,
  });
  const catalogView = useQueryView(catalog);
  const effortOptions = harnessThinkingEffortOptions(adapter, member.model);

  async function refreshModels() {
    setRefreshError(undefined);
    setRefreshing(true);
    try {
      await connectionState.refresh();
      if (connectionModels) await connectionModels.refreshModels?.();
      else {
        const models = await agentsApi.adapterModels(companyId, adapter, { refresh: true, provider, aiConnection: member.connection });
        client.setQueryData(catalogKey, models);
      }
    } catch (error) { setRefreshError(describeError(error).body); }
    finally { setRefreshing(false); }
  }

  return <fieldset disabled={readOnly} className="space-y-3">
    <Field label="Harness">
      <AdapterTypeDropdown value={adapter} disabledTypes={disabledTypes} allowedTypes={allowedTypes}
        onChange={next => {
          const type = (Object.keys(harnessAdapters) as Array<keyof typeof harnessAdapters>).find(type => harnessAdapters[type] === next);
          if (type && next !== adapter) { setRefreshError(undefined); onChange({ harness: { type }, connection: undefined, model: "", effort: undefined }); }
        }} />
    </Field>
    <AiConnectionField key={adapter} companyId={companyId} agentName="this pool member" adapterType={adapter}
      value={member.connection} model={member.model} readOnly={readOnly} explicitAccount
      onChange={binding => {
        if (binding.mode === "router" || binding.mode === "responsible_user") return;
        setRefreshError(undefined);
        const previous = member.connection;
        const sameAccount = previous && previous.mode !== "responsible_user" && previous.connectionId === binding.connectionId && previous.grantId === binding.grantId && previous.method === binding.method;
        onChange({ connection: binding, ...(!sameAccount ? { model: "", effort: undefined } : {}) });
      }} />
    {member.connection && <>
      <ModelDropdown models={connectionModels?.models ?? catalog.data ?? emptyModels} value={member.model}
        open={modelOpen} onOpenChange={setModelOpen}
        onChange={model => onChange({ model: connectionModels?.resolveModel(model) ?? model,
          effort: member.effort && harnessThinkingEffortOptions(adapter, model).some(option => option.id === member.effort) ? member.effort : undefined })}
        allowDefault={false} required groupByProvider={!connectionModels && adapter === "opencode_local"}
        preserveOrder={Boolean(connectionModels) || adapterCuratesModelOrder(adapter)} creatable
        loadingModels={connectionState.loading || (connectionModels?.isLoading ?? (catalog.isLoading || catalogView.kind === "reconnecting"))}
        onRefreshModels={refreshModels} refreshingModels={refreshing || connectionState.refreshing || catalog.isFetching || connectionModels?.refreshing} />
      {refreshError || connectionState.error || connectionModels?.error
        ? <p role="alert" className="text-sm text-destructive">{refreshError ?? describeError(connectionState.error ?? connectionModels?.error).body}</p>
        : !connectionModels && catalogView.kind === "error"
          ? <QueryErrorState size="inline" error={catalog.error} action="load models" onRetry={catalogView.retry} retrying={catalogView.isFetching} />
          : null}
      {(effortOptions.length > 1 || member.effort) && <ThinkingEffortDropdown value={member.effort ?? ""} options={effortOptions}
        onChange={effort => onChange({ effort: effort || undefined })} open={effortOpen} onOpenChange={setEffortOpen} />}
    </>}
  </fieldset>;
}
