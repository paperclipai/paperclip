import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function YoutubeShorts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Shorts mill" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Shorts mill</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.shorts.length === 0 ? (
        <EmptyState icon={Clapperboard} message="No shorts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Status</th><th className="p-2 text-right">Dur</th><th className="p-2">IG</th><th className="p-2 text-right">Views</th></tr>
            </thead>
            <tbody>
              {data.shorts.map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="p-2">{s.title}</td>
                  <td className="p-2">{s.status}</td>
                  <td className="p-2 text-right">{s.duration_sec ? `${s.duration_sec}s` : "—"}</td>
                  <td className="p-2">{s.cross_post_ig ? "✓" : "—"}</td>
                  <td className="p-2 text-right">{s.views ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
