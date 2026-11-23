import type { ConnectToolAppResult, ToolCatalogEntry, ToolAppConnectionActionSummary } from "@paperclipai/shared";

export function actionSummary(
  entry: ToolCatalogEntry,
): ToolAppConnectionActionSummary {
  return {
    catalogEntryId: entry.id,
    toolName: entry.toolName,
    title: entry.title,
    description: entry.description,
    riskLevel: entry.riskLevel,
    isReadOnly: entry.isReadOnly,
    isWrite: entry.isWrite,
    isDestructive: entry.isDestructive,
    status: entry.status,
  };
}

export function groupedActions(
  catalog: ToolCatalogEntry[],
): ConnectToolAppResult["actions"] {
  const readOnly: ToolAppConnectionActionSummary[] = [];
  const canMakeChanges: ToolAppConnectionActionSummary[] = [];
  for (const entry of catalog) {
    const summary = actionSummary(entry);
    if (
      entry.isReadOnly &&
      entry.riskLevel === "read" &&
      !entry.isWrite &&
      !entry.isDestructive
    ) {
      readOnly.push(summary);
    } else {
      canMakeChanges.push(summary);
    }
  }
  return { readOnly, canMakeChanges };
}
