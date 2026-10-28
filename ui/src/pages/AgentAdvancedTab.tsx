import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Agent } from "@paperclipai/shared";
import { Button } from "../components/ui/button";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { parseAgentConfigurationYaml, serializeAgentConfigurationDocument } from "../lib/agent-configuration-yaml";
import { loadAgentConfiguration, type AgentConfigurationSnapshot } from "../lib/agent-configuration/load";
import { ConfigurationSaveInterrupted, planAgentConfiguration, saveAgentConfiguration, type ConfigurationReceipt } from "../lib/agent-configuration/save";

const yamlHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, class: "text-primary" },
  { tag: tags.string, class: "text-foreground" },
  { tag: [tags.bool, tags.number, tags.null], class: "text-muted-foreground" },
  { tag: tags.keyword, class: "text-primary" },
  { tag: tags.comment, class: "text-muted-foreground" },
]);

export interface AgentAdvancedTabProps {
  agent: Agent;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (updated: Agent) => void;
  onSavingChange?: (saving: boolean) => void;
}

export function AgentAdvancedTab(props: AgentAdvancedTabProps) {
  const [initial, setInitial] = useState<AgentConfigurationSnapshot | null>(null);
  const query = useQuery({
    queryKey: ["agent-configuration-yaml", props.agent.companyId, props.agent.id],
    queryFn: () => loadAgentConfiguration(props.agent.id, props.agent.companyId),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!initial && query.data && !query.isFetching) setInitial(query.data);
  }, [initial, query.data, query.isFetching]);
  if (!initial) {
    if (query.error) return <div role="alert" className="space-y-3 text-sm">
      <p>{query.error.message}</p>
      <Button variant="outline" onClick={() => query.refetch()}>Retry</Button>
    </div>;
    return <p role="status" className="text-sm text-muted-foreground">Loading configuration…</p>;
  }
  return <ConfigurationEditor key={props.agent.id} {...props} initial={initial} />;
}

function ConfigurationEditor({ agent, initial, onDirtyChange, onSaved, onSavingChange }: AgentAdvancedTabProps & { initial: AgentConfigurationSnapshot }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [saved, setSaved] = useState(initial);
  const [source, setSource] = useState(() => serializeAgentConfigurationDocument(initial.document));
  const [error, setError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [progress, setProgress] = useState("");
  const [receipts, setReceipts] = useState<ConfigurationReceipt[]>([]);
  const operationPending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const original = useMemo(() => serializeAgentConfigurationDocument(saved.document), [saved]);
  const dirty = source !== original;
  const validation = useMemo(() => {
    try {
      const document = parseAgentConfigurationYaml(source);
      return { document, changes: planAgentConfiguration(saved, document).map(step => step.label), error: null };
    } catch (cause) { return { document: null, changes: [], error: cause instanceof Error ? cause.message : "Invalid YAML" }; }
  }, [source, saved]);
  useEffect(() => { onDirtyChange(dirty || reloadRequired); }, [dirty, reloadRequired, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useMutation({
    mutationFn: async () => {
      if (!validation.document) throw new Error(validation.error ?? "Invalid YAML");
      if (reloadRequired) throw new Error("Reload saved before saving again.");
      return saveAgentConfiguration(saved, validation.document,
        receipt => { if (active.current) setReceipts(current => [...current, receipt]); },
        label => { if (active.current) setProgress(label); });
    },
    retry: false,
    onSuccess: configuration => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      queryClient.setQueryData(["agent-configuration-yaml", agent.companyId, agent.id], configuration);
      if (!active.current) return;
      setSaved(configuration);
      setSource(serializeAgentConfigurationDocument(configuration.document));
      setError(null);
      onDirtyChange(false);
      setReloadRequired(false);
      onSaved(configuration.agent);
      const warnings = configuration.agent.configurationWarnings;
      pushToast({ title: "Agent saved", tone: warnings?.length ? "warn" : "success", body: warnings?.map(warning => warning.message).join("\n") });
    },
    onSettled: () => {
      operationPending.current = false;
      queryClient.invalidateQueries({ predicate: query => query.queryKey.some(part => part === agent.id || part === agent.companyId), refetchType: "none" });
    },
    onError: cause => {
      if (!active.current) return;
      setError(cause.message);
      if (cause instanceof ConfigurationSaveInterrupted) setReloadRequired(true);
    },
  });
  const reload = useMutation({
    mutationFn: () => loadAgentConfiguration(agent.id, agent.companyId),
    onSuccess: updated => {
      queryClient.setQueryData(["agent-configuration-yaml", agent.companyId, agent.id], updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      if (active.current) { setSaved(updated); setSource(serializeAgentConfigurationDocument(updated.document)); setError(null); setReloadRequired(false); onSaved(updated.agent); }
    },
    onSettled: () => { operationPending.current = false; },
    onError: cause => setError(cause.message),
  });
  const busy = save.isPending || reload.isPending;
  useEffect(() => { onSavingChange?.(busy); }, [busy, onSavingChange]);
  useEffect(() => () => onSavingChange?.(false), [onSavingChange]);
  return <div className="space-y-4">
    {receipts.length > 0 && <div className="space-y-3 rounded-md border border-border p-4" aria-label="Created credentials">
      {receipts.map((receipt, index) => <div key={`${receipt.id}-${index}`} className="space-y-2 text-sm">
        <p className="font-medium">{receipt.label}</p>
        {receipt.token ? <>
          <p className="text-muted-foreground">Copy this key now. It won’t be shown again after leaving this page.</p>
          <input readOnly aria-label={`${receipt.label} token`} value={receipt.token} className="w-full rounded-md border border-border bg-muted p-2 font-mono text-sm" />
        </> : <p className="font-mono text-muted-foreground">{receipt.id}</p>}
      </div>)}
    </div>}
    <AgentYamlEditor value={source} onChange={value => { setSource(value); if (!reloadRequired) setError(null); }} readOnly={busy} />
    {dirty && validation.changes.length > 0 && <details className="rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{validation.changes.length} {validation.changes.length === 1 ? "change" : "changes"} to apply</summary>
      <ul className="mt-2 list-inside list-disc space-y-1">{validation.changes.map((label, index) => <li key={index}>{label}</li>)}</ul>
      <p className="mt-2 text-muted-foreground">Changes save in this order. If one fails, earlier changes remain saved.</p>
    </details>}
    {(validation.error || error) && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{validation.error || error}</p>}
    <footer className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border bg-background py-4">
      <Button variant="ghost" disabled={busy} onClick={() => { if (!operationPending.current) { operationPending.current = true; reload.mutate(); } }}>Reload saved</Button>
      <div className="flex items-center gap-3">
        <span role="status" className="text-xs text-muted-foreground">{save.isPending ? `Saving: ${progress || "configuration"}…` : reload.isPending ? "Loading configuration…" : dirty ? validation.document && !validation.changes.length ? "No configuration changes" : "Unsaved changes" : ""}</span>
        <Button disabled={!dirty || busy || reloadRequired || !validation.document || !validation.changes.length} onClick={() => { if (!operationPending.current) { operationPending.current = true; save.mutate(); } }}>{save.isPending ? "Saving…" : "Save changes"}</Button>
      </div>
    </footer>
  </div>;
}

function AgentYamlEditor({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const editability = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({ doc: current.current, extensions: [
        basicSetup, yaml(),
        syntaxHighlighting(yamlHighlightStyle),
        EditorView.contentAttributes.of({ "aria-label": "Agent YAML configuration", spellcheck: "false" }),
        editability.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of(update => { if (update.docChanged) change.current(update.state.doc.toString()); }),
      ] }),
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);
  useEffect(() => {
    editor.current?.dispatch({ effects: editability.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) });
  }, [readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={container} className="agent-yaml-editor overflow-hidden rounded-md border border-border" />;
}
