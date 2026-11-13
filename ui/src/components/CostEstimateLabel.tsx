import type { CostByAgent } from "@paperclipai/shared";
import { Badge } from "./ui/badge";

/** Use this group's ledger counts, never the page-wide estimate count. */
export function CostEstimateLabel({
  eventCount,
  estimatedEventCount,
}: Partial<Pick<CostByAgent, "eventCount" | "estimatedEventCount">>) {
  if (!estimatedEventCount) return null;
  const allEstimated = estimatedEventCount === eventCount;
  return (
    <Badge
      variant="outline"
      className="font-normal text-muted-foreground"
      title={`${estimatedEventCount} estimated ${estimatedEventCount === 1 ? "charge" : "charges"}. Calculated from token usage and published rates; provider bills may differ.`}
    >
      {allEstimated ? "Estimated" : "Partially estimated"}
    </Badge>
  );
}
