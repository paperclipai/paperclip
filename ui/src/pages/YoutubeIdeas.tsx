import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { youtubeApi } from "../api/agnbYoutube";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function YoutubeIdeas() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Ideas" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.youtube, queryFn: () => youtubeApi.all() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Ideas</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.ideas.length === 0 ? (
        <EmptyState icon={Lightbulb} message="No ideas." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.ideas.map((i) => (
            <Card key={i.id}><CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{i.title}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <Badge variant="outline">{i.status}</Badge>
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{[i.source, i.est_views ? `~${i.est_views} views` : null, i.score != null ? `score ${i.score}` : null].filter(Boolean).join(" · ")}</div>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
