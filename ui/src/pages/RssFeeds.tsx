import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Rss, ExternalLink, Trash2 } from "lucide-react";
import { researchApi } from "../api/agnbResearch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function RssFeeds() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Research" }, { label: "RSS" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.rssFeeds, queryFn: () => researchApi.rssFeeds() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.rssFeeds });
  const del = async (id: string) => { await researchApi.deleteFeed(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">RSS feeds</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add feed</Button>
      </div>
      <AgnbSubnav group="research" />
      {open && (
        <AgnbFormModal
          title="Add RSS feed"
          fields={[{ key: "name", label: "Name", required: true }, { key: "url", label: "Feed URL", required: true }, { key: "category", label: "Category" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await researchApi.addFeed({ name: v.name, url: v.url, category: v.category || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Rss} message="No feeds." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Feeds ({data.feeds.length})</h2>
          <div className="flex flex-col gap-1">
            {data.feeds.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span>{f.name} <span className="text-[11px] text-muted-foreground">· {f.items_count ?? 0} items</span></span>
                <button onClick={() => del(f.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
              </div>
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
