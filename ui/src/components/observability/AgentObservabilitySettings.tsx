import { useTranslation, t } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_AGENT_OBSERVABILITY_CAPTURE, updateAgentObservabilitySchema, isSameOtlpOrigin,
  type AgentObservabilityCapture, type AgentObservabilitySettings, type AgentObservabilitySettingsResponse,
  type AgentObservabilityTestReceipt, type UpdateAgentObservabilityRequest,
} from "@paperclipai/shared";
import { agentObservabilityApi } from "@/api/agent-observability";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleField } from "@/components/agent-config-primitives";

type HeaderDraft = { id: number; originalName: string | null; name: string; value: string };
const captureLabels: Array<{ key: keyof AgentObservabilityCapture; label: string }> = [
  { key: "userPrompts", get label() { return t("agent-config:userPrompts_03362c0"); } },
  { key: "assistantResponses", get label() { return t("agent-config:assistantResponses_5c707a0"); } },
  { key: "toolContent", get label() { return t("agent-config:toolOutputAndContent_6bfc8f7"); } },
  { key: "toolDetails", get label() { return t("agent-config:additionalToolDetailsClaudeCode_852af95"); } },
];
export interface AgentObservabilitySettingsViewProps {
  companyId: string;
  settings: AgentObservabilitySettings | null;
  canManage?: boolean;
  saving?: boolean;
  testing?: boolean;
  removing?: boolean;
  error?: string | null;
  conflict?: boolean;
  result?: AgentObservabilityTestReceipt | null;
  /** Changes only after an explicit successful mutation, never a background refetch. */
  resetKey?: number;
  onSave: (input: UpdateAgentObservabilityRequest) => void;
  onTest: () => void;
  onRemove: () => void;
  onReload?: () => void;
}

export function AgentObservabilitySettingsView(props: AgentObservabilitySettingsViewProps) {
  const { t } = useTranslation("agent-config");
  const { companyId, settings, canManage = true, saving, testing, removing, error, conflict, onSave, onTest, onRemove, onReload } = props;
  const [provider, setProvider] = useState<"braintrust" | "otlp">("braintrust");
  const [projectId, setProjectId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [capture, setCapture] = useState<AgentObservabilityCapture>({ ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE });
  const [apiKey, setApiKey] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const [applied, setApplied] = useState<AgentObservabilitySettings | null>(settings);
  const nextHeader = useRef(0);
  const revision = settings?.revision ?? null;
  function reset() {
    setApplied(settings);
    setProvider(settings?.destination.provider ?? "braintrust");
    setProjectId(settings?.destination.provider === "braintrust" ? settings.destination.projectId : "");
    setEndpoint(settings?.destination.provider === "otlp" ? settings.destination.endpointBaseUrl : "");
    setEnabled(settings?.enabled ?? false);
    setCapture({ ...(settings?.capture ?? DEFAULT_AGENT_OBSERVABILITY_CAPTURE) });
    setApiKey(""); setReplaceKey(false); setValidation(null);
    setHeaders((settings?.destination.provider === "otlp" ? settings.headerNames : []).map(name => ({ id: nextHeader.current++, originalName: name, name, value: "" })));
  }
  const original = applied;
  const headersChanged = provider === "otlp" && (headers.some(row => row.value || row.originalName !== row.name.toLowerCase())
    || JSON.stringify(headers.map(row => row.name.toLowerCase()).sort()) !== JSON.stringify(original?.destination.provider === "otlp" ? [...original.headerNames].sort() : []));
  const dirty = !original || provider !== original.destination.provider || enabled !== original.enabled || replaceKey || Boolean(apiKey) || headersChanged
    || JSON.stringify(capture) !== JSON.stringify(original.capture)
    || (provider === "braintrust" ? projectId !== (original.destination.provider === "braintrust" ? original.destination.projectId : "")
      : endpoint !== (original.destination.provider === "otlp" ? original.destination.endpointBaseUrl : ""));
  // Explicit mutation success/company changes erase secrets. Background reads
  // may update a clean form, but cannot overwrite an unsaved draft.
  useEffect(() => { reset(); }, [companyId, props.resetKey]);
  useEffect(() => { if (!dirty && !conflict) reset(); }, [revision]);
  const hasConflict = Boolean(conflict || revision !== (original?.revision ?? null));
  const requireFreshHeaders = provider === "otlp" && original?.destination.provider === "otlp"
    && original.headerNames.length > 0 && !isSameOtlpOrigin(original.destination, { provider: "otlp", endpointBaseUrl: endpoint });
  const busy = saving || testing || removing;
  const providerChanged = !original || original.destination.provider !== provider;
  function save(overrideEnabled?: boolean) {
    if (requireFreshHeaders && headers.some(row => !row.value)) {
      setValidation(t("agent-config:reEnterEveryHeaderValueForTheNew_91572c4")); return;
    }
    const common = { expectedRevision: original?.revision ?? null, enabled: overrideEnabled ?? enabled, capture };
    const input = provider === "braintrust"
      ? { ...common, destination: { provider, projectId }, credentials: providerChanged || replaceKey || apiKey || (!original?.credentialsConfigured && common.enabled) ? { mode: "replace", apiKey } : { mode: "keep" } }
      : { ...common, destination: { provider, endpointBaseUrl: endpoint }, credentials: providerChanged || headersChanged || requireFreshHeaders
        ? { mode: "replace", headers: headers.map(row => ({ name: row.name, ...(row.value ? { value: row.value } : {}) })) } : { mode: "keep" } };
    const parsed = updateAgentObservabilitySchema.safeParse(input);
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? t("agent-config:reviewTheConfiguration_6cc7c36")); return; }
    setValidation(null); onSave(parsed.data);
  }
  const receipt = props.result?.revision === revision ? props.result : settings?.lastTest;
  return <section aria-labelledby="agent-observability-heading" className="max-w-2xl space-y-4">
    <div className="space-y-1">
      <h2 id="agent-observability-heading" className="text-lg font-medium">{t("agent-config:agentObservability_d4cd002")}</h2>
      <p className="text-sm text-muted-foreground">{t("agent-config:sendCodexClaudeCodeAndNativeOpencodeExecution_8c62584")}</p>
    </div>
    {!canManage ? <p className="text-sm text-muted-foreground">{t("agent-config:manageConnectionsPermissionIsRequiredToConfigureAgent_6a09348")}</p> : <>
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-observability-provider">{t("agent-config:destination_d427134")}</Label>
          <select id="agent-observability-provider" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={provider}
            onChange={event => { setProvider(event.target.value as "braintrust" | "otlp"); setApiKey(""); setReplaceKey(false); setValidation(null); }}>
            <option value="braintrust">{t("agent-config:braintrust_dc0fa84")}</option><option value="otlp">{t("agent-config:customOtlp_aa0441e")}</option>
          </select>
        </div>
        {provider === "braintrust" ? <>
          <div className="space-y-2"><Label htmlFor="agent-observability-project">{t("agent-config:projectId_1d30cd1")}</Label>
            <Input id="agent-observability-project" value={projectId} onChange={event => setProjectId(event.target.value)} placeholder={t("agent-config:braintrustProjectUuid_f917597")} autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-observability-key">{t("agent-config:apiKey_cf678ca")}</Label>
            {!providerChanged && original?.credentialsConfigured && !replaceKey ? <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">{t("agent-config:apiKeyConfigured_557ddb8")}</span><Button type="button" variant="outline" size="sm" onClick={() => setReplaceKey(true)}>{t("agent-config:replaceApiKey_027a4b1")}</Button>
            </div> : <Input id="agent-observability-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" />}
          </div>
        </> : <>
          <div className="space-y-2"><Label htmlFor="agent-observability-endpoint">{t("agent-config:otlpBaseUrl_d8c972b")}</Label>
            <Input id="agent-observability-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://collector.example.com" autoComplete="off" />
            <p className="text-xs text-muted-foreground">{t("agent-config:useTheBaseUrlWithoutV1LogsOr_6584fed")}</p>
          </div>
          <div className="space-y-2"><div className="flex items-center justify-between gap-3"><Label>{t("agent-config:headers_520de74")}</Label>
            <Button type="button" variant="outline" size="sm" disabled={headers.length >= 16} onClick={() => setHeaders(rows => [...rows, { id: nextHeader.current++, originalName: null, name: "", value: "" }])}>{t("agent-config:addHeader_d5a110d")}</Button></div>
            {headers.length === 0 && <p className="text-sm text-muted-foreground">{t("agent-config:noAuthenticationHeaders_f1d4f04")}</p>}
            {headers.map(row => <div key={row.id} className="flex flex-wrap items-center gap-2">
              <Input className="min-w-0 flex-1" aria-label={t("agent-config:headerName_b46f85a")} value={row.name} onChange={event => setHeaders(rows => rows.map(item => item.id === row.id ? { ...item, name: event.target.value } : item))} autoComplete="off" />
              <Input className="min-w-0 flex-1" aria-label={t("agent-config:valueForValue_ad77079", { value1: row.name || "header" })} type="password" value={row.value} placeholder={row.originalName && !requireFreshHeaders ? t("agent-config:keepSavedValue_3056b1a") : t("agent-config:headerValue_418adf0")}
                onChange={event => setHeaders(rows => rows.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))} autoComplete="new-password" />
              <Button type="button" size="sm" variant="ghost" aria-label={t("agent-config:removeValue_e1842c0", { value1: row.name || "header" })} onClick={() => setHeaders(rows => rows.filter(item => item.id !== row.id))}>{t("agent-config:remove_e963907")}</Button>
            </div>)}
          </div>
        </>}
        <p className="text-xs text-muted-foreground">{t("agent-config:theAgentHarnessReceivesTheseCredentialsUseA_dccd3c8")}</p>
        <ToggleField label={t("agent-config:enableExport_b525cee")} checked={enabled} onChange={setEnabled} hint={t("agent-config:appliesToExecutionsThatStartPreparationAfterSaving_8fd5ab2")} />
        <details><summary className="cursor-pointer text-sm font-medium">{t("agent-config:contentCapture_609925d")}</summary>
          <div className="space-y-3 pt-3">{captureLabels.map(row => <ToggleField key={row.key} label={row.label} checked={capture[row.key]} onChange={value => setCapture(current => ({ ...current, [row.key]: value }))} />)}
            <p className="text-xs text-muted-foreground">{t("agent-config:nativeLimitsApplyExportedRecordsCanContainTask_4deb902")}</p>
          </div>
        </details>
      </fieldset>
      {(validation || error || hasConflict) && <p role="alert" className="text-sm text-destructive">{validation || error || t("agent-config:anotherAdministratorChangedTheseSettingsReloadTheSaved_49893c5")}</p>}
      {hasConflict && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { reset(); onReload?.(); }}>{t("agent-config:reloadSavedSettings_c236499")}</Button>}
      {!dirty && receipt && <div role="status" className="space-y-1 text-sm">
        <p className="font-medium">{receipt.status === "accepted" ? t("agent-config:testPayloadAccepted_28ae0f0") : receipt.status === "partial" ? t("agent-config:someTestRecordsWereRejected_ea59097") : t("agent-config:testPayloadFailed_d4d993f")}</p>
        <p className="text-xs text-muted-foreground">{new Date(receipt.finishedAt).toLocaleString()} {t("agent-config:sentFromThePaperclipServer_b59ed75")}</p>
        {(["logs", "traces"] as const).map(signal => receipt.signals[signal].message && <p key={signal}>{signal === "logs" ? t("agent-config:logs_126dd3b") : t("agent-config:traces_194e807")}: {receipt.signals[signal].message}</p>)}
      </div>}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" disabled={busy || !dirty} onClick={reset}>{t("agent-config:cancel_77dfd21")}</Button>
        <Button type="button" disabled={busy || !dirty || hasConflict} onClick={() => save()}>{saving ? t("agent-config:saving_56a2285") : t("agent-config:saveChanges_179359b")}</Button>
      </div>
      {dirty && settings && <p className="text-xs text-muted-foreground">{t("agent-config:saveChangesBeforeTesting_041f387")}</p>}
      {settings && <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy || dirty || hasConflict} onClick={onTest}>{testing ? t("agent-config:testing_95c4564") : t("agent-config:testSavedSettings_acf8612")}</Button>
        {settings.enabled && <Button type="button" size="sm" variant="ghost" disabled={busy || dirty || hasConflict} onClick={() => save(false)}>{t("agent-config:disableExport_8932d85")}</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={busy || dirty || hasConflict} onClick={onRemove}>{removing ? t("agent-config:removing_579d7e7") : t("agent-config:removeConfiguration_0ff0933")}</Button>
      </div>}
    </>}
  </section>;
}

export function AgentObservabilitySettingsSection({ companyId }: { companyId: string }) {
  useTranslation("agent-config");
  return <AgentObservabilitySettingsContainer key={companyId} companyId={companyId} />;
}
function AgentObservabilitySettingsContainer({ companyId }: { companyId: string }) {
  const { t } = useTranslation("agent-config");
  const client = useQueryClient();
  const queryKey = ["agent-observability", companyId];
  const query = useQuery({ queryKey, queryFn: () => agentObservabilityApi.settings(companyId) });
  const queryView = useQueryView(query);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const accept = (data: AgentObservabilitySettingsResponse) => { client.setQueryData(queryKey, data); setError(null); setConflict(false); setResetKey(value => value + 1); };
  const reject = (cause: unknown) => {
    const stale = cause instanceof ApiError && cause.status === 409;
    setConflict(stale);
    setError(stale ? t("agent-config:anotherAdministratorChangedTheseSettingsReloadTheSaved_49893c5") : cause instanceof Error ? cause.message : t("agent-config:theObservabilitySettingsCouldNotBeUpdated_1b4049b"));
  };
  const save = useMutation({ gcTime: 0, mutationFn: (input: UpdateAgentObservabilityRequest) => agentObservabilityApi.update(companyId, input), onSuccess: accept, onError: reject, onSettled: () => queueMicrotask(() => save.reset()) });
  const remove = useMutation({ mutationFn: (revision: string) => agentObservabilityApi.remove(companyId, revision), onSuccess: accept, onError: reject });
  const test = useMutation({ mutationFn: (revision: string) => agentObservabilityApi.test(companyId, revision), onSuccess: receipt => {
    setError(null); client.setQueryData<AgentObservabilitySettingsResponse>(queryKey, current => current?.settings?.revision === receipt.revision
      ? { ...current, settings: { ...current.settings, lastTest: receipt } } : current);
  }, onError: reject });
  useEffect(() => { setError(null); setConflict(false); save.reset(); test.reset(); remove.reset(); }, [companyId]);
  if (["loading", "reconnecting"].includes(queryView.kind)) return <p className="text-sm text-muted-foreground">{t("agent-config:loadingAgentObservability_b017561")}</p>;
  if (!query.data) return <div role="alert" className="space-y-2 text-sm"><p>{t("agent-config:agentObservabilitySettingsCouldNotBeLoaded_c6d55ed")}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t("agent-config:retry_9f5cd8a")}</Button></div>;
  return <AgentObservabilitySettingsView key={companyId} companyId={companyId} settings={query.data.settings} canManage={query.data.canManage}
    saving={save.isPending} removing={remove.isPending} testing={test.isPending} error={error ?? ((queryView.kind === "error") ? t("agent-config:savedSettingsCouldNotBeRefreshedYourDraft_442d884") : null)} conflict={conflict} resetKey={resetKey}
    onSave={input => save.mutate(input)} onTest={() => { if (query.data.settings) test.mutate(query.data.settings.revision); }}
    onRemove={() => { if (query.data.settings) remove.mutate(query.data.settings.revision); }}
    onReload={() => { setConflict(false); setError(null); void query.refetch(); }} />;
}
