import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { formatShortDate } from "../lib/utils";

export function EditorialCalendar() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Blog" }, { label: "Calendar" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });

  const dated = (data ?? [])
    .map((d) => ({ ...d, when: d.published_at ?? d.scheduled_at }))
    .filter((d) => d.when)
    .sort((a, b) => new Date(a.when!).getTime() - new Date(b.when!).getTime());
  const backlog = (data ?? []).filter((d) => d.status === "draft" && !d.scheduled_at).length;

  return (
    <div className="space-y-4">
      <AgnbSubnav group="blog" />
      <h1 className="text-lg font-semibold">Editorial calendar</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : dated.length === 0 ? (
        <EmptyState icon={CalendarDays} message="Nothing scheduled." />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{dated.length} scheduled/published · {backlog} unscheduled backlog</p>
          <div className="flex flex-col gap-1">
            {dated.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{formatShortDate(d.when!)}</span>
                  <span className="truncate">{d.title}</span>
                </div>
                <Badge variant={d.published_at ? "default" : "secondary"}>{d.published_at ? "published" : "scheduled"}</Badge>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
