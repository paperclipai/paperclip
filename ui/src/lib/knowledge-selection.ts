import type { KnowledgeItem } from "@paperclipai/shared";

function toSearchableSegments(item: KnowledgeItem): string[] {
  return [
    item.title,
    item.summary ?? "",
    item.body ?? "",
    item.sourceUrl ?? "",
  ];
}

function rankKnowledgeItem(item: KnowledgeItem, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;

  const title = item.title.toLowerCase();
  const summary = (item.summary ?? "").toLowerCase();
  const body = (item.body ?? "").toLowerCase();
  const sourceUrl = (item.sourceUrl ?? "").toLowerCase();

  if (title.startsWith(normalized)) return 0;
  if (title.includes(normalized)) return 1;
  if (summary.includes(normalized)) return 2;
  if (body.includes(normalized) || sourceUrl.includes(normalized)) return 3;
  return 4;
}

export function filterKnowledgeItems(
  items: KnowledgeItem[],
  query: string,
  excludedIds: ReadonlySet<string> = new Set()
): KnowledgeItem[] {
  const normalized = query.trim().toLowerCase();

  return items
    .filter((item) => !excludedIds.has(item.id))
    .filter((item) => {
      if (!normalized) return true;
      return toSearchableSegments(item).some((value) =>
        value.toLowerCase().includes(normalized)
      );
    })
    .sort((left, right) => {
      const rankDelta =
        rankKnowledgeItem(left, normalized) -
        rankKnowledgeItem(right, normalized);
      if (rankDelta !== 0) return rankDelta;
      return (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    });
}
