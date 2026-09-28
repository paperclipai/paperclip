import { useEffect, useRef } from "react";
import {
  getAttachmentArtifactWorkProductMetadata,
  isArtifactReviewDocumentKey,
  type IssueAttachment,
  type IssueDocumentSummary,
  type IssueWorkProduct,
} from "@paperclipai/shared";
import { isAgentAttachment } from "@/lib/issue-artifacts";

interface TaskArtifactArrivalOptions {
  issueId: string | undefined;
  attachments: IssueAttachment[] | undefined;
  workProducts: IssueWorkProduct[] | undefined;
  documents: IssueDocumentSummary[] | undefined;
  onArrival: () => void;
}

/** Register the same durable objects as the Artifacts tab, including history. */
export function useTaskArtifactArrival({
  issueId, attachments, workProducts, documents, onArrival,
}: TaskArtifactArrivalOptions) {
  const observed = useRef<{
    issueId: string | undefined;
    ids: Set<string>;
  }>({ issueId: undefined, ids: new Set() });

  useEffect(() => {
    if (observed.current.issueId !== issueId) {
      observed.current = { issueId, ids: new Set() };
    }
    if (!issueId) return;

    const sources = {
      attachments: attachments?.filter(isAgentAttachment).map((file) => `attachment:${file.id}`),
      workProducts: workProducts?.map((product) => {
        const attachment = getAttachmentArtifactWorkProductMetadata(product);
        // Uploading a file and then registering it is one arrival, even when
        // the two queries settle separately.
        return attachment ? `attachment:${attachment.attachmentId}` : `work-product:${product.id}`;
      }),
      documents: documents
        ?.filter((doc) => doc.key !== "plan" && !isArtifactReviewDocumentKey(doc.key))
        .map((doc) => `document:${doc.id}`),
    };
    const state = observed.current;
    let arrived = false;
    for (const ids of Object.values(sources)) {
      if (!ids) continue;
      for (const id of ids) {
        if (!state.ids.has(id)) arrived = true;
        state.ids.add(id);
      }
    }
    // Keep observed IDs across removals and failed refetches. A repeated
    // snapshot or a revision update must not take the user's tab selection.
    if (arrived) onArrival();
  }, [issueId, attachments, workProducts, documents, onArrival]);
}
