import type { IssueAttachment, IssueDocumentSummary, IssueWorkProduct } from "@paperclipai/shared";
import { getPromotedOutputAttachmentIds } from "./issue-output";

/**
 * Selectors for the properties pane's Artifacts tab (PAP-491): which
 * attachments count as agent-produced artifacts, as opposed to user uploads
 * that live in the conversation thread.
 */

/**
 * An attachment authored by an agent. Rows with no author at all are treated
 * as agent output when they are not bound to a comment — legacy agent uploads
 * predate attribution, while user uploads always arrive through a comment.
 */
export function isAgentAttachment(
  attachment: Pick<IssueAttachment, "createdByAgentId" | "createdByUserId" | "issueCommentId">,
): boolean {
  if (attachment.createdByAgentId) return true;
  return !attachment.createdByUserId && !attachment.issueCommentId;
}

/**
 * Agent-authored attachments minus the ones already promoted to
 * attachment-backed work products (`metadata.attachmentId`), so the Artifacts
 * tab lists each file once.
 */
export function selectAgentArtifactAttachments(
  attachments: IssueAttachment[] | null | undefined,
  workProducts: IssueWorkProduct[] | null | undefined,
): IssueAttachment[] {
  const promoted = getPromotedOutputAttachmentIds(workProducts);
  return (attachments ?? []).filter(
    (attachment) => isAgentAttachment(attachment) && !promoted.has(attachment.id),
  );
}

/**
 * Where a work-product row should link. Many rows carry `url: null` with the
 * usable link only in metadata — `openPath` for attachment-backed artifacts
 * (same field OutputRow opens) or `url` for provider-specific links — so fall
 * back to those before rendering the row inert. Expired links are still
 * returned; titles announce expiry where the producer recorded it.
 */
export function workProductHref(
  workProduct: Pick<IssueWorkProduct, "url" | "metadata">,
): string | null {
  if (workProduct.url) return workProduct.url;
  const metadata = workProduct.metadata;
  if (!metadata) return null;
  for (const key of ["openPath", "url"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** Display title for an issue document: its title, else its key humanized. */
export function documentDisplayTitle(
  doc: Pick<IssueDocumentSummary, "key" | "title">,
): string {
  if (doc.title?.trim()) return doc.title;
  const words = doc.key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
