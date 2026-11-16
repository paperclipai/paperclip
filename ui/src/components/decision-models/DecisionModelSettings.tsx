import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DECISION_MODELS, type DecisionConnectionChoice, type DecisionModelOption, type DecisionModelSettings, type DecisionResult, type NativeDecisionProvider, type UpdateDecisionModel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { decisionModelsApi } from "@/api/decision-models";
import { describeError } from "@/api/errors";
import { QueryErrorState, QueryPlaceholder, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ToggleField } from "@/components/agent-config-primitives";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AppLogo } from "@/pages/apps/AppLogo";

const failureMessages: Record<string, string> = {
  not_configured: "Choose and save a connection first.", disabled: "Enable and save decisions before running a test.",
  connection_unavailable: "The connection is unavailable. Reconnect it and try again.",
  access_denied: "This connection is not shared with you. Review its permissions.",
  incompatible_connection: "Choose a supported OpenAI, OpenRouter, or gateway API connection and a model.",
  invalid_response: "The model did not return a valid answer. Try another model.",
  budget_blocked: "The company or task budget prevents this request. Review Costs and Budgets.",
  provider_auth_failed: "The provider rejected the connection. Reconnect it and try again.",
  provider_rate_limited: "The provider is rate limited. Try again later.",
  timeout: "The provider did not respond in time. Billing is unresolved; review Costs.",
  refused: "The model declined the test. Review the connection and try again.",
};
const protocolLabels = { decisions: "Decisions API", chat: "Chat Completions gateway", messages: "Messages gateway" } as const;
function providerLabel(row: DecisionConnectionChoice) {
  if (row.decisionProtocol !== "decisions") return "Gateway";
  return row.provider === "openai" ? "OpenAI" : "OpenRouter";
}
export function DecisionModelSettingsView({ settings, choices, saving, testing, error, result, newlyConnectedId, models, modelsLoading, modelsError, onSave, onTest, onAdd, onDraftConnection }: {
  settings: DecisionModelSettings; choices: DecisionConnectionChoice[]; saving?: boolean; testing?: boolean;
  error?: string | null; result?: DecisionResult | null; newlyConnectedId?: string | null;
  models?: DecisionModelOption[]; modelsLoading?: boolean; modelsError?: string | null;
  onSave: (value: UpdateDecisionModel) => void; onTest: () => void; onAdd: () => void; onDraftConnection?: (connectionId: string | null) => void;
}) {
  const [draft, setDraft] = useState<Required<UpdateDecisionModel>>(settings);
  const appliedConnection = useRef<string | null>(null);
  useEffect(() => { setDraft(settings); }, [settings.companyId, settings.connectionId, settings.grantId, settings.enabled, settings.allowBackground, settings.model]);
  useEffect(() => { onDraftConnection?.(draft.connectionId); }, [draft.connectionId, onDraftConnection]);
  useEffect(() => {
    if (!newlyConnectedId) { appliedConnection.current = null; return; }
    if (appliedConnection.current === newlyConnectedId) return;
    const connection = choices.find(row => row.id === newlyConnectedId);
    if (connection) {
      appliedConnection.current = newlyConnectedId;
      setDraft(value => ({ ...value, connectionId: connection.id, grantId: connection.grantId, model: connection.decisionModel, enabled: value.connectionId ? value.enabled : true }));
    }
  }, [newlyConnectedId, choices]);
  const selected = choices.find(row => row.grantId === draft.grantId);
  const model = draft.model?.trim() || null;
  const dirty = draft.enabled !== settings.enabled || draft.allowBackground !== settings.allowBackground || draft.grantId !== settings.grantId || model !== settings.model;
  const missingModel = draft.enabled && !model;
  const unavailable = result && result.status !== "succeeded" ? failureMessages[result.status === "unavailable" ? result.reason : result.errorCode] ?? "The decision could not be completed. Review its entry in Costs." : null;
  return <section aria-labelledby="decision-model-heading" className="max-w-2xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="decision-model-heading" className="text-lg font-semibold">Decision model</h2>
      <Link to="/activity/costs?tab=decisions" className="text-sm underline underline-offset-4">View usage</Link>
    </div>
    <p className="text-sm text-muted-foreground">Choose the shared connection Paperclip uses for optional decision features. API usage is charged to this connection.</p>
    <ConnectionChoiceList selectedId={draft.grantId ?? undefined} disabled={saving || testing}
      choices={choices.map(row => ({ id: row.grantId, name: row.name,
        description: `${row.decisionModel ?? protocolLabels[row.decisionProtocol]} · ${row.status === "connected" ? "Connected" : "Needs attention"}`,
        icon: <AppLogo name={providerLabel(row)} brandKey={row.decisionProtocol === "decisions" ? row.provider : null} size={24} />,
      }))}
      onSelect={grantId => { const row = choices.find(choice => choice.grantId === grantId)!; setDraft(value => ({ ...value, connectionId: row.id, grantId,
        model: row.id === settings.connectionId ? settings.model : row.decisionModel, enabled: value.connectionId ? value.enabled : true })); }} />
    {choices.length === 0 && <p className="text-sm text-muted-foreground">Add a shared OpenAI, OpenRouter, or gateway API connection to get started.</p>}
    {draft.connectionId && !selected && <p role="status" className="text-sm text-muted-foreground">The saved connection is unavailable to you. Disable decisions or choose another connection.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={onAdd} disabled={saving || testing}>Add connection</Button>
      {selected && <Link to={`/apps/${selected.id}/permissions`} className="text-sm underline underline-offset-4">{selected.status === "connected" ? "Manage connection" : "Reconnect connection"}</Link>}
    </div>
    {draft.connectionId && <fieldset disabled={saving || testing} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="decision-model-id" className="text-sm font-medium">Model</label>
        <Input id="decision-model-id" list="decision-model-options" value={draft.model ?? ""} placeholder={selected?.decisionModel ?? "Enter a model ID"}
          autoComplete="off" spellCheck={false} onChange={event => { const next = event.target.value; setDraft(value => ({ ...value, model: next })); }} />
        <datalist id="decision-model-options">{(models ?? []).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</datalist>
        <p className="text-xs text-muted-foreground">{modelsLoading ? "Loading models…" : modelsError ? "Models could not be listed. Enter a model ID."
          : models?.length ? `${models.length} models available. Pick one or enter a model ID.` : "Enter a model ID offered by this connection."}</p>
        {missingModel && <p role="alert" className="text-xs text-destructive">Select a model before enabling decisions.</p>}
      </div>
      <ToggleField label="Enable decisions" checked={draft.enabled} onChange={enabled => setDraft(value => ({ ...value, enabled }))} />
      <div className="space-y-2">
        <ToggleField label="Allow company-sponsored background decisions" checked={draft.allowBackground} onChange={allowBackground => setDraft(value => ({ ...value, allowBackground }))} />
        <p className="text-xs text-muted-foreground">Background features can charge this connection without a responsible person. These requests appear as Paperclip services.</p>
      </div>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dirty && unavailable && <p role="alert" className="text-sm text-destructive">{unavailable}</p>}
    {!dirty && result?.status === "succeeded" && <div role="status" className="space-y-2 text-sm">
      <p className="font-medium">Decision model is working</p>
      <dl className="grid grid-cols-2 gap-2">{Object.entries(result.answers).map(([name, answer]) => <div key={name}>
        <dt className="text-muted-foreground">{name === "billing" ? "Billing problem" : name === "team" ? "Assigned team" : "Disruption score"}</dt>
        <dd className="font-mono">{answer.type === "boolean" ? `${Math.round(answer.probability * 100)}%` : answer.type === "choice" ? answer.choice : `${answer.score.toFixed(2)} / 2`}</dd>
      </div>)}</dl>
      <p className="text-xs text-muted-foreground">Usage was recorded. Test answers are not saved.</p>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <Button variant="outline" size="sm" disabled={!settings.enabled || dirty || saving || testing || selected?.status !== "connected"} onClick={onTest}>{testing ? "Running test…" : "Run test"}</Button>
        <p className="text-xs text-muted-foreground">{dirty ? "Save changes before testing." : "Runs a small sample with an API charge."}</p>
      </div>
      {dirty && <Button onClick={() => onSave({ ...draft, model })} disabled={saving || testing || missingModel || (draft.enabled && selected?.status !== "connected")}>{saving ? "Saving…" : "Save decision model"}</Button>}
    </div>
  </section>;
}

export function DecisionModelSettingsSection({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const key = ["decision-model", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => decisionModelsApi.settings(companyId) });
  const view = useQueryView(query);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<NativeDecisionProvider | null>(null);
  const [modelConnectionId, setModelConnectionId] = useState<string | null>(null);
  const modelList = useQuery({ queryKey: ["decision-model-models", companyId, modelConnectionId], enabled: Boolean(modelConnectionId && query.data?.canManage),
    queryFn: () => decisionModelsApi.models(companyId, modelConnectionId!), staleTime: 5 * 60_000, retry: false });
  const [newlyConnectedId, setNewlyConnectedId] = useState<string | null>(null);
  const settingsRevision = JSON.stringify(query.data?.settings ?? { companyId });
  const test = useMutation({ mutationFn: (_revision: string) => decisionModelsApi.test(companyId), onSettled: () => { void client.invalidateQueries({ queryKey: ["decision-history", companyId] }); void client.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("cost") }); } });
  const resetTest = test.reset;
  useEffect(() => { resetTest(); }, [settingsRevision, resetTest]);
  const save = useMutation({ mutationFn: (settings: UpdateDecisionModel) => decisionModelsApi.update(companyId, settings), onSuccess: settings => {
    setNewlyConnectedId(null); test.reset(); client.setQueryData(key, { ...query.data, settings });
  } });
  // Loaded settings stay on screen through an outage (`stale`); only a real
  // failure with nothing cached shows the error.
  if (view.kind === "loading" || view.kind === "reconnecting") return <QueryPlaceholder size="inline" label="Loading decision model" />;
  if (view.kind === "error") return <QueryErrorState size="panel" error={query.error} action="load decision settings" onRetry={view.retry} retrying={view.isFetching} />;
  if (!query.data?.canManage || !query.data.settings) return null;
  const testError = test.variables === settingsRevision ? test.error : null;
  return <>
    <DecisionModelSettingsView settings={query.data.settings} choices={query.data.choices} saving={save.isPending} testing={test.isPending}
      error={save.error ? describeError(save.error).body : testError ? describeError(testError).body : undefined}
      result={test.variables === settingsRevision ? test.data : null} newlyConnectedId={newlyConnectedId}
      models={modelList.data?.models} modelsLoading={modelList.isFetching} modelsError={modelList.error ? "failed" : modelList.data?.errorCode ?? null}
      onDraftConnection={setModelConnectionId}
      onSave={value => save.mutate(value)} onTest={() => test.mutate(settingsRevision)} onAdd={() => { setProvider(null); setAdding(true); }} />
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader><DialogTitle>Add a decision connection</DialogTitle><DialogDescription>Use a shared API connection for company decisions.</DialogDescription></DialogHeader>
        {provider ? <ConnectionSetupFlow host="dialog" serviceSlug={provider} forceNewConnection
          aiConnection={{ provider, method: "api_key", mode: "shared" }} requiredAiOwnership="shared"
          onCancel={() => setAdding(false)} onComplete={async result => {
            const refreshed = await query.refetch();
            if ("connectionId" in result && result.connectionId && refreshed.data?.choices.some(row => row.id === result.connectionId)) setNewlyConnectedId(result.connectionId);
            setAdding(false);
          }} /> : <ConnectionChoiceList choices={(Object.keys(DECISION_MODELS) as NativeDecisionProvider[]).map(id => ({ id,
            name: id === "openai" ? "OpenAI" : "OpenRouter", description: DECISION_MODELS[id].name,
            icon: <AppLogo name={id === "openai" ? "OpenAI" : "OpenRouter"} brandKey={id} size={24} />,
          }))} onSelect={id => setProvider(id as NativeDecisionProvider)} />}
      </DialogContent>
    </Dialog>
  </>;
}
