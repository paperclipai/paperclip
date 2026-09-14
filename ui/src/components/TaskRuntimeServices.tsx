import { Link } from "../lib/router";
import { useCanManageRuntimeServices, useRuntimeServices } from "../hooks/useRuntimeServices";
import { RuntimeServiceControls } from "./RuntimeServiceControls";
import { Button } from "./ui/button";
import { PropertySection } from "./issue-properties/primitives";

export function TaskRuntimeServices({ companyId, issueId, streamlined = false }: {
  companyId: string; issueId: string; streamlined?: boolean;
}) {
  const query = useRuntimeServices(companyId, issueId);
  const canManage = useCanManageRuntimeServices(companyId);
  // Keep the pane quiet when no service has been created, but never hide a
  // discovery failure as an empty list.
  if (query.isSuccess && query.data.length === 0) return null;
  return (
    <PropertySection title="Services" streamlined={streamlined}>
      <div className="flex min-w-0 flex-col gap-4">
        {query.isPending && <p className="text-xs text-muted-foreground" role="status">Loading services…</p>}
        {query.isError && <div className="flex flex-col gap-2" role="alert"><p className="text-xs text-destructive">Services could not be refreshed. Displayed states may be out of date.</p><Button className="self-start" variant="outline" size="sm" onClick={() => void query.refetch()}>Refresh services</Button></div>}
        {query.data?.map((service) => <RuntimeServiceControls key={service.id} service={service} canManage={canManage} stale={query.isError} />)}
        <Link to="/runtime-services" className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline">All company services</Link>
      </div>
    </PropertySection>
  );
}
