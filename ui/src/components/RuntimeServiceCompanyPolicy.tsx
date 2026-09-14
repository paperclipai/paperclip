import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Settings2 } from "lucide-react";
import { updateRuntimeServiceCompanyPolicySchema, type RuntimeServiceCompanyPolicy, type RuntimeServiceCompanyPolicyConfig, type UpdateRuntimeServiceCompanyPolicy } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { runtimeServicesApi } from "../api/runtime-services";
import { serviceKeys, useRuntimeServiceCompanyPolicy } from "../hooks/useRuntimeServices";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Field = keyof RuntimeServiceCompanyPolicyConfig;
const fields: { key: Field; label: string; help: string; minutes?: boolean; days?: boolean }[] = [
  { key: "previewIdleSeconds", label: "Preview idle minutes", minutes: true, help: "Default for new previews. Leave blank to disable idle sleep." },
  { key: "workerIdleSeconds", label: "Worker idle minutes", minutes: true, help: "Default for new workers. Leave blank to run until stopped." },
  { key: "maxRunningSeconds", label: "Company maximum running minutes", minutes: true, help: "Applies to every start, including active previews and holds. Existing starts use their original start time." },
  { key: "maxRunningServices", label: "Running service limit", help: "Includes starts, retries and processes still stopping. Lowering this limit stops the newest excess services." },
  { key: "retainedDataSeconds", label: "Retain unused data for days", days: true, help: "Leave blank to keep files until explicitly deleted. A duration enables permanent deletion of unused workspaces, including source and application data. Active services and linked tasks protect their files. Each policy save gives existing data a full interval before cleanup." },
  { key: "maxServiceAllocations", label: "Retained allocation limit", help: "Counts saved workspace allocations. Services sharing one allocation use one slot. Lowering this limit blocks new allocations and keeps existing files." },
];
type Draft = { revision: number; fields: Record<Field, string> };
function toDraft(policy: RuntimeServiceCompanyPolicy): Draft {
  return { revision: policy.revision, fields: Object.fromEntries(fields.map((field) => [field.key, policy.config[field.key] === null ? "" : String(policy.config[field.key]! / (field.days ? 86400 : field.minutes ? 60 : 1))])) as Draft["fields"] };
}

/** Company inventory policy editor; drafts are independent of live polling. */
export function RuntimeServiceCompanyPolicyEditor({ companyId }: { companyId: string }) {
  const query = useRuntimeServiceCompanyPolicy(companyId);
  const client = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const sending = useRef(false);
  const mutation = useMutation({
    retry: false,
    mutationFn: (input: UpdateRuntimeServiceCompanyPolicy) => runtimeServicesApi.updateCompanyPolicy(companyId, input, { signal: AbortSignal.timeout(20_000) }),
    onSuccess: (policy) => {
      client.setQueryData<RuntimeServiceCompanyPolicy>(serviceKeys.companyPolicy(companyId), (previous) => previous && previous.revision > policy.revision ? previous : policy);
      setDraft(toDraft(policy));
    },
    onSettled: () => { sending.current = false; void client.invalidateQueries({ queryKey: serviceKeys.company(companyId) }); },
  });
  const ambiguous = mutation.isError && (!(mutation.error instanceof ApiError) || mutation.error.status >= 500);
  const locked = mutation.isPending || ambiguous;
  const stale = !!draft && !!query.data && draft.revision !== query.data.revision;
  function load(policy = query.data) {
    if (!policy || locked) return;
    mutation.reset(); setValidation(null); setDraft(toDraft(policy));
  }
  function send(input: UpdateRuntimeServiceCompanyPolicy) {
    if (sending.current) return;
    sending.current = true; mutation.mutate(input);
  }
  return <section className="flex min-w-0 flex-col gap-3" aria-label="Company service policy">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" size="sm" onClick={() => draft ? setDraft(null) : load()} disabled={locked || !query.data} aria-expanded={!!draft} aria-controls={`${id}-form`}><Settings2 aria-hidden="true" />{draft ? "Close company policy" : "Company defaults and limits"}</Button>
      {query.data && <p className="text-xs text-muted-foreground">{query.data.usage.runningServices}{query.data.config.maxRunningServices === null ? "" : ` / ${query.data.config.maxRunningServices}`} running · {query.data.usage.serviceAllocations}{query.data.config.maxServiceAllocations === null ? "" : ` / ${query.data.config.maxServiceAllocations}`} retained workspaces</p>}
    </div>
    {query.isPending && <p role="status" className="text-xs text-muted-foreground">Loading company service policy…</p>}
    {query.isError && <div className="flex flex-wrap items-center gap-2" role="alert"><p className="text-xs text-destructive">Company policy could not be refreshed.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Refresh company policy</Button></div>}
    {draft && <form id={`${id}-form`} className="flex max-w-3xl flex-col gap-4 rounded-md border border-border p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-duration-fast)" aria-label="Company defaults and limits" onSubmit={(event) => {
      event.preventDefault();
      if (locked || stale || query.isError) return;
      const config = Object.fromEntries(fields.map((field) => [field.key, draft.fields[field.key] === "" ? null : (field.days ? Math.round(Number(draft.fields[field.key]) * 86400) : field.minutes ? Math.round(Number(draft.fields[field.key]) * 60) : Number(draft.fields[field.key]))]));
      const parsed = updateRuntimeServiceCompanyPolicySchema.safeParse({ config, expectedRevision: draft.revision, requestId: crypto.randomUUID() });
      if (!parsed.success) { setValidation(parsed.error.issues.map((issue) => issue.message).join(". ")); return; }
      setValidation(null); send(parsed.data);
    }}>
      <p className="text-sm text-muted-foreground">Idle defaults apply to new services. Hard limits also apply to existing services. Leave a limit blank for no company limit.</p>
      <fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" disabled={locked}>
        {fields.map((field) => <div key={field.key} className="flex min-w-0 flex-col gap-1.5"><Label htmlFor={`${id}-${field.key}`}>{field.label}</Label><Input id={`${id}-${field.key}`} type="number" min={field.minutes ? 1 / 60 : 1} max={field.days ? 3650 : field.minutes ? 43200 : 10000} step={field.minutes || field.days ? "any" : 1} value={draft.fields[field.key]} placeholder={field.days ? "Keep until explicitly deleted" : field.minutes && field.key !== "maxRunningSeconds" ? "No idle sleep" : "No company limit"} aria-describedby={`${id}-${field.key}-help`} onChange={(event) => { setDraft({ ...draft, fields: { ...draft.fields, [field.key]: event.target.value } }); setValidation(null); mutation.reset(); }} /><p id={`${id}-${field.key}-help`} className="text-xs text-muted-foreground">{field.help}</p></div>)}
      </fieldset>
      {stale && !ambiguous && <div className="flex flex-col items-start gap-2" role="alert"><p className="text-xs text-muted-foreground">Company policy changed while you were editing. Load the current policy before saving.</p><Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => load()}>Load current company policy</Button></div>}
      {validation && <p className="text-xs text-destructive" role="alert">{validation}</p>}
      <Button type="submit" size="sm" className="self-start" disabled={locked || stale || query.isError}>{mutation.isPending && <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />}{mutation.isPending ? "Saving company policy…" : "Save company policy"}</Button>
      {mutation.isError && <div className="flex flex-col items-start gap-2" role="alert"><p className="text-xs text-destructive">{ambiguous ? "Could not confirm the save. Retry the same request to find out whether it was accepted." : mutation.error.message}</p>{ambiguous && <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.variables && send(mutation.variables)}>Retry same company policy request</Button>}</div>}
      {mutation.isSuccess && <p className="text-xs text-muted-foreground" role="status">Company policy saved.</p>}
    </form>}
  </section>;
}
