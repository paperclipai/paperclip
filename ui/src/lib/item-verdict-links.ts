import type { RequestItemVerdictsItem } from "@paperclipai/shared";
import { buildDocumentAnnotationHash } from "./document-annotation-hash";
import { normalizeRequestConfirmationTargetHref } from "./issue-thread-interactions";

/** The bound output takes precedence over an optional display URL. */
export function itemVerdictHref(item: RequestItemVerdictsItem, interaction: { issueId: string; id: string }): string | null {
  const target = item.target;
  if (target?.type === "issue_document") {
    return `/issues/${encodeURIComponent(target.issueId ?? interaction.issueId)}${buildDocumentAnnotationHash({
      documentKey: target.key, revisionId: target.revisionId, interactionId: interaction.id, threadId: null, commentId: null,
    })}`;
  }
  if (target?.type === "issue_attachment") {
    // Use the authenticated immutable-content route in both interface modes.
    // This does not depend on the experimental task attachment panel.
    return `/api/attachments/${encodeURIComponent(target.attachmentId)}/content`;
  }
  return item.href ? normalizeRequestConfirmationTargetHref(item.href) : null;
}
