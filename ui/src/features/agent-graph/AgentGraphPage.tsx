import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { AgentGraph } from "./AgentGraph";

export function AgentGraphPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const view = useQueryView(agentsQuery);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select an workspace to view the agent graph." />;
  }
  if (view.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={view.error}
        action="load the agent graph"
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  }
  if (!agentsQuery.data) return <PageSkeleton variant="org-chart" />;
  if (agentsQuery.data.length === 0) {
    return <EmptyState icon={Network} message="No agents yet. Create an agent to build the workspace." />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentGraph companyId={selectedCompanyId} agents={agentsQuery.data} className="flex-1" />
    </div>
  );
}
