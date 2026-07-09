import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, LayoutDashboard } from "lucide-react";

import { briefsApi } from "@/api/briefs";
import { ApiError } from "@/api/client";
import { BuiltInAgentGate } from "@/components/BuiltInAgentGate";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function BriefsOverviewPanel({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.briefs.overview(companyId),
    queryFn: () => briefsApi.overview(companyId),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;

  if (error instanceof ApiError && error.status === 412) {
    return <BuiltInAgentGate agentKey="briefs" companyId={companyId} featureLabel="Briefs" error={error} />;
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load Briefs."}
      </p>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-5">
      {data.warning ? (
        <p className="text-sm text-destructive">{data.warning.message}</p>
      ) : null}
      <div className="grid border-y border-border sm:grid-cols-3">
        {data.summaryItems.map((item) => (
          <div key={item.label} className="space-y-1 border-b border-border py-3 sm:border-b-0 sm:border-r sm:px-4 first:sm:pl-0 last:sm:border-r-0 last:sm:pr-0">
            <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
            <p className="truncate text-sm font-medium">
              {item.label === "Last checked" ? formatCheckedAt(item.value) : item.value}
            </p>
            {item.detail ? (
              <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Latest Brief</h2>
        <div className="border-y border-border">
          <EmptyState
            icon={FileText}
            title="No briefs yet"
            message="New company briefs will appear here when generated."
          />
        </div>
      </section>
    </div>
  );
}

export function Briefs() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Briefs" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
        />
      );
    }
    return <EmptyState icon={FileText} message="Select a company to view briefs." />;
  }

  return (
    <div className="w-full max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Briefs</h1>
      </div>
      <BuiltInAgentGate agentKey="briefs" companyId={selectedCompanyId} featureLabel="Briefs">
        <BriefsOverviewPanel companyId={selectedCompanyId} />
      </BuiltInAgentGate>
    </div>
  );
}
