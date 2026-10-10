import type { ReactNode } from "react";
import type { CostByAgent } from "@paperclipai/shared";
import { formatCents } from "../lib/utils";
import { CostEstimateLabel } from "./CostEstimateLabel";

export function CostAmount({
  costCents,
  eventCount,
  estimatedEventCount,
  unpricedEventCount,
  suffix,
}: Pick<CostByAgent, "costCents"> & Partial<Pick<CostByAgent, "eventCount" | "estimatedEventCount">> & {
  unpricedEventCount?: number;
  suffix?: ReactNode;
}) {
  const entirelyUnpriced = costCents === 0 && (eventCount ?? 0) > 0 && unpricedEventCount === eventCount;
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <div className="whitespace-nowrap font-mono font-medium tabular-nums">
        {entirelyUnpriced ? "—" : formatCents(costCents)}
        {suffix}
      </div>
      <CostEstimateLabel eventCount={eventCount} estimatedEventCount={estimatedEventCount} />
    </div>
  );
}
