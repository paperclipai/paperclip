import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { researchApi, type ContentBrief } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

const STAGES = ["idea", "briefed", "drafting", "review", "published", "killed"];

export function ContentBriefs() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "Briefs" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.content, queryFn: () => researchApi.content() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="research" />
      <h1 className="text-lg font-semibold">Content briefs</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={FileText} message="No briefs." />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((stage) => {
            const items: ContentBrief[] = data.filter((b) => b.stage === stage);
            return (
              <div key={stage} className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/30">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-sm font-medium capitalize">{stage}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {items.map((b) => (
                    <div key={b.id} className="rounded-md border border-border bg-background p-2 text-sm">
                      <div className="font-medium">{b.title}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{b.content_type}{b.primary_keyword ? ` · ${b.primary_keyword}` : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
