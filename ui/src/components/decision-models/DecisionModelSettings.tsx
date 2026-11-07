import { t, useTranslation, t as translate } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DECISION_MODELS, type DecisionConnectionChoice, type DecisionModelSettings, type DecisionProvider, type DecisionResult, type UpdateDecisionModel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { decisionModelsApi } from "@/api/decision-models";
import { describeError } from "@/api/errors";
import { QueryErrorState, QueryPlaceholder, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ToggleField } from "@/components/agent-config-primitives";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AppLogo } from "@/pages/apps/AppLogo";

const failureMessages: Record<string, string> = {
  get not_configured() { return translate("connections:choose_and_save_a_connection_first_e08dd68"); }, get disabled() { return translate("connections:enable_and_save_decisions_before_running_a_47dad51"); },
  get connection_unavailable() { return translate("connections:the_connection_is_unavailable_reconnect_it_and_5e5802f"); },
  get access_denied() { return translate("connections:this_connection_is_not_shared_with_you_e5f3314"); },
  get incompatible_connection() { return translate("connections:choose_a_supported_openai_or_openrouter_api_49c3e57"); },
  get budget_blocked() { return translate("connections:the_company_or_task_budget_prevents_this_acff9fb"); },
  get provider_auth_failed() { return translate("connections:the_provider_rejected_the_connection_reconnect_it_76e345a"); },
  get provider_rate_limited() { return translate("connections:the_provider_is_rate_limited_try_again_ebf7d99"); },
  get timeout() { return translate("connections:the_provider_did_not_respond_in_time_e440970"); },
  get refused() { return translate("connections:the_model_declined_the_test_review_the_66ea482"); },
};
export function DecisionModelSettingsView({ settings, choices, saving, testing, error, result, newlyConnectedId, onSave, onTest, onAdd }: {
  settings: DecisionModelSettings; choices: DecisionConnectionChoice[]; saving?: boolean; testing?: boolean;
  error?: string | null; result?: DecisionResult | null; newlyConnectedId?: string | null;
  onSave: (value: UpdateDecisionModel) => void; onTest: () => void; onAdd: () => void;
}) {
  const { t } = useTranslation("connections");
  const [draft, setDraft] = useState<Required<UpdateDecisionModel>>(settings);
  const appliedConnection = useRef<string | null>(null);
  useEffect(() => { setDraft(settings); }, [settings.companyId, settings.connectionId, settings.grantId, settings.enabled, settings.allowBackground]);
  useEffect(() => {
    if (!newlyConnectedId) { appliedConnection.current = null; return; }
    if (appliedConnection.current === newlyConnectedId) return;
    const connection = choices.find(row => row.id === newlyConnectedId);
    if (connection) {
      appliedConnection.current = newlyConnectedId;
      setDraft(value => ({ ...value, connectionId: connection.id, grantId: connection.grantId, enabled: value.connectionId ? value.enabled : true }));
    }
  }, [newlyConnectedId, choices]);
  const selected = choices.find(row => row.grantId === draft.grantId);
  const dirty = draft.enabled !== settings.enabled || draft.allowBackground !== settings.allowBackground || draft.grantId !== settings.grantId;
  const unavailable = result && result.status !== "succeeded" ? failureMessages[result.status === "unavailable" ? result.reason : result.errorCode] ?? t("the_decision_could_not_be_completed_review_b094f87") : null;
  return <section aria-labelledby="decision-model-heading" className="max-w-2xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="decision-model-heading" className="text-lg font-semibold">{t("decision_model_3999c3f")}</h2>
      <Link to="/activity/costs?tab=decisions" className="text-sm underline underline-offset-4">{t("view_usage_972c8f4")}</Link>
    </div>
    <p className="text-sm text-muted-foreground">{t("choose_the_shared_connection_paperclip_uses_for_8131843")}</p>
    <ConnectionChoiceList selectedId={draft.grantId ?? undefined} disabled={saving || testing}
      choices={choices.map(row => ({ id: row.grantId, name: row.name,
        description: `${row.decisionModel} · ${row.status === "connected" ? t("final-components-a:connected_22965568") : t("final-components-a:needsAttention_c1ebc781")}`,
        icon: <AppLogo name={row.provider === "openai" ? "OpenAI" : "OpenRouter"} brandKey={row.provider} size={24} />,
      }))}
      onSelect={grantId => { const row = choices.find(choice => choice.grantId === grantId)!; setDraft(value => ({ ...value, connectionId: row.id, grantId, enabled: value.connectionId ? value.enabled : true })); }} />
    {choices.length === 0 && <p className="text-sm text-muted-foreground">{t("add_a_shared_openai_or_openrouter_api_433ce09")}</p>}
    {draft.connectionId && !selected && <p role="status" className="text-sm text-muted-foreground">{t("the_saved_connection_is_unavailable_to_you_a9eca52")}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={onAdd} disabled={saving || testing}>{t("add_connection_a9c2538")}</Button>
      {selected && <Link to={`/apps/${selected.id}/permissions`} className="text-sm underline underline-offset-4">{selected.status === "connected" ? t("manage_connection_3ca4794") : t("reconnect_connection_4c1ebbb")}</Link>}
    </div>
    {draft.connectionId && <fieldset disabled={saving || testing} className="space-y-4">
      <ToggleField label={t("enable_decisions_65be0c1")} checked={draft.enabled} onChange={enabled => setDraft(value => ({ ...value, enabled }))} />
      <div className="space-y-2">
        <ToggleField label={t("allow_company_sponsored_background_decisions_7f7c158")} checked={draft.allowBackground} onChange={allowBackground => setDraft(value => ({ ...value, allowBackground }))} />
        <p className="text-xs text-muted-foreground">{t("background_features_can_charge_this_connection_without_65d9140")}</p>
      </div>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dirty && unavailable && <p role="alert" className="text-sm text-destructive">{unavailable}</p>}
    {!dirty && result?.status === "succeeded" && <div role="status" className="space-y-2 text-sm">
      <p className="font-medium">{t("decision_model_is_working_c08229a")}</p>
      <dl className="grid grid-cols-2 gap-2">{Object.entries(result.answers).map(([name, answer]) => <div key={name}>
        <dt className="text-muted-foreground">{name === "billing" ? t("billing_problem_c6c2e7e") : name === "team" ? t("assigned_team_9336cda") : t("disruption_score_d7eef2e")}</dt>
        <dd className="font-mono">{answer.type === "boolean" ? `${Math.round(answer.probability * 100)}%` : answer.type === "choice" ? answer.choice : `${answer.score.toFixed(2)} / 2`}</dd>
      </div>)}</dl>
      <p className="text-xs text-muted-foreground">{t("usage_was_recorded_test_answers_are_not_5bfc5af")}</p>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <Button variant="outline" size="sm" disabled={!settings.enabled || dirty || saving || testing || selected?.status !== "connected"} onClick={onTest}>{testing ? t("running_test_e1424c1") : t("run_test_6ecaed9")}</Button>
        <p className="text-xs text-muted-foreground">{dirty ? t("save_changes_before_testing_041f387") : t("runs_a_small_sample_with_an_api_10de050")}</p>
      </div>
      {dirty && <Button onClick={() => onSave(draft)} disabled={saving || testing || (draft.enabled && selected?.status !== "connected")}>{saving ? t("saving_56a2285") : t("save_decision_model_47641f8")}</Button>}
    </div>
  </section>;
}

export function DecisionModelSettingsSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation("connections");
  const client = useQueryClient();
  const key = ["decision-model", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => decisionModelsApi.settings(companyId) });
  const view = useQueryView(query);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<DecisionProvider | null>(null);
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
  if (view.kind === "loading" || view.kind === "reconnecting") return <QueryPlaceholder size="inline" label={t("loading_decision_model_16a1f1d")} />;
  if (view.kind === "error") return <QueryErrorState size="panel" error={query.error} action="load decision settings" onRetry={view.retry} retrying={view.isFetching} />;
  if (!query.data?.canManage || !query.data.settings) return null;
  const testError = test.variables === settingsRevision ? test.error : null;
  return <>
    <DecisionModelSettingsView settings={query.data.settings} choices={query.data.choices} saving={save.isPending} testing={test.isPending}
      error={save.error ? describeError(save.error).body : testError ? describeError(testError).body : undefined}
      result={test.variables === settingsRevision ? test.data : null} newlyConnectedId={newlyConnectedId}
      onSave={value => save.mutate(value)} onTest={() => test.mutate(settingsRevision)} onAdd={() => { setProvider(null); setAdding(true); }} />
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader><DialogTitle>{t("add_a_decision_connection_7c666ac")}</DialogTitle><DialogDescription>{t("use_a_shared_api_connection_for_company_b2c7bf9")}</DialogDescription></DialogHeader>
        {provider ? <ConnectionSetupFlow host="dialog" serviceSlug={provider} forceNewConnection
          aiConnection={{ provider, method: "api_key", mode: "shared" }} requiredAiOwnership="shared"
          onCancel={() => setAdding(false)} onComplete={async result => {
            const refreshed = await query.refetch();
            if ("connectionId" in result && result.connectionId && refreshed.data?.choices.some(row => row.id === result.connectionId)) setNewlyConnectedId(result.connectionId);
            setAdding(false);
          }} /> : <ConnectionChoiceList choices={(Object.keys(DECISION_MODELS) as DecisionProvider[]).map(id => ({ id,
            name: id === "openai" ? "OpenAI" : "OpenRouter", description: DECISION_MODELS[id].name,
            icon: <AppLogo name={id === "openai" ? "OpenAI" : "OpenRouter"} brandKey={id} size={24} />,
          }))} onSelect={id => setProvider(id as DecisionProvider)} />}
      </DialogContent>
    </Dialog>
  </>;
}
