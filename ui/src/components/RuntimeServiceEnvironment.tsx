import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { runtimeServiceEnvironmentSchema, type EnvBinding, type RuntimeService, type RuntimeServiceEnvironment } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { secretsApi } from "../api/secrets";
import { serviceKeys, useRuntimeServiceOperation } from "../hooks/useRuntimeServices";
import { queryKeys } from "../lib/queryKeys";
import { EnvironmentVariablesEditor, type EnvironmentVariablesEditorHandle } from "./environment-variables-editor";
import { Button } from "./ui/button";

export function RuntimeServiceEnvironmentEditor({ service, disabled }: { service: RuntimeService; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return open ? <EnvironmentEditor service={service} disabled={disabled} onClose={() => setOpen(false)} /> : (
    <Button className="self-start" variant="outline" size="sm" disabled={disabled || service.state === "deleted"} onClick={() => setOpen(true)}>Configure environment</Button>
  );
}

function EnvironmentEditor({ service, disabled, onClose }: { service: RuntimeService; disabled?: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const editor = useRef<EnvironmentVariablesEditorHandle>(null);
  const operation = useRuntimeServiceOperation(service);
  const query = useQuery({
    queryKey: serviceKeys.environment(service.companyId, service.id),
    queryFn: ({ signal }) => runtimeServicesApi.environment(service.companyId, service.id, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }),
    retry: false, gcTime: 0,
  });
  const secrets = useQuery({ queryKey: queryKeys.secrets.list(service.companyId), queryFn: () => secretsApi.list(service.companyId), retry: false });
  const [loaded, setLoaded] = useState<RuntimeServiceEnvironment | null>(null);
  const [value, setValue] = useState<Record<string, EnvBinding>>({});
  const [editorKey, setEditorKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Polls and rejected saves never replace a draft or advance its revision.
  useEffect(() => {
    if (!loaded && query.data && !query.isFetching) { setLoaded(query.data); setValue(query.data.env); }
  }, [loaded, query.data, query.isFetching]);
  useEffect(() => {
    if (operation.isSuccess && operation.data && operation.variables && "env" in operation.variables) {
      setLoaded({ revision: operation.data.revision, env: operation.variables.env });
      setValue(operation.variables.env);
    }
  }, [operation.isSuccess, operation.data, operation.variables]);
  const stopped = service.desiredState !== "running" && ["stopped", "sleeping", "failed"].includes(service.state);
  const locked = disabled || !stopped || operation.pending || operation.ambiguous || query.isFetching;
  async function reload() {
    const result = await query.refetch();
    if (result.isSuccess) {
      setLoaded(result.data); setValue(result.data.env); setEditorKey((key) => key + 1);
      setError(null); operation.reset();
    }
  }
  function save() {
    if (locked || !loaded) return;
    const draft = editor.current?.readDraft();
    if (!draft) return;
    if (draft.error) { setError(draft.error); return; }
    const parsed = runtimeServiceEnvironmentSchema.safeParse(draft.value);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" ")); return; }
    setError(null);
    operation.run({ env: parsed.data }, loaded.revision);
  }
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Service environment">
      <h3 className="text-sm font-medium">Environment</h3>
      <p className="text-xs text-muted-foreground">Organization secrets are bound to this service and resolved at each start. Rotated values take effect on the next start; an existing process keeps the values it already received.</p>
      {!stopped && <p className="text-xs text-muted-foreground" role="status">Stop the service before changing its environment.</p>}
      {query.isPending && <p className="text-xs text-muted-foreground" role="status">Loading environment…</p>}
      {query.isError && <div role="alert" className="flex flex-col gap-2"><p className="text-xs text-destructive">Environment could not be loaded. Your draft is preserved.</p><Button size="sm" variant="outline" className="self-start" disabled={operation.pending || operation.ambiguous} onClick={() => void query.refetch()}>Retry loading environment</Button></div>}
      {secrets.isError && <div role="alert" className="flex flex-col gap-2"><p className="text-xs text-destructive">Organization secrets could not be refreshed.</p><Button size="sm" variant="outline" className="self-start" onClick={() => void secrets.refetch()}>Retry loading secrets</Button></div>}
      {loaded && <EnvironmentVariablesEditor
        key={editorKey} ref={editor} value={value} onChange={(next) => setValue(next ?? {})}
        secrets={secrets.data ?? []} allowUserSecrets={false} disabled={locked || query.isError}
        hideDraftActions onDirtyChange={setDirty}
        onCreateSecret={async (name, secretValue) => {
          const secret = await secretsApi.create(service.companyId, { name, value: secretValue });
          client.setQueryData(queryKeys.secrets.list(service.companyId), (previous: typeof secrets.data) => [...(previous ?? []).filter((item) => item.id !== secret.id), secret]);
          return secret;
        }}
        footerHint="Use text for ordinary settings and organization secrets for credentials. Save, then start the service. Runtime and allocated port variables are provided automatically."
      />}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={locked || !loaded || query.isError} onClick={save}>{operation.pending ? "Saving…" : "Save environment"}</Button>
        <Button size="sm" variant="ghost" disabled={operation.pending || operation.ambiguous} onClick={onClose}>Close environment</Button>
      </div>
      {operation.isError && <div className="flex flex-col gap-2" role="alert">
        <p className="text-xs text-destructive">{operation.ambiguous ? "Could not confirm the save. Retry the same request to find out whether it was accepted." : operation.error.message}</p>
        {operation.ambiguous ? <Button className="self-start" size="sm" variant="outline" disabled={operation.pending} onClick={operation.retryRequest}>Retry same request</Button> : <Button className="self-start" size="sm" variant="outline" disabled={query.isFetching || operation.pending} onClick={() => void reload()}>Discard draft and load current environment</Button>}
      </div>}
      {operation.isSuccess && !dirty && <p className="text-xs text-muted-foreground" role="status">Environment saved.{stopped ? " Start the service to apply it." : ""}</p>}
    </section>
  );
}
