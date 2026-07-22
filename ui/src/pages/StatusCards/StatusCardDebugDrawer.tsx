import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { InlineBanner } from "@/components/InlineBanner";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import type { StatusCardView } from "./types";

/**
 * Temporary debug surface (plan §5). Exposes the raw interest → compiled-query
 * pipeline that is normally hidden: the source-of-truth interest text, the
 * agent-maintained compiled query JSON + version, and an advanced raw view.
 * Dry-run + direct query authoring arrive with P2; those affordances are shown
 * disabled with a note until the endpoints exist.
 */
export function StatusCardDebugDrawer({
  card,
  open,
  onOpenChange,
}: {
  card: StatusCardView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [interest, setInterest] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (card) setInterest(card.interestPrompt);
  }, [card]);

  const recompileMutation = useMutation({
    mutationFn: (nextInterest: string) => statusCardsApi.patch(card!.id, { interestPrompt: nextInterest }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      if (!card) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.detail(card.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(card.companyId, false) }),
      ]);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not recompile the query."),
  });

  if (!card) return null;

  const queryJson = JSON.stringify({ queries: card.queries, limit: 50 }, null, 2);
  const interestDirty = interest.trim() !== card.interestPrompt.trim();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-lg">Query debug</SheetTitle>
            <Badge variant="secondary">DEBUG · TEMP</Badge>
          </div>
          <SheetDescription>
            {card.title ?? "Untitled card"} — the compiled query is normally hidden.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 p-4">
          {error ? <InlineBanner tone="danger" title="Recompile failed">{error}</InlineBanner> : null}

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Human interest text (source of truth)
            </h3>
            <Textarea value={interest} onChange={(event) => setInterest(event.target.value)} rows={3} className="text-sm" />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Edit this text → the agent recompiles the query and re-titles the card.
              </p>
              <Button
                size="sm"
                onClick={() => recompileMutation.mutate(interest.trim())}
                disabled={!interestDirty || interest.trim().length === 0 || recompileMutation.isPending}
              >
                {recompileMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                Save &amp; recompile
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compiled query (agent-maintained, v{card.queryVersion})
            </h3>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
              {card.queries.length > 0 ? queryJson : "// query not compiled yet"}
            </pre>
            <p className="text-xs text-muted-foreground">
              {card.queryCompiledAt
                ? `compiled by Summarizer · ${relativeTime(card.queryCompiledAt)} · query version ${card.queryVersion}`
                : "not yet compiled"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => recompileMutation.mutate(card.interestPrompt)}
                disabled={recompileMutation.isPending}
              >
                Recompile
              </Button>
              <Button variant="outline" size="sm" disabled title="Available when the P2 compile pipeline lands">
                Dry run
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRaw((value) => !value)}>
                {showRaw ? "Hide raw JSON" : "Edit JSON (adv)"}
              </Button>
            </div>
            {showRaw ? (
              <div className="space-y-1">
                <Textarea value={queryJson} readOnly rows={8} className="font-mono text-xs" aria-label="Raw compiled query JSON" />
                <p className="text-xs text-muted-foreground">
                  Direct query authoring is agent-level and lands with P2 — read-only here for now.
                </p>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dry run</h3>
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              Live dry-run matching arrives with the P2 compile pipeline. Until then the compiled query above is the
              source of truth for what the card watches.
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
