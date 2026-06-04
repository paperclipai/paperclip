import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Trash2 } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function Reviews() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Reviews radar" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.reviews, queryFn: () => mentionsApi.reviews() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.reviews });
  const delPlatform = async (id: string) => { if (confirm("Stop tracking this platform?")) { await mentionsApi.deleteReviewPlatform(id).catch(() => {}); refresh(); } };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reviews radar</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Track platform</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="Track a review platform"
          fields={[{ key: "platform", label: "Platform", required: true, placeholder: "G2" }, { key: "profile_url", label: "Profile URL", required: true, placeholder: "https://g2.com/products/..." }, { key: "category", label: "Category", placeholder: "optional" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await mentionsApi.addReviewPlatform({ platform: v.platform, profile_url: v.profile_url, category: v.category || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data ? (
        <EmptyState icon={Star} message="No data." />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {data.platforms.map((p) => (
              <Card key={p.id}><CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="font-medium">{p.platform}</div>
                  <button onClick={() => delPlatform(p.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
                </div>
                <div className="text-xl font-semibold">{p.rating != null ? `${Number(p.rating).toFixed(2)} ★` : "—"}</div>
                <div className="text-[11px] text-muted-foreground">{p.review_count ?? 0} reviews{p.ranked_position ? ` · #${p.ranked_position}` : ""}</div>
              </CardContent></Card>
            ))}
          </div>
          <h2 className="text-sm font-medium text-muted-foreground">Recent reviews</h2>
          <div className="flex flex-col gap-1">
            {data.log.map((r) => (
              <div key={r.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center gap-2"><Badge variant="outline">{r.platform}</Badge>{r.rating != null && <span>{r.rating} ★</span>}<span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(r.collected_at)}</span></div>
                {r.excerpt && <p className="mt-1 text-xs text-muted-foreground">{r.excerpt}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
