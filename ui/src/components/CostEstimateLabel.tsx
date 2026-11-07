import { t, useTranslation } from "@/i18n";
import type { CostByAgent } from "@paperclipai/shared";
import { Badge } from "./ui/badge";

/** Use this group's ledger counts, never the page-wide estimate count. */
export function CostEstimateLabel({
  eventCount,
  estimatedEventCount,
}: Partial<Pick<CostByAgent, "eventCount" | "estimatedEventCount">>) {
  useTranslation("task-components");
  if (!estimatedEventCount) return null;
  const allEstimated = estimatedEventCount === eventCount;
  return (
    <Badge
      variant="outline"
      className="font-normal text-muted-foreground"
      title={t("task-components:estimatedCalculatedFromTokenUsageAndPublished_ea589aca", { value1: estimatedEventCount, value2: estimatedEventCount === 1 ? "charge" : "charges" })}
    >
      {allEstimated ? t("final-components-b:CostEstimateLabel.Estimated_b77459") : t("task-components:partiallyEstimated_4178459d")}
    </Badge>
  );
}
