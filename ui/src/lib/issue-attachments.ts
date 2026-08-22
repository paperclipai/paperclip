import type { IssueAttachment } from "@paperclipai/shared";
import { isMarkdownAttachmentContent } from "@paperclipai/shared";
import { isVideoLikeOutput } from "./issue-output";

type AttachmentPathLike = {
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
};

function normalizedContentType(attachment: Pick<IssueAttachment, "contentType">) {
  return attachment.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function attachmentFilename(attachment: Pick<IssueAttachment, "id" | "originalFilename">) {
  return attachment.originalFilename ?? attachment.id;
}

export function attachmentOpenPath(attachment: AttachmentPathLike) {
  return attachment.openPath ?? attachment.contentPath;
}

export function attachmentDownloadPath(attachment: AttachmentPathLike) {
  return attachment.downloadPath ?? `${attachment.contentPath}?download=1`;
}

export function isImageAttachment(attachment: Pick<IssueAttachment, "contentType">) {
  return normalizedContentType(attachment).startsWith("image/");
}

export function isVideoAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  return isVideoLikeOutput(attachment.contentType, attachment.originalFilename);
}

export function isMarkdownAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  return isMarkdownAttachmentContent(attachment);
}
