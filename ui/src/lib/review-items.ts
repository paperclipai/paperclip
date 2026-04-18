import type {
  IssueFilePreview,
  IssueReviewActionTarget,
  IssueReviewItem,
  IssueReviewItemGroup,
  IssueReviewItemKind,
  IssueReviewPack,
  IssueReviewItemSourceRef,
} from "@paperclipai/shared";

export interface GroupedIssueReviewItems {
  key: IssueReviewItemGroup;
  title: string;
  description: string;
  collapsedByDefault: boolean;
  items: IssueReviewItem[];
}

const REVIEW_ITEM_GROUPS: Array<Omit<GroupedIssueReviewItems, "items">> = [
  {
    key: "review_now",
    title: "Review now",
    description: "Previewable outputs and decisions that deserve attention first.",
    collapsedByDefault: false,
  },
  {
    key: "references",
    title: "References",
    description: "Supporting assets and paths that help verify the work.",
    collapsedByDefault: false,
  },
  {
    key: "hidden_context",
    title: "Hidden context",
    description: "Duplicates, stale mentions, and unavailable references.",
    collapsedByDefault: true,
  },
];

function sourceTimestamp(sourceRef: IssueReviewItemSourceRef) {
  return sourceRef.createdAt instanceof Date
    ? sourceRef.createdAt.getTime()
    : new Date(sourceRef.createdAt).getTime();
}

export function getGroupedIssueReviewItems(items: readonly IssueReviewItem[]): GroupedIssueReviewItems[] {
  return REVIEW_ITEM_GROUPS
    .map((group) => ({
      ...group,
      items: items.filter((item) => item.group === group.key),
    }))
    .filter((group) => group.items.length > 0);
}

export function indexIssueReviewItems(items: readonly IssueReviewItem[]) {
  return new Map(items.map((item) => [item.id, item] as const));
}

export function getIssueReviewPackPrimaryItems(
  pack: Pick<IssueReviewPack, "primaryItemIds">,
  itemsById: ReadonlyMap<string, IssueReviewItem>,
) {
  return pack.primaryItemIds
    .map((itemId) => itemsById.get(itemId))
    .filter((item): item is IssueReviewItem => Boolean(item));
}

export function getIssueReviewPackEvidenceItems(
  pack: Pick<IssueReviewPack, "evidenceItemIds">,
  itemsById: ReadonlyMap<string, IssueReviewItem>,
) {
  return pack.evidenceItemIds
    .map((itemId) => itemsById.get(itemId))
    .filter((item): item is IssueReviewItem => Boolean(item));
}

export function getIssueReviewActionItem(
  target: IssueReviewActionTarget | null | undefined,
  itemsById: ReadonlyMap<string, IssueReviewItem>,
) {
  if (!target || target.type !== "item") return null;
  return itemsById.get(target.value) ?? null;
}

export function getReviewItemsForComment(
  items: readonly IssueReviewItem[],
  commentId: string | null | undefined,
): IssueReviewItem[] {
  if (!commentId) return [];
  return items.filter((item) => item.sourceRefs.some((sourceRef) => sourceRef.commentId === commentId));
}

export function groupReviewItemsByCommentId(items: readonly IssueReviewItem[]): Map<string, IssueReviewItem[]> {
  const grouped = new Map<string, IssueReviewItem[]>();
  for (const item of items) {
    const commentIds = new Set(
      item.sourceRefs
        .map((sourceRef) => sourceRef.commentId)
        .filter((commentId): commentId is string => Boolean(commentId)),
    );
    for (const commentId of commentIds) {
      const existing = grouped.get(commentId) ?? [];
      existing.push(item);
      grouped.set(commentId, existing);
    }
  }
  return grouped;
}

export function getLatestReviewItemSource(item: IssueReviewItem): IssueReviewItemSourceRef | null {
  return item.sourceRefs.reduce<IssueReviewItemSourceRef | null>((latest, sourceRef) => {
    if (!latest) return sourceRef;
    return sourceTimestamp(sourceRef) >= sourceTimestamp(latest) ? sourceRef : latest;
  }, null);
}

export function getIssueReviewItemKindLabel(kind: IssueReviewItemKind): string {
  switch (kind) {
    case "image":
      return "Image";
    case "file":
      return "File";
    case "document":
      return "Document";
    case "marketplace_link":
      return "Marketplace";
    case "work_product":
      return "Work product";
    case "generic_link":
      return "Link";
    case "missing":
      return "Missing";
    default:
      return "Item";
  }
}

export function describeIssueReviewItemSurfaceState(item: IssueReviewItem): string {
  if (item.summary) return item.summary;
  if (item.previewState === "ready") {
    switch (item.kind) {
      case "image":
        return "Image preview is ready inline.";
      case "marketplace_link":
      case "generic_link":
        return "External target detected and ready to open.";
      default:
        return "Previewable review target detected.";
    }
  }
  if (item.previewState === "partial") {
    if (item.resolvedTarget.path) {
      return "Workspace file detected. Open to inspect the live snippet and provenance.";
    }
    if (item.kind === "document") {
      return "Document content is available for inspection.";
    }
    return "Partial preview available for deeper inspection.";
  }
  if (item.previewState === "missing") {
    return "Expected review target is currently unavailable.";
  }
  return "Inline preview is not supported for this target.";
}

export function getIssueReviewItemPrimaryHref(
  item: IssueReviewItem,
  preview?: IssueFilePreview | null,
): string | null {
  if (preview?.contentPath) return preview.contentPath;
  if (item.resolvedTarget.url) return item.resolvedTarget.url;
  if (item.resolvedTarget.documentKey) return `#document-${encodeURIComponent(item.resolvedTarget.documentKey)}`;
  if (item.thumbnailUrl) return item.thumbnailUrl;
  return null;
}

export function getIssueReviewItemPrimaryActionLabel(
  item: IssueReviewItem,
  preview?: IssueFilePreview | null,
): string | null {
  if (preview?.contentPath) {
    return preview.kind === "image" ? "Open image" : "Open preview";
  }
  if (item.resolvedTarget.url) return "Open link";
  if (item.resolvedTarget.documentKey) return "Jump to document";
  if (item.thumbnailUrl) return "Open attachment";
  return null;
}

export function getIssueReviewItemSourceHref(item: IssueReviewItem): string | null {
  const latestSource = getLatestReviewItemSource(item);
  if (!latestSource?.commentId) return null;
  return `#comment-${latestSource.commentId}`;
}
