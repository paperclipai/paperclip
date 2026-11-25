import { fileRowSourceFromAttachment, fileRowSourceFromWorkProduct } from "@/components/artifacts/v1/adapters";
import { isImageLikeOutput } from "@/lib/issue-output";
import type { TaskChatItem, TaskChatMaterializedResourceItem } from "./task-chat-model";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";

/**
 * Generated "Prepared <file> for this response." receipts whose file already
 * shows as the run's own card (an image tile or a file row). The receipt and
 * its attachment would repeat that file, so the thread hides them.
 */
export function preparationReceiptIds(
  comments: readonly IssueChatComment[], attachments: readonly IssueAttachment[], products: readonly IssueWorkProduct[],
): Set<string> {
  const commentsById = new Map(comments.map(comment => [comment.id, comment]));
  const filesByAttachment = new Map<string, { product: IssueWorkProduct; image: boolean }>();
  for (const product of products) {
    const source = fileRowSourceFromWorkProduct(product);
    if (source?.attachmentId) {
      filesByAttachment.set(source.attachmentId, { product, image: isImageLikeOutput(source.contentType, source.filename) });
    }
  }
  const ids = new Set<string>();
  for (const attachment of attachments) {
    const comment = attachment.issueCommentId ? commentsById.get(attachment.issueCommentId) : undefined;
    const file = filesByAttachment.get(attachment.id);
    const receiptAttachmentId = comment?.metadata?.attachmentPreparation?.attachmentId;
    // Older image receipts predate the marker. Keep their exact historical
    // format as a compatibility fallback; new receipts do not depend on wording or title.
    const isPreparation = receiptAttachmentId === attachment.id ||
      (receiptAttachmentId == null && file?.image && comment?.body === `Prepared ${file.product.title} for this response.`);
    if (comment && comment.authorType === "agent" && attachment.originatingRunId &&
      file?.product.createdByRunId === attachment.originatingRunId && isPreparation &&
      (comment.runId ?? comment.createdByRunId) === attachment.originatingRunId &&
      comment.authorAgentId === attachment.createdByAgentId &&
      comment.metadata?.authorizationReason === "paperclip_runner_protocol") ids.add(comment.id);
  }
  return ids;
}

export function imageResourceSource(item: TaskChatItem) {
  if (item.kind !== "protocol" || item.surface !== "resource") return null;
  const source = item.resourceKind === "attachment" && item.attachment
    ? fileRowSourceFromAttachment(item.attachment)
    : item.resourceKind === "deliverable" && item.workProduct
      ? fileRowSourceFromWorkProduct(item.workProduct)
      : null;
  return source?.contentPath && isImageLikeOutput(source.contentType, source.filename) ? source : null;
}

export function groupImageResources<T extends TaskChatItem>(items: readonly T[]): T[] {
  const rows: T[] = [];
  let group: TaskChatMaterializedResourceItem | null = null;
  let runId: string | null | undefined;
  for (const item of items) {
    if (item.kind !== "protocol" || item.surface !== "resource" || !imageResourceSource(item)) {
      group = null;
      rows.push(item);
      continue;
    }
    const nextRunId = item.workProduct?.createdByRunId ?? item.attachment?.originatingRunId;
    if (group && runId != null && runId === nextRunId) {
      group.imageItems!.push(...(item.imageItems ?? [item]));
    } else {
      group = { ...item, imageItems: [...(item.imageItems ?? [item])] };
      runId = nextRunId;
      rows.push(group as T);
    }
  }
  return rows;
}

export function runFileCardAttachments(products: readonly IssueWorkProduct[]): ReadonlyMap<string, string> {
  const byAttachment = new Map<string, string>();
  for (const product of products) {
    const attachmentId = fileRowSourceFromWorkProduct(product)?.attachmentId;
    if (attachmentId && product.createdByRunId) byAttachment.set(attachmentId, product.createdByRunId);
  }
  return byAttachment;
}
