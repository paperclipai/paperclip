import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { AttachRuntimeServiceTask, RuntimeService } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { publishRuntimeService, serviceKeys } from "../hooks/useRuntimeServices";
import { Link } from "../lib/router";
import { SearchableSelect } from "./SearchableSelect";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RuntimeServiceTaskDetach } from "./RuntimeServiceTaskDetach";

export function RuntimeServiceTaskWorkspace({ service, disabled = false }: { service: RuntimeService; disabled?: boolean }) {
  const id = useId(), client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [task, setTask] = useState({ value: service.issueId ?? "", label: "Associated task" });
  const request = useRef<AttachRuntimeServiceTask | null>(null);
  const submitting = useRef(false);
  const tasks = useQuery({ queryKey: ["runtime-service-attachment-tasks", service.companyId, search],
    queryFn: ({ signal }) => issuesApi.list(service.companyId, { q: search || undefined, limit: 20, sortField: "updated", sortDir: "desc" }, { signal }),
    enabled: open, retry: 1,
  });
  const mutation = useMutation({ mutationKey: serviceKeys.mutation(service.companyId, service.id),
    mutationFn: (input: AttachRuntimeServiceTask) => runtimeServicesApi.attachTask(service.companyId, service.id, input),
    onSuccess: (result) => {
      request.current = null;
      setOpen(false);
      publishRuntimeService(client, result);
      void client.invalidateQueries({ queryKey: serviceKeys.company(service.companyId) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        request.current = null;
        void client.invalidateQueries({ queryKey: serviceKeys.detail(service.companyId, service.id) });
      }
    },
    onSettled: () => { submitting.current = false; },
  });
  if (service.taskWorkspace) return <div className="flex flex-col gap-2 text-sm">
    <p role="status">Agent runs in the attached task use this service’s retained files.</p>
    <Link className="self-start text-primary hover:underline" to={`/issues/${service.taskWorkspace.issueId}`}>Open development task</Link>
    <RuntimeServiceTaskDetach service={service} disabled={disabled} />
  </div>;
  if (!service.canAttachTaskWorkspace) return null;
  const frozen = mutation.isPending || Boolean(request.current);
  const options = [
    ...(task.value ? [{ key: task.value, ...task }] : []),
    ...(tasks.data ?? []).filter((issue) => issue.id !== task.value).map((issue) => ({ key: issue.id, value: issue.id, label: `${issue.identifier ?? "Task"} · ${issue.title}` })),
  ];
  return <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
    {!open ? <Button className="self-start" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>Develop in a task</Button> : <>
      <div className="flex flex-col gap-1"><h3 className="text-sm font-medium">Develop in a task</h3>
        <p className="text-sm text-muted-foreground">The task’s next agent run will use this service’s retained files. Its previous checkout stays saved. Finish any active run before attaching.</p></div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>Development task</Label>
        <SearchableSelect id={id} value={task.value} disabled={disabled || frozen} groups={[{ id: "tasks", options }]}
          onValueChange={(_value, option) => { setTask({ value: option.value, label: option.label }); mutation.reset(); }}
          onSearchChange={setSearch} filterOption={() => true} loading={tasks.isFetching} placeholder="Choose a task"
          searchPlaceholder="Find a task by title or identifier…" emptyMessage="No matching tasks" />
      </div>
      {tasks.isError && <p className="text-sm text-destructive" role="alert">Tasks could not be loaded. <Button size="sm" variant="ghost" onClick={() => void tasks.refetch()}>Retry</Button></p>}
      {mutation.isError && <p className="text-sm text-destructive" role="alert">{request.current ? "Attachment could not be confirmed. Retry the same request to check its result." : mutation.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled || mutation.isPending || !task.value} onClick={() => {
          if (submitting.current) return;
          submitting.current = true;
          request.current ??= { issueId: task.value, requestId: crypto.randomUUID(), expectedRevision: service.revision };
          mutation.mutate(request.current);
        }}>{mutation.isPending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{mutation.isPending ? "Attaching…" : request.current ? "Retry attachment" : "Attach task workspace"}</Button>
        <Button variant="ghost" disabled={frozen} onClick={() => { setOpen(false); mutation.reset(); }}>Cancel</Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">{mutation.isPending ? "Attaching service workspace" : ""}</span>
    </>}
  </section>;
}
