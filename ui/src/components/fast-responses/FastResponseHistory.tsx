import { useQuery } from "@tanstack/react-query";
import { fastResponsesApi } from "@/api/fast-responses";
import { DecisionHistoryTable } from "@/components/decision-models/DecisionHistory";
import { Button } from "@/components/ui/button";
export function FastResponseHistory({
  companyId,
  from,
  to,
}: {
  companyId: string;
  from?: string | null;
  to?: string | null;
}) {
  const query = useQuery({
    queryKey: ["fast-response-history", companyId, from, to],
    queryFn: () =>
      fastResponsesApi.history(companyId, from ?? undefined, to ?? undefined),
    refetchInterval: (q) =>
      q.state.data?.some(
        (r) =>
          ["pending", "running"].includes(r.status) ||
          ["pending", "streaming", "retry"].includes(r.publicationStatus),
      )
        ? 3000
        : false,
  });
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground">Loading fast responses…</p>
    );
  if (query.error)
    return (
      <div role="alert">
        <p className="text-sm text-destructive">
          Could not load fast responses.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  return <DecisionHistoryTable entries={query.data ?? []} fastResponse />;
}
