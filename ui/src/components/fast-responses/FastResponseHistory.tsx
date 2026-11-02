import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { fastResponsesApi } from "@/api/fast-responses";
import { DecisionHistoryTable } from "@/components/decision-models/DecisionHistory";
import { Button } from "@/components/ui/button";
import { useFastResponsesEnabled } from "@/hooks/useFastResponsesEnabled";
export function FastResponseHistory({
  companyId,
  from,
  to,
}: {
  companyId: string;
  from?: string | null;
  to?: string | null;
}) {
  useTranslation();
  const { enabled } = useFastResponsesEnabled();
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
      <p className="text-sm text-muted-foreground">{t("oct19Core.newSurface078")}</p>
    );
  if (query.error)
    return (
      <div role="alert">
        <p className="text-sm text-destructive">
          {t("oct19Core.newSurface079")}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("oct19Core.tryAgain")}
        </Button>
      </div>
    );
  return <DecisionHistoryTable entries={query.data ?? []} fastResponse fastResponsesEnabled={enabled} />;
}
