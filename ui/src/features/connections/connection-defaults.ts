import type { ConnectToolAppResult } from "@paperclipai/shared";

/**
 * Which of a fresh connection's actions start behind a human approval (PAP-659
 * C6a/C7).
 *
 * The runtime gate and its approval card already existed; what was missing was
 * a default with anything behind it. This lives outside the wizard because two
 * different setup paths commit connections — the catalog flow and the
 * remote-MCP gateway flow — and a gate that is armed on only one of them is a
 * gate you cannot reason about. The risk levels come from the server's
 * `suggestedDefaults` rather than a constant here, so retuning the policy stays
 * a one-line change in `recommendedDefaultsForApp`.
 */
export function askFirstCatalogEntryIdsFor(
  result: Pick<ConnectToolAppResult, "actions" | "suggestedDefaults">,
  isEnabled: (catalogEntryId: string) => boolean,
): string[] {
  const riskLevels = new Set(
    Array.isArray(result.suggestedDefaults?.askFirstRiskLevels)
      ? result.suggestedDefaults.askFirstRiskLevels.filter(
        (riskLevel): riskLevel is string => typeof riskLevel === "string",
      )
      : [],
  );
  if (riskLevels.size === 0) return [];
  return result.actions.canMakeChanges
    .filter((action) => isEnabled(action.catalogEntryId) && riskLevels.has(action.riskLevel))
    .map((action) => action.catalogEntryId);
}
