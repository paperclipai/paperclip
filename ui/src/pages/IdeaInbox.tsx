import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function IdeaInbox() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "Idea inbox" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.ideaInbox, queryFn: () => researchApi.ideaInbox() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="research" />
      <h1 className="text-lg font-semibold">Idea inbox</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Lightbulb} message="No ideas." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((i) => (
            <div key={i.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span>{i.raw_text}</span>
                <Badge variant="outline">{i.status}</Badge>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{[i.source, i.related_topic, i.created_by].filter(Boolean).join(" · ")} · {relativeTime(i.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
