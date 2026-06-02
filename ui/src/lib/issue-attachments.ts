import type { IssueAttachment } from "@paperclipai/shared";
import { isVideoContentType } from "./issue-output";

const GENERIC_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

function normalizedContentType(attachment: Pick<IssueAttachment, "contentType">) {
  return attachment.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function attachmentFilename(attachment: Pick<IssueAttachment, "id" | "originalFilename">) {
  return attachment.originalFilename ?? attachment.id;
}

export function attachmentOpenPath(
  attachment: Pick<IssueAttachment, "contentPath" | "openPath">,
) {
  return attachment.openPath ?? attachment.contentPath;
}

export function attachmentDownloadPath(
  attachment: Pick<IssueAttachment, "contentPath" | "downloadPath">,
) {
  return attachment.downloadPath ?? `${attachment.contentPath}?download=1`;
}

export function isImageAttachment(attachment: Pick<IssueAttachment, "contentType">) {
  return normalizedContentType(attachment).startsWith("image/");
}

export function isVideoAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  const contentType = normalizedContentType(attachment);
  if (isVideoContentType(contentType)) return true;
  if (!GENERIC_ATTACHMENT_CONTENT_TYPES.has(contentType)) return false;

  const filename = (attachment.originalFilename ?? "").toLowerCase();
  return (
    filename.endsWith(".mp4") ||
    filename.endsWith(".m4v") ||
    filename.endsWith(".webm") ||
    filename.endsWith(".mov") ||
    filename.endsWith(".qt") ||
    filename.endsWith(".quicktime")
  );
}

export function isMarkdownAttachment(
  attachment: Pick<IssueAttachment, "contentType" | "originalFilename">,
) {
  const contentType = normalizedContentType(attachment);
  if (
    contentType === "text/markdown" ||
    contentType === "text/x-markdown" ||
    contentType === "application/markdown" ||
    contentType === "application/x-markdown"
  ) {
    return true;
  }

  const filename = (attachment.originalFilename ?? "").toLowerCase();
  if (!filename.endsWith(".md") && !filename.endsWith(".markdown")) return false;
  return contentType === "text/plain" || GENERIC_ATTACHMENT_CONTENT_TYPES.has(contentType);
}
