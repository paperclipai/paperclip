import { t as translate } from "@/i18n";
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

function summaryCount(label: string, count: number): string {
  return translate("connections:_ceb3e8b", { label, count });
}

export function formatActionPermissionSummary(summary: ActionPermissionSummary): string {
  return [
    summaryCount(translate("connections:allowed_for_5647072"), summary.allowedCount),
    summaryCount(translate("connections:ask_first_for_a7e9166"), summary.askFirstCount),
    summaryCount(translate("connections:off_for_3d766f4"), summary.offCount),
  ].join(" · ");
}
