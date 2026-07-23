import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
 * agent-maintained compiled query JSON + version, an advanced raw view, and an
 * on-demand dry run that executes the compiled queries against live data.
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
  const [dryRunRequested, setDryRunRequested] = useState(false);

  useEffect(() => {
    if (card) {
      setInterest(card.interestPrompt);
      setDryRunRequested(false);
    }
  }, [card]);

  const dryRunQuery = useQuery({
    queryKey: card ? queryKeys.statusCards.dryRun(card.id) : ["status-cards", "detail", "none", "dry-run"],
    queryFn: () => statusCardsApi.dryRun(card!.id),
    enabled: Boolean(card && open && dryRunRequested && card.queries.length > 0),
  });

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
            {card.queryVersion > 1 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>query history</span>
                {Array.from({ length: card.queryVersion }, (_, index) => card.queryVersion - index).map((version) => (
                  <span
                    key={version}
                    className={
                      version === card.queryVersion
                        ? "rounded bg-muted px-1.5 py-0.5 font-medium text-foreground"
                        : "rounded px-1.5 py-0.5"
                    }
                    title={version === card.queryVersion ? "current compiled query" : "earlier compiled version"}
                  >
                    v{version}
                  </span>
                ))}
                <span className="text-muted-foreground/70">· only the current compiled version is stored and inspectable</span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => recompileMutation.mutate(card.interestPrompt)}
                disabled={recompileMutation.isPending}
              >
                Recompile
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => (dryRunRequested ? dryRunQuery.refetch() : setDryRunRequested(true))}
                disabled={card.queries.length === 0 || dryRunQuery.isFetching}
                title={card.queries.length === 0 ? "Compile the query first" : "Execute the compiled queries now"}
              >
                {dryRunQuery.isFetching ? <Loader2 className="animate-spin" /> : null}
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
                  The compiled query is agent-maintained (the Summarizer writes it from its generation task) — read-only here.
                </p>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dry run</h3>
            {!dryRunRequested ? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                {card.queries.length === 0
                  ? "The query has not compiled yet — dry run becomes available once compilation finishes."
                  : "Run a dry run to see which issues the compiled query matches right now."}
              </div>
            ) : dryRunQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Executing compiled queries…
              </div>
            ) : dryRunQuery.isError ? (
              <InlineBanner tone="danger" title="Dry run failed">
                {dryRunQuery.error instanceof Error ? dryRunQuery.error.message : "Try again."}
              </InlineBanner>
            ) : (
              <div className="space-y-3">
                {(dryRunQuery.data?.queries ?? []).map(({ result }, index) => (
                  <div key={index} className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      Query {index + 1} · {result.results.length} {result.results.length === 1 ? "match" : "matches"}
                      {result.hasMore ? " (more beyond the query limit)" : ""}
                    </p>
                    {result.results.length > 0 ? (
                      <ul className="space-y-1 rounded-md bg-muted p-3 text-xs">
                        {result.results.map((item) => (
                          <li key={item.id} className="flex items-center gap-2">
                            <span className="shrink-0 font-medium text-muted-foreground">
                              {item.issue?.identifier ?? item.type}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                            {item.issue ? <span className="shrink-0 text-muted-foreground">{item.issue.status}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
