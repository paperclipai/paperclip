import { useEffect, useState } from "react";
import { RuntimeServiceTaskWorkspace } from "../components/RuntimeServiceTaskWorkspace";
import { Plus, RefreshCw, Search, Server } from "lucide-react";
import { Link, useParams } from "../lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCanManageRuntimeServices, useRuntimeService, useRuntimeServices } from "../hooks/useRuntimeServices";
import { RuntimeServiceControls, RuntimeServicePolicyEditor, servicePolicyLabel } from "../components/RuntimeServiceControls";
import { RuntimeServiceCompanyPolicyEditor } from "../components/RuntimeServiceCompanyPolicy";
import { CreateRuntimeServiceForm } from "../components/CreateRuntimeServiceForm";
import { RuntimeServiceSharing } from "../components/RuntimeServiceSharing";
import { RuntimeServiceEnvironmentEditor } from "../components/RuntimeServiceEnvironment";
import { RuntimeServiceStorage } from "../components/RuntimeServiceStorage";
import { RuntimeServiceDataDeletion } from "../components/RuntimeServiceDataDeletion";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/ui/skeleton";
import { formatDateTime } from "../lib/utils";

export function RuntimeServices() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const query = useRuntimeServices(selectedCompanyId);
  const canManage = useCanManageRuntimeServices(selectedCompanyId);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => { setBreadcrumbs([{ label: "Services" }]); }, [setBreadcrumbs]);
  useEffect(() => { setCreating(false); setSearch(""); }, [selectedCompanyId]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company to see its services.</p>;
  const services = query.data?.filter((service) => service.name.toLowerCase().includes(search.toLowerCase())) ?? [];
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex flex-col gap-1"><h1 className="text-xl font-bold">Services</h1><p className="text-sm text-muted-foreground">Apps and workers that keep running after an agent finishes.</p></div><div className="flex shrink-0 gap-2"><Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />Refresh</Button>{canManage && <Button size="sm" onClick={() => setCreating(!creating)}><Plus aria-hidden="true" />New service</Button>}</div></div>
      {canManage && <RuntimeServiceCompanyPolicyEditor key={`policy-${selectedCompanyId}`} companyId={selectedCompanyId} />}
      {creating && canManage && <CreateRuntimeServiceForm key={selectedCompanyId} companyId={selectedCompanyId} onClose={() => setCreating(false)} />}
      {query.isPending && <div role="status" className="flex flex-col divide-y divide-border"><span className="sr-only">Loading services…</span>{[0, 1, 2].map((row) => <div key={row} className="flex items-center justify-between gap-4 py-5"><div className="flex flex-col gap-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-52" /></div><Skeleton className="h-8 w-24" /></div>)}</div>}
      {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">Services could not be refreshed. Displayed states may be out of date.</p><Button className="self-start" size="sm" variant="outline" onClick={() => void query.refetch()}>Retry</Button></div>}
      {!!query.data?.length && <div className="flex items-center justify-between gap-3"><div className="relative min-w-0 max-w-sm flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input className="pl-9" aria-label="Find a service" placeholder="Find a service…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><span className="shrink-0 text-xs text-muted-foreground">{services.length} {services.length === 1 ? "service" : "services"}</span></div>}
      {query.isSuccess && services.length === 0 && <EmptyState icon={Server} title={query.data.length ? "No matching services" : "Keep your work running"} message={query.data.length ? "Try another name or clear your search." : "Ask an agent to run an app, or create a service to start a preview or background worker."} action={query.data.length ? "Clear search" : canManage && !creating ? "New service" : undefined} hideActionIcon={!!query.data.length} onAction={() => query.data.length ? setSearch("") : setCreating(true)} />}
      <div className="flex min-w-0 flex-col divide-y divide-border border-t border-border empty:hidden">
        {services.map((service) => <div key={service.id} className="min-w-0 py-5"><RuntimeServiceControls service={service} canManage={canManage} stale={query.isError} list /></div>)}
      </div>
    </div>
  );
}

export function RuntimeServiceDetail() {
  const { selectedCompanyId } = useCompany();
  const { serviceId } = useParams<{ serviceId: string }>();
  const query = useRuntimeService(selectedCompanyId, serviceId);
  const canManage = useCanManageRuntimeServices(selectedCompanyId);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Services", href: "/runtime-services" }, { label: query.data?.name ?? "Service" }]); }, [setBreadcrumbs, query.data?.name]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select the company that owns this service.</p>;
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-8">
      {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading service…</p>}
      {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">{query.error.message}</p><Button size="sm" variant="outline" className="self-start" onClick={() => void query.refetch()}>Refresh service</Button></div>}
      {query.data && <>
        <RuntimeServiceControls key={`controls:${query.data.id}`} service={query.data} canManage={canManage} stale={query.isError} detail />
        {!query.data.dataDeletion && <div className="flex min-w-0 flex-col gap-5">
          <h2 className="text-sm font-semibold">Runtime</h2>
          <div className="flex min-w-0 flex-col divide-y divide-border border-t border-border empty:hidden">
            {!canManage && <div className="flex flex-col gap-1 py-4"><h3 className="text-sm font-medium">Lifetime</h3><p className="text-xs text-muted-foreground">{servicePolicyLabel(query.data)}</p></div>}
            {canManage && <RuntimeServicePolicyEditor key={`policy:${query.data.id}`} service={query.data} disabled={query.isError} />}
            {canManage && <RuntimeServiceEnvironmentEditor key={`environment:${query.data.id}`} service={query.data} disabled={query.isError} />}
            {canManage && <RuntimeServiceTaskWorkspace key={`task:${query.data.id}`} service={query.data} disabled={query.isError} />}
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {query.data.issueId && !query.data.taskWorkspace && <Link to={`/issues/${query.data.issueId}`} className="self-start hover:text-foreground hover:underline">Associated task</Link>}
            <p>Automatic crash retries: <span className="font-mono">{query.data.restartCount} of {query.data.policy.restartAttempts}</span>.</p>
            {query.data.purpose === "preview" && query.data.endpoints.some((endpoint) => endpoint.url) && <p>{query.data.previewActivity?.lastSignalAt ? `Browser activity last received ${formatDateTime(query.data.previewActivity.lastSignalAt)}.` : "Waiting for browser activity. App security policies can prevent activity signals; use the lifetime controls if needed."}</p>}
            {query.data.retention.state !== "retained" && <p>Data retention is awaiting verification.</p>}
          </div>
        </div>}
        {canManage && query.data.endpoints.some((endpoint) => endpoint.url) && <RuntimeServiceSharing key={`sharing:${query.data.id}`} service={query.data} disabled={query.isError} />}
        {!query.data.dataDeletion && <RuntimeServiceStorage key={`storage:${query.data.id}`} service={query.data} canManage={canManage} />}
        <RuntimeServiceDataDeletion key={`deletion:${query.data.id}`} service={query.data} canManage={canManage} />
      </>}
    </div>
  );
}
