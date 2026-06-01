import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListOrdered, ExternalLink } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "posted" || s === "published") return "default";
  if (s === "scheduled" || s === "queued" || s === "ready-to-post-manual") return "secondary";
  if (s === "failed") return "destructive";
  return "outline";
}

export function LinkedinQueuePage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Queue" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liQueue, queryFn: () => linkedinQueueApi.queue() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <h1 className="text-lg font-semibold">Queue</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ListOrdered} message="Queue empty." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={tone(r.status)}>{r.status}</Badge>
                {r.source_type && <span className="text-[11px] text-muted-foreground">{r.source_type}</span>}
                {r.linkedin_post_url && <a href={r.linkedin_post_url} target="_blank" rel="noreferrer" className="ml-auto text-muted-foreground hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{r.content}</p>
              <div className="mt-1 text-[11px] text-muted-foreground">{r.scheduled_at ? `sched ${relativeTime(r.scheduled_at)}` : r.posted_at ? `posted ${relativeTime(r.posted_at)}` : "—"}{r.error_message ? ` · ${r.error_message}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
