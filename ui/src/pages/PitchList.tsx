import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Presentation, Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { agnbPitchApi } from "../api/agnbPitch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function PitchList() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pitch decks" }]), [setBreadcrumbs]);

  const { data: decks, isLoading, error } = useQuery({
    queryKey: ["agnb", "pitch", "list"],
    queryFn: () => agnbPitchApi.list(),
  });

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Pitch decks</h1>
          <p className="text-sm text-muted-foreground">
            AI-generated, on-brand Finn decks — real pricing, computed ROI, real proof.
            Generated locally via the Claude CLI; viewable anywhere.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/pitch/new">
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New pitch
          </Link>
        </Button>
      </div>

      <AgnbSubnav group="assets" />

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {(decks?.length ?? 0) === 0 ? (
        <EmptyState icon={Presentation} message="No pitch decks yet. Generate one →" />
      ) : (
        <div className="flex flex-col gap-2">
          {decks!.map((d) => (
            <Link key={d.id} to={`/pitch/${d.id}`} className="block">
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{d.deck_title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {d.client_name}
                      {d.vertical ? ` · ${d.vertical}` : ""} · {d.created_by}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    {relativeTime(d.updated_at)}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
