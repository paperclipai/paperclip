import { fileRowSourceFromAttachment, fileRowSourceFromWorkProduct } from "@/components/artifacts/v1/adapters";
import { isImageLikeOutput } from "@/lib/issue-output";
import type { TaskChatItem, TaskChatMaterializedResourceItem } from "./task-chat-model";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";

export function imagePreparationReceiptIds(
  comments: readonly IssueChatComment[], attachments: readonly IssueAttachment[], products: readonly IssueWorkProduct[],
): Set<string> {
  const commentsById = new Map(comments.map(comment => [comment.id, comment]));
  const imagesByAttachment = new Map<string, IssueWorkProduct>();
  for (const product of products) {
    const source = fileRowSourceFromWorkProduct(product);
    if (source?.attachmentId && isImageLikeOutput(source.contentType, source.filename)) {
      imagesByAttachment.set(source.attachmentId, product);
    }
  }
  const ids = new Set<string>();
  for (const attachment of attachments) {
    const comment = attachment.issueCommentId ? commentsById.get(attachment.issueCommentId) : undefined;
    const image = imagesByAttachment.get(attachment.id);
    const receiptAttachmentId = comment?.metadata?.attachmentPreparation?.attachmentId;
    // Older receipts predate the marker. Keep their exact historical format as
    // a compatibility fallback; new receipts do not depend on wording or title.
    const isPreparation = receiptAttachmentId === attachment.id ||
      (receiptAttachmentId == null && image && comment?.body === `Prepared ${image.title} for this response.`);
    if (comment && comment.authorType === "agent" && attachment.originatingRunId &&
      image?.createdByRunId === attachment.originatingRunId && isPreparation &&
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
