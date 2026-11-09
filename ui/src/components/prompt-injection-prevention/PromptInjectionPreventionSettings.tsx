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
  return <section aria-label="Prompt Injection Prevention" className="max-w-2xl space-y-4">
    <h2 className="text-lg font-semibold">Prompt Injection Prevention</h2>
    <p className="text-sm text-muted-foreground">Check tool results for instructions that could redirect your agents. The selected provider receives tool content and charges API usage. Built-in detection is used when the model is unavailable.</p>
    <ConnectionChoiceList selectedId={draft.grantId ?? undefined} disabled={saving || testing}
      choices={choices.map(c => ({ id: c.grantId, name: c.name, description: c.status === "connected" ? "Connected" : "Needs attention",
        icon: <AppLogo name="OpenRouter" brandKey="openrouter" size={24} /> }))}
      onSelect={grantId => {
        const c = choices.find(c => c.grantId === grantId)!;
        setDraft(d => ({ ...d, connectionId: c.id, grantId, model: d.model || PROMPT_INJECTION_DEFAULT_MODEL, enabled: true }));
        onConnectionChange?.(c.id);
      }} />
    {!choices.length && <p className="text-sm text-muted-foreground">Add a shared OpenRouter API connection to use model checks.</p>}
    <div className="flex items-center gap-3">
      {onAdd && <Button variant="outline" size="sm" disabled={saving || testing} onClick={onAdd}>Add OpenRouter connection</Button>}
      <Link to="/apps" className="text-sm underline underline-offset-4">Manage connections</Link>
    </div>
    {draft.connectionId && <fieldset disabled={saving || testing} className="space-y-4">
      {(!selected || selected.status !== "connected") && <p role="status" className="text-sm text-muted-foreground">The saved connection is unavailable. Choose a replacement, disable model checks, or clear the selection. Built-in detection stays active.</p>}
      <div className="space-y-2">
        <label htmlFor={`${modelId}-input`} className="text-sm font-medium">Model</label>
        <Input id={`${modelId}-input`} list={modelId} value={draft.model} placeholder={PROMPT_INJECTION_DEFAULT_MODEL}
          onChange={e => setDraft(d => ({ ...d, model: e.target.value }))} />
        <datalist id={modelId}>{models.map(m => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}</datalist>
      </div>
      <ToggleField label="Use model for prompt injection checks" checked={draft.enabled} onChange={enabled => setDraft(d => ({ ...d, enabled }))} />
      <Button variant="ghost" size="sm" onClick={() => {
        setDraft(d => ({ ...d, connectionId: null, grantId: null, enabled: false })); onConnectionChange?.(null);
      }}>Clear selection</Button>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dirty && result && <div role={result.passed ? "status" : "alert"} className={result.passed ? "space-y-2 text-sm" : "space-y-2 text-sm text-destructive"}>
      <p>{result.passed ? "Both model checks passed." : "Model checks did not pass. Check the connection and model, then try again."}</p>
      {result.samples.map(s => <p key={s.name} className="text-xs">{s.name}: {s.passed ? "Passed" : s.reason ? `Model unavailable (${s.reason}); built-in detection is the fallback.` : "Incorrect verdict"} · {(s.durationMs / 1000).toFixed(2)} seconds</p>)}
    </div>}
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-1">
        <Button variant="outline" size="sm" onClick={onTest} disabled={dirty || !settings.enabled || saving || testing}>{testing ? "Testing…" : "Test model checks"}</Button>
        <p className="text-xs text-muted-foreground">{dirty ? "Save changes before testing." : "Tests two fixed samples with an API charge."}</p>
      </div>
      {dirty && <Button disabled={saving || testing || !updatePromptInjectionPreventionSchema.safeParse(draft).success || (draft.enabled && selected?.status !== "connected")}
        onClick={() => onSave(draft)}>{saving ? "Saving…" : "Save prompt injection settings"}</Button>}
    </div>
  </section>;
}
export function PromptInjectionPreventionSettingsSection({ companyId }: { companyId: string }) {
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
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading prompt injection settings…</p>;
  if (query.error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">Could not load prompt injection settings.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></div>;
  if (!query.data?.canManage || !query.data.settings) return null;
  return <>
    <PromptInjectionPreventionSettingsView key={companyId} settings={query.data.settings} choices={query.data.choices} models={models.data}
      newlyConnectedId={newlyConnectedId} saving={save.isPending} testing={test.isPending}
      error={save.error?.message ?? test.error?.message ?? (models.error ? "Could not load model suggestions. You can still enter and save a model ID." : null)}
      result={test.variables === revision ? test.data : null} onConnectionChange={setConnectionId} onDraftChange={resetTest}
      onSave={value => save.mutate(value)} onTest={() => test.mutate(revision)} onAdd={() => setAdding(true)} />
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader><DialogTitle>Add an OpenRouter connection</DialogTitle><DialogDescription>Use a shared API connection for prompt injection checks.</DialogDescription></DialogHeader>
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
