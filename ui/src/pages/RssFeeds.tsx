import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rss, ExternalLink } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function RssFeeds() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "RSS" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.rssFeeds, queryFn: () => researchApi.rssFeeds() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="research" />
      <h1 className="text-lg font-semibold">RSS feeds</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Rss} message="No feeds." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Feeds ({data.feeds.length})</h2>
          <div className="flex flex-wrap gap-2">
            {data.feeds.map((f) => (
              <Badge key={f.id} variant="outline">{f.name} · {f.items_count ?? 0}</Badge>
            ))}
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Latest items ({data.items.length})</h2>
          <div className="flex flex-col gap-1">
            {data.items.map((it) => (
              <a key={it.id} href={it.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/40">
                <span className="truncate">{it.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">{it.feed_name} · {it.published_at ? relativeTime(it.published_at) : ""}<ExternalLink className="h-3 w-3" /></span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
