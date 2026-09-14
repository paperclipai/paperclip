import { useEffect, useId, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { RuntimeService, RuntimeServiceStorageView } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { formatDateTime } from "../lib/utils";
import { Link } from "../lib/router";
import { Button } from "./ui/button";

const reasons = {
  not_provisioned: "The workspace has not been provisioned yet.",
  compute_stopped: "A current measurement is unavailable while the environment is stopped. Checking storage does not start it.",
  unsupported: "This provider does not support workspace storage measurements.",
  measurement_failed: "Storage could not be measured. The last successful measurement is preserved; check again when the workspace is available.",
};
export function serviceStorageSize(bytes: number) {
  const exponent = bytes ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
}
function newerStorage(previous: RuntimeServiceStorageView | undefined, incoming: RuntimeServiceStorageView) {
  return previous?.usage.checkedAt && (incoming.usage.checkedAt ?? "") < previous.usage.checkedAt
    ? { ...incoming, usage: previous.usage } : incoming;
}
export function RuntimeServiceStorage({ service, canManage }: { service: RuntimeService; canManage: boolean }) {
  const id = useId(), client = useQueryClient(), submitting = useRef(false), attemptedAfter = useRef<string | null>(null);
  const key = ["runtime-service-storage", service.companyId, service.id];
  const query = useQuery({ queryKey: key, queryFn: () => runtimeServicesApi.storage(service.companyId, service.id), refetchInterval: 2_000,
    structuralSharing: (previous, incoming) => newerStorage(previous as RuntimeServiceStorageView | undefined, incoming as RuntimeServiceStorageView) });
  const mutation = useMutation({ mutationFn: () => runtimeServicesApi.refreshStorage(service.companyId, service.id),
    onSuccess: (result) => client.setQueryData<RuntimeServiceStorageView>(key, (previous) => newerStorage(previous, result)) });
  useEffect(() => {
    if (mutation.isError && query.data?.usage.checkedAt && query.data.usage.checkedAt > (attemptedAfter.current ?? "")) mutation.reset();
  }, [mutation.isError, query.data?.usage.checkedAt, mutation.reset]);
  const usage = query.data?.usage;
  const expiration = service.retention.expiration;
  return <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-5" aria-labelledby={id}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={id} className="text-sm font-medium">Workspace storage</h2>
      {canManage && <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => {
        if (submitting.current) return;
        submitting.current = true; attemptedAfter.current = usage?.checkedAt ?? null;
        void mutation.mutateAsync().catch(() => {}).finally(() => { submitting.current = false; });
      }}><RefreshCw className={mutation.isPending ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />{mutation.isPending ? "Checking storage…" : "Check storage"}</Button>}</div>
    {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading storage…</p>}
    {(query.isError || mutation.isError) && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">Storage could not be refreshed. Displayed information may be out of date.</p><Button className="self-start" size="sm" variant="outline" onClick={() => void query.refetch()}>Refresh storage details</Button></div>}
    {usage && <div className="flex flex-col gap-1 text-sm" aria-live="polite">
      <p>{usage.bytes === null ? "Storage has not been measured." : serviceStorageSize(usage.bytes)}</p>
      {usage.measuredAt && <p className="text-xs text-muted-foreground">Last measured {formatDateTime(usage.measuredAt)}.</p>}
      {usage.reason && <p className="text-xs text-muted-foreground">{reasons[usage.reason]}</p>}
    </div>}
    {expiration && <div className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Data retention">
      {expiration.state === "disabled" ? <p>Files are kept until explicitly deleted.</p> : <>
        <p>Unused data retention: {expiration.retainedDataSeconds! / 86400} {expiration.retainedDataSeconds === 86400 ? "day" : "days"}.</p>
        {expiration.state === "pending" && <p>Checking workspace dependencies and expiration…</p>}
        {expiration.state === "scheduled" && <p>Eligible for permanent deletion after {formatDateTime(expiration.expiresAt!)} if the workspace remains unused.</p>}
        {expiration.state === "expired" && <p>The retention period has ended. Rechecking dependencies before deletion.</p>}
        {expiration.state === "protected" && <p>Data is protected from automatic deletion.</p>}
        {expiration.blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}
        {expiration.checkedAt && <p>Dependencies last checked {formatDateTime(expiration.checkedAt)}.</p>}
      </>}
    </div>}
    <p className="text-xs text-muted-foreground">Disk space used by this workspace, including source, dependencies and application data. Hard-linked files are counted once; symbolic links are not followed. Other mounted filesystems are excluded. Workspace measurements can overlap and are not the provider’s billing total.</p>
    {query.data && query.data.serviceCount > 1 && <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>This allocation is shared by {query.data.serviceCount} services. Their storage totals refer to the same workspace.</p>
      <ul className="flex flex-col gap-1">{query.data.services.filter((other) => other.id !== service.id).map((other) => <li key={other.id}><Link className="hover:underline" to={`/runtime-services/${other.id}`}>{other.name}</Link></li>)}</ul>
      {query.data.serviceCount > query.data.services.length && <p>Showing the first {query.data.services.length} services.</p>}
    </div>}
  </section>;
}
