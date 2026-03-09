import type { KnowledgeItem } from "@paperclipai/shared";

export function getKnowledgeLibraryAuxiliaryText(
  item: KnowledgeItem
): string | null {
  if (item.kind === "url") {
    return item.sourceUrl?.trim() || null;
  }

  if (item.kind === "asset") {
    return item.asset?.originalFilename?.trim() || item.assetId || null;
  }

  return null;
}
