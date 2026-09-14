import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import type { DeleteRuntimeServiceData, RuntimeService, RuntimeServiceDataDeletionPlan } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { ApiError } from "../api/client";
import { serviceKeys } from "../hooks/useRuntimeServices";
import { formatDateTime } from "../lib/utils";
import { Link } from "../lib/router";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

function newerPlan(previous: RuntimeServiceDataDeletionPlan | undefined, incoming: RuntimeServiceDataDeletionPlan) {
  if (previous?.allocationId === incoming.allocationId && previous.deletion &&
      (!incoming.deletion || previous.deletion.updatedAt > incoming.deletion.updatedAt)) return previous;
  return incoming;
}
export function RuntimeServiceDataDeletion({ service, canManage }: { service: RuntimeService; canManage: boolean }) {
  const id = useId(), client = useQueryClient();
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState<string | null>(null);
  const attempt = useRef<DeleteRuntimeServiceData | null>(null), submitting = useRef(false), reviewedToken = useRef<string | null>(null);
  const key = ["runtime-service-data-deletion", service.companyId, service.id];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => runtimeServicesApi.dataDeletionReview(service.companyId, service.id, { signal }),
    enabled: open || !!service.dataDeletion, refetchInterval: 2_000, refetchIntervalInBackground: false,
    structuralSharing: (previous, incoming) => newerPlan(previous as RuntimeServiceDataDeletionPlan | undefined, incoming as RuntimeServiceDataDeletionPlan) });
  const mutation = useMutation({ mutationFn: (input: DeleteRuntimeServiceData) => runtimeServicesApi.deleteData(service.companyId, service.id, input, { signal: AbortSignal.timeout(20_000) }),
    onSuccess: (plan) => {
      client.setQueryData<RuntimeServiceDataDeletionPlan>(key, (previous) => newerPlan(previous, plan));
      for (const affected of plan.services) client.setQueryData<RuntimeService>(serviceKeys.detail(service.companyId, affected.id), (old) => old &&
        (!old.dataDeletion || (plan.deletion && old.dataDeletion.updatedAt <= plan.deletion.updatedAt)) ? { ...old, dataDeletion: plan.deletion } : old);
      void client.invalidateQueries({ queryKey: serviceKeys.company(service.companyId) });
      attempt.current = null; setConfirmed(false); setMessage(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.status)) {
        attempt.current = null; setConfirmed(false); setMessage(error.message);
      } else setMessage("The deletion request could not be confirmed. Checking its current state; retry uses the same request.");
      void query.refetch();
    } });
  const plan = query.data;
  const deletion = service.dataDeletion && (!plan?.deletion || service.dataDeletion.updatedAt > plan.deletion.updatedAt) ? service.dataDeletion : plan?.deletion;
  useEffect(() => {
    if (!plan) return;
    if (reviewedToken.current && reviewedToken.current !== plan.planToken && !attempt.current && confirmed) {
      setConfirmed(false); setMessage("The workspace changed. Review its current dependencies before confirming again.");
    }
    reviewedToken.current = plan.planToken;
    if (plan.deletion && mutation.isError && attempt.current &&
        (plan.deletion.state !== "failed" || plan.planToken !== attempt.current.planToken)) {
      attempt.current = null; setMessage(null); setConfirmed(false); mutation.reset();
    }
  }, [plan, confirmed, mutation.isError, mutation.reset]);
  if (!canManage && !deletion) return null;
  async function submit() {
    if (submitting.current || !canManage || !plan || (!attempt.current && (!confirmed || plan.blockers.length || query.isError))) return;
    submitting.current = true;
    attempt.current ??= { requestId: crypto.randomUUID(), confirmedAllocationId: plan.allocationId, planToken: plan.planToken, confirm: true };
    try { await mutation.mutateAsync(attempt.current); } catch { /* Feedback and retry identity are preserved above. */ }
    finally { submitting.current = false; }
  }
  return <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-5" aria-labelledby={id}>
    <h2 id={id} className="text-sm font-medium">Workspace data deletion</h2>
    {!open && !deletion ? <>
      <p className="text-xs text-muted-foreground">Stopping a service keeps its files. Review the workspace and its dependencies before permanently deleting data.</p>
      <Button className="self-start" size="sm" variant="outline" onClick={() => setOpen(true)}>Review data deletion</Button>
    </> : <>
      {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading deletion review…</p>}
      {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">The deletion review could not be refreshed.</p><Button className="self-start" size="sm" variant="outline" onClick={() => void query.refetch()}>Refresh deletion review</Button></div>}
      {deletion && <div className="flex flex-col gap-2 text-sm" role="status" aria-live="polite">
        <p className="flex items-center gap-2">{deletion.state === "deleted" ? <Check aria-hidden="true" /> : deletion.state !== "failed" ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
          {deletion.state === "deleted" ? "Workspace data deleted" : deletion.state === "failed" ? "Data deletion needs attention" : "Deleting workspace data…"}</p>
        {deletion.reason === "retention" && <p className="text-xs text-muted-foreground">Requested by company data-retention policy (revision {deletion.policyRevision}). Changing that policy does not cancel an accepted deletion.</p>}
        {deletion.completedAt ? <p className="text-xs text-muted-foreground">Completed {formatDateTime(deletion.completedAt)}. These services cannot be restarted.</p> : <p className="text-xs text-muted-foreground">New runs and service starts are blocked for this workspace. You can leave this page while deletion continues.</p>}
        {deletion.error && <p className="text-xs text-destructive">{deletion.error}</p>}
        {deletion.retryAt && <p className="text-xs text-muted-foreground">Automatic retry scheduled for {formatDateTime(deletion.retryAt)}.</p>}
      </div>}
      {plan && deletion?.state !== "deleted" && <>
        <p className="text-xs text-muted-foreground">{plan.workspace ? `This deletes the task workspace's files, uncommitted changes, dependencies and local application data, removes the listed services, and archives the workspace.${plan.workspace.preservesBranchHistory ? " Shared Git branch history is retained." : ""} Deleted files cannot be recovered through this control.` : plan.scope === "independent_allocation" ? `This removes all source files, dependencies and application data in the shared workspace${plan.includesHostMirror ? ", including its retained host copy" : ""}. It also removes the services listed below. This cannot be undone.` : "The following services use this workspace."}</p>
        {plan.workspace && <p className="text-sm">Workspace: {plan.workspace.name}</p>}
        {!!plan.remoteSandboxes?.length && <div className="flex min-w-0 flex-col gap-1 text-xs">
          <p>Remote sandboxes{plan.includesHostMirror ? " and the retained local checkout will be deleted" : " to delete"}:</p>
          <ul className="flex min-w-0 flex-col gap-1">{plan.remoteSandboxes.map((sandbox) => <li className="break-words" key={`${sandbox.provider}:${sandbox.id}`}>{sandbox.name} · {sandbox.provider}{sandbox.deleted ? " · Deletion confirmed" : ""}</li>)}</ul>
        </div>}
        <ul className="flex flex-col gap-1 text-sm">{plan.services.map((item) => <li key={item.id}><Link className="hover:underline" to={`/runtime-services/${item.id}`}>{item.name}</Link></li>)}</ul>
        {plan.tasks.length > 0 && <div className="flex flex-col gap-1 text-xs"><p>{plan.workspace ? "Linked tasks" : "Attached tasks"}</p>{plan.tasks.map((task) => <Link key={task.id} className="hover:underline" to={`/issues/${task.id}`}>{task.identifier ? `${task.identifier} · ` : ""}{task.title}</Link>)}</div>}
        {!!plan.blockers.length && <ul className="flex flex-col gap-1 text-xs text-muted-foreground">{plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        {canManage && (!deletion || deletion.state === "failed") && <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {!attempt.current && !plan.blockers.length && <div className="flex items-start gap-2"><Checkbox id={`${id}-confirm`} checked={confirmed} disabled={mutation.isPending || query.isError} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor={`${id}-confirm`} className="text-sm">Permanently delete this workspace's data and all listed services.</Label></div>}
          <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" variant="destructive" disabled={mutation.isPending || query.isError || (!attempt.current && (!confirmed || plan.blockers.length > 0))}>
            {mutation.isPending ? "Requesting deletion…" : attempt.current ? "Retry deletion request" : deletion ? "Retry data deletion" : "Delete data permanently"}</Button>
            {!deletion && <Button type="button" size="sm" variant="ghost" disabled={mutation.isPending || !!attempt.current} onClick={() => { setOpen(false); setConfirmed(false); setMessage(null); }}>Cancel</Button>}</div>
        </form>}
      </>}
      {message && <p className="text-xs text-destructive" role="alert">{message}</p>}
    </>}
  </section>;
}
