import type { RequestConfirmationTarget } from "@paperclipai/shared";
import { buildDocumentAnnotationHash } from "./document-annotation-hash";

/** Receipt links stay inside the task and pin the exact reviewed work product. */
export function decisionReceiptHref({ issueHref, interactionId, target }: {
  issueHref: string;
  interactionId: string;
  target?: RequestConfirmationTarget | null;
}) {
  const base = issueHref.split("#")[0];
  if (target?.type === "issue_document") return base + buildDocumentAnnotationHash({
    documentKey: target.key, revisionId: target.revisionId, documentIssueId: target.issueId ?? undefined,
    interactionId, threadId: null, commentId: null,
  });
  const attachment = target as { type?: string; attachmentId?: string } | null | undefined;
  const hash = `#interaction-${encodeURIComponent(interactionId)}`;
  return base + hash + (attachment?.type === "issue_attachment" && attachment.attachmentId
    ? `&attachment=${encodeURIComponent(attachment.attachmentId)}` : "");
}
