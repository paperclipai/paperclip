import { useEffect, useState } from "react";
import { RuntimeServiceTaskWorkspace } from "../components/RuntimeServiceTaskWorkspace";
import { Plus, RefreshCw } from "lucide-react";
import { Link, useParams } from "../lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCanManageRuntimeServices, useRuntimeService, useRuntimeServices } from "../hooks/useRuntimeServices";
import { RuntimeServiceControls, RuntimeServicePolicyEditor } from "../components/RuntimeServiceControls";
import { RuntimeServiceCompanyPolicyEditor } from "../components/RuntimeServiceCompanyPolicy";
import { CreateRuntimeServiceForm } from "../components/CreateRuntimeServiceForm";
import { RuntimeServiceSharing } from "../components/RuntimeServiceSharing";
import { RuntimeServiceEnvironmentEditor } from "../components/RuntimeServiceEnvironment";
import { RuntimeServiceStorage } from "../components/RuntimeServiceStorage";
import { RuntimeServiceDataDeletion } from "../components/RuntimeServiceDataDeletion";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

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
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex flex-col gap-1"><h1 className="text-xl font-semibold">Services</h1><p className="text-sm text-muted-foreground">Development previews and workers that continue after an agent finishes.</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />Refresh</Button>{canManage && <Button size="sm" onClick={() => setCreating(!creating)}><Plus aria-hidden="true" />New service</Button>}</div></div>
      {canManage && <RuntimeServiceCompanyPolicyEditor key={`policy-${selectedCompanyId}`} companyId={selectedCompanyId} />}
      {creating && canManage && <CreateRuntimeServiceForm key={selectedCompanyId} companyId={selectedCompanyId} onClose={() => setCreating(false)} />}
      {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading services…</p>}
      {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">Services could not be refreshed. Displayed states may be out of date.</p><Button className="self-start" size="sm" variant="outline" onClick={() => void query.refetch()}>Retry</Button></div>}
      {!!query.data?.length && <Input className="max-w-sm" aria-label="Find a service" placeholder="Find a service…" value={search} onChange={(event) => setSearch(event.target.value)} />}
      {query.isSuccess && services.length === 0 && <p className="text-sm text-muted-foreground">{query.data.length ? "No services match this search." : "No services yet. Ask an agent to run an app, or create a service here."}</p>}
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        {services.map((service) => <div key={service.id} className="flex min-w-0 flex-col gap-3 border-b border-border pb-5"><RuntimeServiceControls service={service} canManage={canManage} stale={query.isError} />{service.issueId && <Link className="self-start text-xs text-muted-foreground hover:underline" to={`/issues/${service.issueId}`}>Associated task</Link>}</div>)}
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
    <div className="flex min-w-0 max-w-3xl flex-col gap-6">
      {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading service…</p>}
      {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-sm text-destructive">{query.error.message}</p><Button size="sm" variant="outline" className="self-start" onClick={() => void query.refetch()}>Refresh service</Button></div>}
      {query.data && <>
        <RuntimeServiceControls key={`controls:${query.data.id}`} service={query.data} canManage={canManage} stale={query.isError} detail />
        {canManage && !query.data.dataDeletion && <RuntimeServiceTaskWorkspace key={`task:${query.data.id}`} service={query.data} disabled={query.isError} />}
        {canManage && !query.data.dataDeletion && <RuntimeServicePolicyEditor key={`policy:${query.data.id}`} service={query.data} disabled={query.isError} />}
        {canManage && !query.data.dataDeletion && <RuntimeServiceEnvironmentEditor key={`environment:${query.data.id}`} service={query.data} disabled={query.isError} />}
        {canManage && query.data.endpoints.some((endpoint) => endpoint.url) && <RuntimeServiceSharing key={`sharing:${query.data.id}`} service={query.data} disabled={query.isError} />}
        {!query.data.dataDeletion && <RuntimeServiceStorage key={`storage:${query.data.id}`} service={query.data} canManage={canManage} />}
        <RuntimeServiceDataDeletion key={`deletion:${query.data.id}`} service={query.data} canManage={canManage} />
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          {query.data.issueId && !query.data.taskWorkspace && <Link to={`/issues/${query.data.issueId}`} className="self-start hover:underline">Associated task</Link>}
          {!query.data.dataDeletion && <><p>{query.data.retention.state === "retained" ? "Source files and application data are retained when compute stops." : "Data retention is awaiting verification."}</p><p>Automatic crash retries: {query.data.restartCount} of {query.data.policy.restartAttempts}.</p></>}
        </div>
      </>}
    </div>
  );
}
