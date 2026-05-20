import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Workflow } from "lucide-react";
import { ApiError } from "@/api/client";
import { heartbeatsApi } from "@/api/heartbeats";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { RunDetailNarrativeView } from "@/components/run-detail/RunDetailNarrativeView";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { nav, orchestrationInjectionPage } from "@/lib/i18n";
import { RUN_LIST_PATH } from "@/lib/run-routes";
import { Button } from "@/components/ui/button";

export function RunDetailNarrativePreview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("runId")?.trim() ?? "";

  useEffect(() => {
    const detailLabel = runId
      ? orchestrationInjectionPage.runDetailBreadcrumb(`${runId.slice(0, 8)}…`)
      : "运行详情叙事流 · 预览";
    setBreadcrumbs([
      { label: nav.work },
      { label: nav.orchestrationInjection, href: RUN_LIST_PATH },
      { label: detailLabel },
    ]);
  }, [setBreadcrumbs, runId]);

  const runDetailQuery = useQuery({
    queryKey: runId ? queryKeys.runDetail(runId) : ["heartbeat-run", "preview", "none"],
    queryFn: () => heartbeatsApi.get(runId),
    enabled: Boolean(selectedCompanyId && runId),
    retry: (_count, err) => !(err instanceof ApiError && err.status === 404),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message={orchestrationInjectionPage.selectCompany} />;
  }

  if (!runId) {
    return (
      <div className="mx-auto max-w-lg space-y-4 rounded-md border border-border p-6">
        <p className="text-sm text-muted-foreground">
          设计预览需指定真实运行 ID。在 URL 追加{" "}
          <code className="font-mono text-xs">?runId=&lt;uuid&gt;</code>，或从运行清单进入。
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to={RUN_LIST_PATH}>打开运行清单</Link>
        </Button>
      </div>
    );
  }

  if (runDetailQuery.isLoading && !runDetailQuery.data) {
    return <PageSkeleton variant="list" />;
  }

  if (runDetailQuery.isError) {
    const err = runDetailQuery.error;
    const is404 = err instanceof ApiError && err.status === 404;
    return (
      <EmptyState
        icon={FileText}
        message={
          is404
            ? orchestrationInjectionPage.runNotFound
            : err instanceof Error
              ? err.message
              : orchestrationInjectionPage.failedToLoad
        }
      />
    );
  }

  const run = runDetailQuery.data;
  if (!run) {
    return <PageSkeleton variant="list" />;
  }

  return <RunDetailNarrativeView run={run} />;
}
