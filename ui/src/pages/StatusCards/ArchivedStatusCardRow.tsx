import { t as translateShell, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { formatCents, formatTokens, rollupUpdates } from "./format";
import type { StatusCardView } from "./types";

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ArchivedStatusCardRow({
  card,
  onView,
  onRestore,
  restorePending,
}: {
  card: StatusCardView;
  onView: () => void;
  onRestore: () => void;
  restorePending?: boolean;
}) {
  const { t: translateShell } = useTranslation("shell");
  // Lifetime cost is a rollup of the card's full update ledger (live P1 data).
  const updatesQuery = useQuery({
    queryKey: queryKeys.statusCards.updates(card.id),
    queryFn: () => statusCardsApi.updates(card.id),
  });
  const rollup = updatesQuery.data ? rollupUpdates(updatesQuery.data) : null;

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{card.title ?? translateShell("shell:untitled_card")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground" title={card.archivedAt ? formatDateTime(card.archivedAt) : undefined}>{translateShell("shell:archived")}{" "}{shortDate(card.archivedAt)}{" "}{translateShell("shell:last_summary")}{" "}{shortDate(card.lastGeneratedAt)}
          {rollup ? translateShell("shell:lifetime", { value1: formatTokens(rollup.totalTokens), value2: formatCents(rollup.totalCostCents) }) : ""}
        </p>
      </div>
      {/* View is the more common intent on an archived row (reading the last
          summary); Restore is safe but secondary — it brings the card back
          stale and never auto-runs. */}
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={onView}>{translateShell("shell:view")}</Button>
        <Button variant="outline" size="sm" onClick={onRestore} disabled={restorePending}>
          {restorePending ? <Loader2 className="animate-spin" /> : null}{translateShell("shell:restore")}</Button>
      </div>
    </div>
  );
}
