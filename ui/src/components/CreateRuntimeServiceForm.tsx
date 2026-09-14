import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRuntimeServiceSchema, type CreateRuntimeService } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { environmentsApi } from "../api/environments";
import { SearchableSelect } from "./SearchableSelect";
import { serviceKeys, publishRuntimeService } from "../hooks/useRuntimeServices";
import { useNavigate } from "../lib/router";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function CreateRuntimeServiceForm({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [purpose, setPurpose] = useState<"preview" | "worker">("preview");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [task, setTask] = useState({ value: "", label: "No task association" });
  const [taskSearch, setTaskSearch] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const tasks = useQuery({
    queryKey: ["runtime-service-task-options", companyId, taskSearch],
    queryFn: ({ signal }) => issuesApi.list(companyId, { q: taskSearch || undefined, limit: 20, sortField: "updated", sortDir: "desc" }, { signal }),
    enabled: advancedOpen,
    retry: 1,
  });
  const environments = useQuery({ queryKey: ["runtime-service-environment-options", companyId], queryFn: () => environmentsApi.list(companyId), enabled: advancedOpen, retry: 1 });
  const taskOptions = [
    { key: "none", value: "", label: "No task association" },
    ...(task.value ? [{ key: task.value, ...task }] : []),
    ...(tasks.data ?? []).filter((item) => item.id !== task.value).map((item) => ({ key: item.id, value: item.id, label: `${item.identifier ?? "Task"} · ${item.title}` })),
  ];
  const [validationError, setValidationError] = useState<string | null>(null);
  const previous = useRef<{ signature: string; requestId: string } | null>(null);
  const mutation = useMutation({
    retry: false,
    mutationFn: (input: CreateRuntimeService) => runtimeServicesApi.create(companyId, input, { signal: AbortSignal.timeout(20_000) }),
    onSuccess: (service) => {
      publishRuntimeService(client, service);
      void client.invalidateQueries({ queryKey: serviceKeys.company(companyId) });
      navigate(service.detailPath);
    },
  });
  const ambiguous = mutation.isError && !(mutation.error instanceof ApiError);
  return (
    <form className="flex max-w-xl flex-col gap-4" aria-label="Create service" onSubmit={(event) => {
      event.preventDefault();
      if (mutation.isPending) return;
      if (ambiguous && mutation.variables) { mutation.mutate(mutation.variables); return; }
      const fields = new FormData(event.currentTarget);
      const text = (key: string) => String(fields.get(key) ?? "").trim();
      const values = {
        name: text("name"), purpose, command: text("command"), cwd: text("cwd") || undefined,
        issueId: task.value || undefined, environmentId: environmentId || undefined,
        endpoints: purpose === "preview" ? [{ name: "web", ...(text("port") ? { port: Number(text("port")) } : {}) }] : [],
      };
      const signature = JSON.stringify(values);
      if (previous.current?.signature !== signature) previous.current = { signature, requestId: crypto.randomUUID() };
      const parsed = createRuntimeServiceSchema.safeParse({ ...values, requestId: previous.current!.requestId });
      if (!parsed.success) { setValidationError(parsed.error.issues.map((item) => item.message).join(". ")); return; }
      setValidationError(null);
      mutation.mutate(parsed.data);
    }}>
      <h2 className="text-base font-medium">Create a service</h2>
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={mutation.isPending || ambiguous}>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-name`}>Name</Label><Input id={`${id}-name`} name="name" required maxLength={120} placeholder="React preview" /></div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-purpose`}>Purpose</Label><Select value={purpose} onValueChange={(value) => setPurpose(value as "preview" | "worker")}><SelectTrigger id={`${id}-purpose`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="preview">Development preview</SelectItem><SelectItem value="worker">Background worker</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">Uses the company’s idle default. You can adjust the service lifetime after creation; company limits still apply.</p></div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-command`}>Start command</Label><Textarea className="font-mono" id={`${id}-command`} name="command" required placeholder={purpose === "preview" ? 'npm run dev -- --host 0.0.0.0 --port "$PORT"' : "node worker.js"} /></div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-cwd`}>Working folder</Label><Input id={`${id}-cwd`} name="cwd" placeholder="Use the associated task’s current folder" /><p className="text-xs text-muted-foreground">Uses the files in this folder, including uncommitted changes.</p></div>
      {purpose === "preview" && <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-port`}>Application port</Label><Input id={`${id}-port`} name="port" type="number" min="1024" max="65535" placeholder="Choose automatically" /><p className="text-xs text-muted-foreground">The chosen port is available to the command as PORT. For a fixed-port command, enter its port here.</p></div>}
      <details className="flex flex-col gap-3" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm">Task and environment</summary>
        <div className="flex flex-col gap-3 py-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-task`}>Associated task</Label>
            <SearchableSelect id={`${id}-task`} value={task.value} groups={[{ id: "tasks", options: taskOptions }]} onValueChange={(_value, option) => setTask({ value: option.value, label: option.label })} onSearchChange={setTaskSearch} filterOption={() => true} placeholder="No task association" searchPlaceholder="Find a task by title or identifier…" loading={tasks.isFetching} emptyMessage="No matching tasks" />
            {tasks.isError && <div className="flex items-center gap-2 text-xs" role="alert"><span className="text-destructive">Tasks could not be loaded.</span><Button type="button" size="xs" variant="outline" onClick={() => void tasks.refetch()}>Retry</Button></div>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-environment`}>Environment</Label>
            <Select value={environmentId || "current"} onValueChange={(value) => setEnvironmentId(value === "current" ? "" : value)}><SelectTrigger id={`${id}-environment`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="current">Use the task’s current environment</SelectItem>{environments.data?.map((environment) => <SelectItem key={environment.id} value={environment.id} disabled={environment.status !== "active"}>{environment.name}</SelectItem>)}</SelectContent></Select>
            {environments.isError && <div className="flex items-center gap-2 text-xs" role="alert"><span className="text-destructive">Environments could not be loaded.</span><Button type="button" size="xs" variant="outline" onClick={() => void environments.refetch()}>Retry</Button></div>}
          </div>
          <p className="text-xs text-muted-foreground">Agents attach the current task and environment automatically.</p>
        </div>
      </details>
      </fieldset>
      {(validationError || mutation.isError) && <p className="text-sm text-destructive" role="alert">{validationError ?? (ambiguous ? "Could not confirm creation. Retry the same request to recover the service without creating a duplicate." : mutation.error?.message)}</p>}
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : mutation.isError ? "Retry creation" : "Create and start"}</Button><Button type="button" variant="ghost" size="sm" disabled={mutation.isPending} onClick={onClose}>Cancel</Button></div>
    </form>
  );
}
