import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Download, Trash2 } from "lucide-react";
import { agnbPitchApi } from "../api/agnbPitch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";

export function PitchDetail() {
  const { pitchId = "" } = useParams<{ pitchId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const nav = useNavigate();
  const [delBusy, setDelBusy] = useState(false);

  const { data: deck, isLoading, error } = useQuery({
    queryKey: ["agnb", "pitch", pitchId],
    queryFn: () => agnbPitchApi.get(pitchId),
    enabled: !!pitchId,
  });

  useEffect(() => {
    if (deck) setBreadcrumbs([{ label: "Pitch decks", href: "/pitch" }, { label: deck.deck_title }]);
  }, [deck, setBreadcrumbs]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !deck) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{(error as Error)?.message ?? "Deck not found"}</p>
        <Link to="/pitch" className="text-sm text-muted-foreground hover:text-foreground">← Back to pitch decks</Link>
      </div>
    );
  }

  const contentUrl = agnbPitchApi.contentUrl(pitchId);

  const remove = async () => {
    if (!confirm(`Delete "${deck.deck_title}"? This cannot be undone.`)) return;
    setDelBusy(true);
    try {
      await agnbPitchApi.remove(pitchId);
      nav("/pitch");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
      setDelBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Link to="/pitch" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to pitch decks
      </Link>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{deck.deck_title}</h1>
          <p className="text-xs text-muted-foreground">
            {deck.client_name}{deck.vertical ? ` · ${deck.vertical}` : ""} · {deck.slides?.length ?? 0} slides · {deck.created_by}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button asChild variant="outline" size="sm">
            <a href={contentUrl} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-3.5 w-3.5" /> Open</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`${contentUrl}?print-pdf`} target="_blank" rel="noreferrer"><Download className="mr-1 h-3.5 w-3.5" /> PDF</a>
          </Button>
          <Button variant="outline" size="sm" onClick={remove} disabled={delBusy}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <iframe
        src={contentUrl}
        title={deck.deck_title}
        className="h-[680px] w-full rounded-md border border-border bg-white"
        allowFullScreen
      />
    </div>
  );
}
