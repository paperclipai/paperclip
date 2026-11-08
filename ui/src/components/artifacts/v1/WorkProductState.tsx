import { t, useTranslation } from "@/i18n";
import type { IssueWorkProduct } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { stateChipFor } from "@/components/task-chat/RichWorkProductCard";

/**
 * What a row says beside a work product's name: "Unhealthy" first — a
 * service can be active and broken at once, and the shipped cards warn the
 * same way — otherwise the caller's label, else the state chip's.
 */
export function workProductStateBadge(
  workProduct: Pick<IssueWorkProduct, "type" | "status" | "reviewState" | "healthStatus">,
  label?: string | null,
): ReactNode {
  if (workProduct.healthStatus === "unhealthy") return <Badge variant="destructive">{t("task-components:unhealthy_317b1fbc")}</Badge>;
  const text = label ?? stateChipFor(workProduct.type, workProduct.status, workProduct.reviewState)?.label;
  return text ? <span className="text-xs text-muted-foreground">{text}</span> : undefined;
}
