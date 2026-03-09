import type { IssueKnowledgeAttachment } from "@paperclipai/shared";

const INLINE_TEXT_ASSET_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
]);

function toRuntimeKnowledgeItem(attachment: IssueKnowledgeAttachment) {
  const knowledgeItem = attachment.knowledgeItem;
  if (!knowledgeItem) return null;

  const asset = knowledgeItem.asset;
  const contentText =
    asset && knowledgeItem.contentText && INLINE_TEXT_ASSET_TYPES.has(asset.contentType.toLowerCase())
      ? knowledgeItem.contentText
      : null;

  return {
    id: knowledgeItem.id,
    title: knowledgeItem.title,
    kind: knowledgeItem.kind,
    summary: knowledgeItem.summary,
    body: knowledgeItem.kind === "note" ? knowledgeItem.body : null,
    sourceUrl: knowledgeItem.kind === "url" ? knowledgeItem.sourceUrl : null,
    asset: asset
      ? {
          assetId: asset.assetId,
          contentType: asset.contentType,
          originalFilename: asset.originalFilename,
          byteSize: asset.byteSize,
          contentPath: asset.contentPath,
        }
      : null,
    contentText,
  };
}

export function applyIssueKnowledgeContext(
  contextSnapshot: Record<string, unknown>,
  attachments: IssueKnowledgeAttachment[],
) {
  const knowledgeItems = attachments
    .map((attachment) => toRuntimeKnowledgeItem(attachment))
    .filter((item): item is NonNullable<typeof item> => item != null);

  if (knowledgeItems.length === 0) return contextSnapshot;

  return {
    ...contextSnapshot,
    paperclipKnowledgeItems: knowledgeItems,
  };
}
