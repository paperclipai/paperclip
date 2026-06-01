import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Recycle } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function LinkedinRepurpose() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Repurpose" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <h1 className="text-lg font-semibold">Repurpose</h1>
      <p className="text-xs text-muted-foreground">Pick a blog to extract LinkedIn posts from (AI extract action — coming soon).</p>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Recycle} message="No blogs to repurpose." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.slice(0, 30).map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="truncate">{d.title}</span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground"><Badge variant="outline">{d.status}</Badge>{relativeTime(d.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
