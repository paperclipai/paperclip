import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Image as ImageIcon, Crown } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function YoutubeThumbnails() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Thumbnails" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Thumbnails</h1>
      <AgnbSubnav group="youtube" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.thumbnails.length === 0 ? (
        <EmptyState icon={ImageIcon} message="No thumbnails." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.thumbnails.map((t) => (
            <div key={t.id} className="overflow-hidden rounded-lg border border-border">
              <img src={t.url} alt={t.concept ?? ""} className="aspect-video w-full object-cover" />
              <div className="flex items-center justify-between gap-2 p-2 text-sm">
                <span className="flex items-center gap-1.5 truncate">{t.is_winner && <Crown className="h-3.5 w-3.5 text-amber-500" />}{t.concept ?? "—"}</span>
                <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  {t.ctr_pct != null && <span className="text-[11px]">{t.ctr_pct}% CTR</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
