import { t } from "@/i18n";
import type { ToolCatalogEntry } from "@paperclipai/shared";

export type ActionPermissionSummary = {
  allowedCount: number;
  askFirstCount: number;
  offCount: number;
};

export function summarizeActionPermissions(
  entries: ToolCatalogEntry[],
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
): ActionPermissionSummary {
  let allowedCount = 0;
  let askFirstCount = 0;
  let offCount = 0;

  for (const entry of entries) {
    if (!enabledIds.has(entry.id)) {
      offCount += 1;
    } else if (askFirstIds.has(entry.id)) {
      askFirstCount += 1;
    } else {
      allowedCount += 1;
    }
  }

  return { allowedCount, askFirstCount, offCount };
}

export function formatActionPermissionSummary(summary: ActionPermissionSummary): string {
  return [
    t("localizationApps.summaryallowed", { count: summary.allowedCount }),
    t("localizationApps.summaryask", { count: summary.askFirstCount }),
    t("localizationApps.summaryoff", { count: summary.offCount }),
  ].join(" · ");
}
