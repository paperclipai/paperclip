import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROMPT_INJECTION_DEFAULT_MODEL, updatePromptInjectionPreventionSchema,
  type PromptInjectionPreventionSettings, type UpdatePromptInjectionPrevention,
  type PromptInjectionTestResult, type AiManagedConnectionSummary } from "@paperclipai/shared";
import { promptInjectionPreventionApi } from "@/api/prompt-injection-prevention";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleField } from "@/components/agent-config-primitives";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";

const editable = (s: PromptInjectionPreventionSettings): UpdatePromptInjectionPrevention => ({
  enabled: s.enabled, connectionId: s.connectionId, grantId: s.grantId, model: s.model,
});
export function PromptInjectionPreventionSettingsView({ settings, choices, models = [], newlyConnectedId, saving, testing, error, result,
  onSave, onTest, onAdd, onConnectionChange, onDraftChange,
}: {
  settings: PromptInjectionPreventionSettings; choices: AiManagedConnectionSummary[];
  models?: Array<{ id: string; label?: string }>; newlyConnectedId?: string | null;
  saving?: boolean; testing?: boolean; error?: string | null; result?: PromptInjectionTestResult | null;
  onSave: (settings: UpdatePromptInjectionPrevention) => void; onTest: () => void; onAdd?: () => void;
  onConnectionChange?: (id: string | null) => void; onDraftChange?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => editable(settings));
  const modelId = useId();
  const revision = JSON.stringify(editable(settings)), draftRevision = JSON.stringify(draft);
  useEffect(() => { setDraft(editable(settings)); onConnectionChange?.(settings.connectionId); }, [revision, settings.companyId]);
  useEffect(() => { onDraftChange?.(); }, [draftRevision, settings.companyId, onDraftChange]);
  const appliedConnection = useRef<string | null>(null);
  useEffect(() => {
    if (!newlyConnectedId) { appliedConnection.current = null; return; }
    if (appliedConnection.current === newlyConnectedId) return;
    const c = choices.find(c => c.id === newlyConnectedId);
    if (!c) return;
    appliedConnection.current = newlyConnectedId;
    setDraft(d => ({ ...d, connectionId: c.id, grantId: c.grantId, model: d.model || PROMPT_INJECTION_DEFAULT_MODEL, enabled: true }));
    onConnectionChange?.(c.id);
  }, [newlyConnectedId, choices, onConnectionChange]);
  const selected = choices.find(c => c.grantId === draft.grantId);
  const dirty = revision !== draftRevision;
  return <section aria-label={t("settings.PromptInjectionPreventionSettingsView.title")} className="max-w-2xl space-y-4">
    <h2 className="text-lg font-semibold">{t("settings.PromptInjectionPreventionSettingsView.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("settings.PromptInjectionPreventionSettingsView.description")}</p>
    <ConnectionChoiceList selectedId={draft.grantId ?? undefined} disabled={saving || testing}
      choices={choices.map(c => ({ id: c.grantId, name: c.name, description: c.status === "connected" ? t("settings.PromptInjectionPreventionSettingsView.connected") : t("settings.PromptInjectionPreventionSettingsView.needsAttention"),
        icon: <AppLogo name="OpenRouter" brandKey="openrouter" size={24} /> }))}
      onSelect={grantId => {
        const c = choices.find(c => c.grantId === grantId)!;
        setDraft(d => ({ ...d, connectionId: c.id, grantId, model: d.model || PROMPT_INJECTION_DEFAULT_MODEL, enabled: true }));
        onConnectionChange?.(c.id);
      }} />
    {!choices.length && <p className="text-sm text-muted-foreground">{t("settings.PromptInjectionPreventionSettingsView.addConnectionHint")}</p>}
    <div className="flex items-center gap-3">
      {onAdd && <Button variant="outline" size="sm" disabled={saving || testing} onClick={onAdd}>{t("settings.PromptInjectionPreventionSettingsView.addConnection")}</Button>}
      <Link to="/apps" className="text-sm underline underline-offset-4">{t("settings.PromptInjectionPreventionSettingsView.manageConnections")}</Link>
    </div>
    {draft.connectionId && <fieldset disabled={saving || testing} className="space-y-4">
      {(!selected || selected.status !== "connected") && <p role="status" className="text-sm text-muted-foreground">{t("settings.PromptInjectionPreventionSettingsView.unavailableConnection")}</p>}
      <div className="space-y-2">
        <label htmlFor={`${modelId}-input`} className="text-sm font-medium">{t("settings.PromptInjectionPreventionSettingsView.model")}</label>
        <Input id={`${modelId}-input`} list={modelId} value={draft.model} placeholder={PROMPT_INJECTION_DEFAULT_MODEL}
          onChange={e => setDraft(d => ({ ...d, model: e.target.value }))} />
        <datalist id={modelId}>{models.map(m => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}</datalist>
      </div>
      <ToggleField label={t("settings.PromptInjectionPreventionSettingsView.useModelToggle")} checked={draft.enabled} onChange={enabled => setDraft(d => ({ ...d, enabled }))} />
      <Button variant="ghost" size="sm" onClick={() => {
        setDraft(d => ({ ...d, connectionId: null, grantId: null, enabled: false })); onConnectionChange?.(null);
      }}>{t("settings.PromptInjectionPreventionSettingsView.clearSelection")}</Button>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dirty && result && <div role={result.passed ? "status" : "alert"} className={result.passed ? "space-y-2 text-sm" : "space-y-2 text-sm text-destructive"}>
      <p>{result.passed ? t("settings.PromptInjectionPreventionSettingsView.bothPassed") : t("settings.PromptInjectionPreventionSettingsView.checksFailed")}</p>
      {result.samples.map(s => <p key={s.name} className="text-xs">{s.name}: {s.passed ? t("settings.PromptInjectionPreventionSettingsView.samplePassed") : s.reason ? t("settings.PromptInjectionPreventionSettingsView.sampleUnavailable", { reason: s.reason }) : t("settings.PromptInjectionPreventionSettingsView.sampleIncorrect")} · {t("settings.PromptInjectionPreventionSettingsView.seconds", { value: (s.durationMs / 1000).toFixed(2) })}</p>)}
    </div>}
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-1">
        <Button variant="outline" size="sm" onClick={onTest} disabled={dirty || !settings.enabled || saving || testing}>{testing ? t("settings.PromptInjectionPreventionSettingsView.testing") : t("settings.PromptInjectionPreventionSettingsView.testModel")}</Button>
        <p className="text-xs text-muted-foreground">{dirty ? t("settings.PromptInjectionPreventionSettingsView.saveFirst") : t("settings.PromptInjectionPreventionSettingsView.testCost")}</p>
      </div>
      {dirty && <Button disabled={saving || testing || !updatePromptInjectionPreventionSchema.safeParse(draft).success || (draft.enabled && selected?.status !== "connected")}
        onClick={() => onSave(draft)}>{saving ? t("settings.PromptInjectionPreventionSettingsView.saving") : t("settings.PromptInjectionPreventionSettingsView.saveSettings")}</Button>}
    </div>
  </section>;
}
export function PromptInjectionPreventionSettingsSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const client = useQueryClient(), key = ["prompt-injection-prevention", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => promptInjectionPreventionApi.settings(companyId) });
  const [adding, setAdding] = useState(false), [newlyConnectedId, setNewlyConnectedId] = useState<string | null>(null), [connectionId, setConnectionId] = useState<string | null>(null);
  const models = useQuery({ queryKey: ["prompt-injection-models", companyId, connectionId],
    queryFn: () => promptInjectionPreventionApi.models(companyId, connectionId!), enabled: Boolean(connectionId) });
  const revision = JSON.stringify(query.data?.settings ?? { companyId });
  const test = useMutation({ mutationFn: (_revision: string) => promptInjectionPreventionApi.test(companyId),
    onSettled: () => { void client.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("cost") }); } });
  const resetTest = test.reset;
  useEffect(() => { resetTest(); }, [revision, companyId, resetTest]);
  useEffect(() => { setAdding(false); setNewlyConnectedId(null); setConnectionId(null); }, [companyId]);
  const save = useMutation({ mutationFn: (data: UpdatePromptInjectionPrevention) => promptInjectionPreventionApi.update(companyId, data),
    onSuccess: settings => { test.reset(); client.setQueryData(key, { ...query.data, settings }); } });
  if (query.isPending) return <p className="text-sm text-muted-foreground">{t("settings.PromptInjectionPreventionSettingsSection.loading")}</p>;
  if (query.error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{t("settings.PromptInjectionPreventionSettingsSection.loadError")}</p><Button variant="outline" onClick={() => void query.refetch()}>{t("settings.PromptInjectionPreventionSettingsSection.tryAgain")}</Button></div>;
  if (!query.data?.canManage || !query.data.settings) return null;
  return <>
    <PromptInjectionPreventionSettingsView key={companyId} settings={query.data.settings} choices={query.data.choices} models={models.data}
      newlyConnectedId={newlyConnectedId} saving={save.isPending} testing={test.isPending}
      error={save.error?.message ?? test.error?.message ?? (models.error ? t("settings.PromptInjectionPreventionSettingsSection.modelSuggestionsError") : null)}
      result={test.variables === revision ? test.data : null} onConnectionChange={setConnectionId} onDraftChange={resetTest}
      onSave={value => save.mutate(value)} onTest={() => test.mutate(revision)} onAdd={() => setAdding(true)} />
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader><DialogTitle>{t("settings.PromptInjectionPreventionSettingsSection.addDialogTitle")}</DialogTitle><DialogDescription>{t("settings.PromptInjectionPreventionSettingsSection.addDialogDescription")}</DialogDescription></DialogHeader>
        <ConnectionSetupFlow host="dialog" serviceSlug="openrouter" forceNewConnection aiConnection={{ provider: "openrouter", method: "api_key", mode: "shared" }} requiredAiOwnership="shared"
          onCancel={() => setAdding(false)} onComplete={async result => {
            const refreshed = await query.refetch();
            if ("connectionId" in result && result.connectionId && refreshed.data?.choices.some(c => c.id === result.connectionId)) setNewlyConnectedId(result.connectionId);
            setAdding(false);
          }} />
      </DialogContent>
    </Dialog>
  </>;
}
