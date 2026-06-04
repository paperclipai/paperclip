import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function YoutubeScripts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Scripts" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Scripts</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.scripts.length === 0 ? (
        <EmptyState icon={FileText} message="No scripts." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Stage</th><th className="p-2 text-right">Duration</th><th className="p-2 text-right">Views</th></tr>
            </thead>
            <tbody>
              {data.scripts.map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="p-2">{s.title}</td>
                  <td className="p-2">{s.status}</td>
                  <td className="p-2 text-right">{s.duration_sec ? `${Math.round(s.duration_sec / 60)}m` : "—"}</td>
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
