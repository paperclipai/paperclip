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
  { key: "userPrompts", label: "User prompts" },
  { key: "assistantResponses", label: "Assistant responses" },
  { key: "toolContent", label: "Tool output and content" },
  { key: "toolDetails", label: "Additional tool details (Claude Code)" },
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
      setValidation("Re-enter every header value for the new endpoint, or remove the header."); return;
    }
    const common = { expectedRevision: original?.revision ?? null, enabled: overrideEnabled ?? enabled, capture };
    const input = provider === "braintrust"
      ? { ...common, destination: { provider, projectId }, credentials: providerChanged || replaceKey || apiKey || (!original?.credentialsConfigured && common.enabled) ? { mode: "replace", apiKey } : { mode: "keep" } }
      : { ...common, destination: { provider, endpointBaseUrl: endpoint }, credentials: providerChanged || headersChanged || requireFreshHeaders
        ? { mode: "replace", headers: headers.map(row => ({ name: row.name, ...(row.value ? { value: row.value } : {}) })) } : { mode: "keep" } };
    const parsed = updateAgentObservabilitySchema.safeParse(input);
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? "Review the configuration."); return; }
    setValidation(null); onSave(parsed.data);
  }
  const receipt = props.result?.revision === revision ? props.result : settings?.lastTest;
  return <section aria-labelledby="agent-observability-heading" className="max-w-2xl space-y-4">
    <div className="space-y-1">
      <h2 id="agent-observability-heading" className="text-lg font-medium">Agent observability</h2>
      <p className="text-sm text-muted-foreground">Send Codex, Claude Code and native OpenCode execution data to your observability service.</p>
    </div>
    {!canManage ? <p className="text-sm text-muted-foreground">Manage connections permission is required to configure agent observability.</p> : <>
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-observability-provider">Destination</Label>
          <select id="agent-observability-provider" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={provider}
            onChange={event => { setProvider(event.target.value as "braintrust" | "otlp"); setApiKey(""); setReplaceKey(false); setValidation(null); }}>
            <option value="braintrust">Braintrust</option><option value="otlp">Custom OTLP</option>
          </select>
        </div>
        {provider === "braintrust" ? <>
          <div className="space-y-2"><Label htmlFor="agent-observability-project">Project ID</Label>
            <Input id="agent-observability-project" value={projectId} onChange={event => setProjectId(event.target.value)} placeholder="Braintrust project UUID" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-observability-key">API key</Label>
            {!providerChanged && original?.credentialsConfigured && !replaceKey ? <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">API key configured</span><Button type="button" variant="outline" size="sm" onClick={() => setReplaceKey(true)}>Replace API key</Button>
            </div> : <Input id="agent-observability-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" />}
          </div>
        </> : <>
          <div className="space-y-2"><Label htmlFor="agent-observability-endpoint">OTLP base URL</Label>
            <Input id="agent-observability-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://collector.example.com" autoComplete="off" />
            <p className="text-xs text-muted-foreground">Use the base URL without /v1/logs or /v1/traces. It must be reachable from each agent environment.</p>
          </div>
          <div className="space-y-2"><div className="flex items-center justify-between gap-3"><Label>Headers</Label>
            <Button type="button" variant="outline" size="sm" disabled={headers.length >= 16} onClick={() => setHeaders(rows => [...rows, { id: nextHeader.current++, originalName: null, name: "", value: "" }])}>Add header</Button></div>
            {headers.length === 0 && <p className="text-sm text-muted-foreground">No authentication headers.</p>}
            {headers.map(row => <div key={row.id} className="flex flex-wrap items-center gap-2">
              <Input className="min-w-0 flex-1" aria-label="Header name" value={row.name} onChange={event => setHeaders(rows => rows.map(item => item.id === row.id ? { ...item, name: event.target.value } : item))} autoComplete="off" />
              <Input className="min-w-0 flex-1" aria-label={`Value for ${row.name || "header"}`} type="password" value={row.value} placeholder={row.originalName && !requireFreshHeaders ? "Keep saved value" : "Header value"}
                onChange={event => setHeaders(rows => rows.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))} autoComplete="new-password" />
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${row.name || "header"}`} onClick={() => setHeaders(rows => rows.filter(item => item.id !== row.id))}>Remove</Button>
            </div>)}
          </div>
        </>}
        <p className="text-xs text-muted-foreground">The agent harness receives these credentials. Use a key limited to telemetry ingestion.</p>
        <ToggleField label="Enable export" checked={enabled} onChange={setEnabled} hint="Applies to executions that start preparation after saving." />
        <details><summary className="cursor-pointer text-sm font-medium">Content capture</summary>
          <div className="space-y-3 pt-3">{captureLabels.map(row => <ToggleField key={row.key} label={row.label} checked={capture[row.key]} onChange={value => setCapture(current => ({ ...current, [row.key]: value }))} />)}
            <p className="text-xs text-muted-foreground">Native limits apply. Exported records can contain task content, including prompts and tool output. A collector can forward records to multiple services.</p>
          </div>
        </details>
      </fieldset>
      {(validation || error || hasConflict) && <p role="alert" className="text-sm text-destructive">{validation || error || "Another administrator changed these settings. Reload the saved settings to continue."}</p>}
      {hasConflict && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { reset(); onReload?.(); }}>Reload saved settings</Button>}
      {!dirty && receipt && <div role="status" className="space-y-1 text-sm">
        <p className="font-medium">{receipt.status === "accepted" ? "Test payload accepted" : receipt.status === "partial" ? "Some test records were rejected" : "Test payload failed"}</p>
        <p className="text-xs text-muted-foreground">{new Date(receipt.finishedAt).toLocaleString()} · Sent from the Paperclip server.</p>
        {(["logs", "traces"] as const).map(signal => receipt.signals[signal].message && <p key={signal}>{signal === "logs" ? "Logs" : "Traces"}: {receipt.signals[signal].message}</p>)}
      </div>}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" disabled={busy || !dirty} onClick={reset}>Cancel</Button>
        <Button type="button" disabled={busy || !dirty || hasConflict} onClick={() => save()}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>
      {dirty && settings && <p className="text-xs text-muted-foreground">Save changes before testing.</p>}
      {settings && <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy || dirty || hasConflict} onClick={onTest}>{testing ? "Testing…" : "Test saved settings"}</Button>
        {settings.enabled && <Button type="button" size="sm" variant="ghost" disabled={busy || dirty || hasConflict} onClick={() => save(false)}>Disable export</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={busy || dirty || hasConflict} onClick={onRemove}>{removing ? "Removing…" : "Remove configuration"}</Button>
      </div>}
    </>}
  </section>;
}

export function AgentObservabilitySettingsSection({ companyId }: { companyId: string }) {
  return <AgentObservabilitySettingsContainer key={companyId} companyId={companyId} />;
}
function AgentObservabilitySettingsContainer({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const queryKey = ["agent-observability", companyId];
  const query = useQuery({ queryKey, queryFn: () => agentObservabilityApi.settings(companyId) });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const accept = (data: AgentObservabilitySettingsResponse) => { client.setQueryData(queryKey, data); setError(null); setConflict(false); setResetKey(value => value + 1); };
  const reject = (cause: unknown) => {
    const stale = cause instanceof ApiError && cause.status === 409;
    setConflict(stale);
    setError(stale ? "Another administrator changed these settings. Reload the saved settings to continue." : cause instanceof Error ? cause.message : "The observability settings could not be updated.");
  };
  const save = useMutation({ gcTime: 0, mutationFn: (input: UpdateAgentObservabilityRequest) => agentObservabilityApi.update(companyId, input), onSuccess: accept, onError: reject, onSettled: () => queueMicrotask(() => save.reset()) });
  const remove = useMutation({ mutationFn: (revision: string) => agentObservabilityApi.remove(companyId, revision), onSuccess: accept, onError: reject });
  const test = useMutation({ mutationFn: (revision: string) => agentObservabilityApi.test(companyId, revision), onSuccess: receipt => {
    setError(null); client.setQueryData<AgentObservabilitySettingsResponse>(queryKey, current => current?.settings?.revision === receipt.revision
      ? { ...current, settings: { ...current.settings, lastTest: receipt } } : current);
  }, onError: reject });
  useEffect(() => { setError(null); setConflict(false); save.reset(); test.reset(); remove.reset(); }, [companyId]);
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading agent observability…</p>;
  if (!query.data) return <div role="alert" className="space-y-2 text-sm"><p>Agent observability settings could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></div>;
  return <AgentObservabilitySettingsView key={companyId} companyId={companyId} settings={query.data.settings} canManage={query.data.canManage}
    saving={save.isPending} removing={remove.isPending} testing={test.isPending} error={error ?? (query.isError ? "Saved settings could not be refreshed. Your draft is unchanged." : null)} conflict={conflict} resetKey={resetKey}
    onSave={input => save.mutate(input)} onTest={() => { if (query.data.settings) test.mutate(query.data.settings.revision); }}
    onRemove={() => { if (query.data.settings) remove.mutate(query.data.settings.revision); }}
    onReload={() => { setConflict(false); setError(null); void query.refetch(); }} />;
}
