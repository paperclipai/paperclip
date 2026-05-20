import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Workflow } from "lucide-react";
import { ApiError } from "../api/client";
import { heartbeatsApi } from "../api/heartbeats";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunDetailNarrativeView } from "../components/run-detail/RunDetailNarrativeView";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { useParams, useSearchParams } from "@/lib/router";
import { nav, orchestrationInjectionPage } from "../lib/i18n";
import { RUN_LIST_PATH } from "../lib/run-routes";

const LEGACY_TAB_HASH: Record<string, string> = {
  enqueue: "source",
  input: "input",
  finalPrompt: "input",
  execution: "execution",
  record: "outcome",
};

const LEGACY_TAB_EXPERT: Record<string, string> = {
  finalPrompt: "prompt",
};

export function OrchestrationInjectionRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    const detailLabel =
      runId && runId.length >= 8
        ? orchestrationInjectionPage.runDetailBreadcrumb(`${runId.slice(0, 8)}…`)
        : orchestrationInjectionPage.runDetailTitle;
    setBreadcrumbs([
      { label: nav.work },
      { label: nav.orchestrationInjection, href: RUN_LIST_PATH },
      { label: detailLabel },
    ]);
  }, [setBreadcrumbs, runId]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (!tab) return;
    const hash = LEGACY_TAB_HASH[tab];
    const expert = LEGACY_TAB_EXPERT[tab];
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("tab");
        if (expert) next.set("expert", expert);
        return next;
      },
      { replace: true },
    );
    if (hash) {
      window.requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [searchParams, setSearchParams]);

  const runDetailQuery = useQuery({
    queryKey: runId ? queryKeys.runDetail(runId) : ["heartbeat-run", "none", "detail"],
    queryFn: () => heartbeatsApi.get(runId!),
    enabled: Boolean(selectedCompanyId && runId),
    retry: (_count, err) => !(err instanceof ApiError && err.status === 404),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Workflow} message={orchestrationInjectionPage.selectCompany} />;
  }

  if (!runId) {
    return (
      <div className="text-sm text-destructive">{orchestrationInjectionPage.failedToLoad}</div>
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
