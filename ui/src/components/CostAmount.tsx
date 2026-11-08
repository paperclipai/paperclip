import { t, useTranslation, Trans } from "@/i18n";
import type { ReactNode } from "react";
import type { CostByAgent } from "@paperclipai/shared";
import { formatCents } from "../lib/utils";
import { CostEstimateLabel } from "./CostEstimateLabel";
import { Badge } from "./ui/badge";

export function CostAmount({
  costCents,
  eventCount,
  estimatedEventCount,
  unpricedEventCount,
  showUnavailableCount = false,
  suffix,
}: Pick<CostByAgent, "costCents"> & Partial<Pick<CostByAgent, "eventCount" | "estimatedEventCount">> & {
  unpricedEventCount?: number;
  showUnavailableCount?: boolean;
  suffix?: ReactNode;
}) {
  useTranslation("task-components");
  const entirelyUnpriced = costCents === 0 && (eventCount ?? 0) > 0 && unpricedEventCount === eventCount;
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <div className="whitespace-nowrap font-mono font-medium tabular-nums">
        {entirelyUnpriced ? "—" : formatCents(costCents)}
        {suffix}
      </div>
      <CostEstimateLabel eventCount={eventCount} estimatedEventCount={estimatedEventCount} />
      {showUnavailableCount && !!unpricedEventCount && <Badge variant="outline" className="font-normal text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_abcb5087c266" components={{ part1: <>{unpricedEventCount}</>, part2: <>{unpricedEventCount === 1 ? t("task-components:cost_9f82f7b3") : t("task-components:costs_bcde6928")}</> }} /></Badge>}
    </div>
  );
}
