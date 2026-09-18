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

/** Watch the same durable objects as the Artifacts tab, excluding its initial load. */
export function useTaskArtifactArrival({
  issueId, attachments, workProducts, documents, onArrival,
}: TaskArtifactArrivalOptions) {
  const observed = useRef<{
    issueId: string | undefined;
    loaded: Set<string>;
    ids: Set<string>;
  }>({ issueId: undefined, loaded: new Set(), ids: new Set() });

  useEffect(() => {
    if (observed.current.issueId !== issueId) {
      observed.current = { issueId, loaded: new Set(), ids: new Set() };
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
    for (const [source, ids] of Object.entries(sources)) {
      if (!ids) continue;
      const loaded = state.loaded.has(source);
      for (const id of ids) {
        if (loaded && !state.ids.has(id)) arrived = true;
        state.ids.add(id);
      }
      state.loaded.add(source);
    }
    // Keep observed IDs across removals and failed refetches. A repeated
    // snapshot or a revision update must not take the user's tab selection.
    if (arrived) onArrival();
  }, [issueId, attachments, workProducts, documents, onArrival]);
}
