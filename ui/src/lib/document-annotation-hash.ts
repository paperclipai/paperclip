export interface DocumentAnnotationHashTarget {
  documentKey: string;
  threadId: string | null;
  commentId: string | null;
  /**
   * `viewer=full` (LOOA-2181): external deep links — e.g. the Slack gateway's
   * "Open task" button on an approval card — request the document opened in
   * the maximized (full-size) properties pane, skipping the manual
   * open-pane → Artifacts → open → maximize click chain.
   */
  viewer: "full" | null;
}

const DOCUMENT_HASH_PREFIX = "#document-";

export function parseDocumentAnnotationHash(hash: string): DocumentAnnotationHashTarget | null {
  if (!hash.startsWith(DOCUMENT_HASH_PREFIX)) return null;
  const stripped = hash.slice(DOCUMENT_HASH_PREFIX.length);
  const [rawKey, ...rest] = stripped.split("&");
  if (!rawKey) return null;
  let documentKey: string;
  try {
    documentKey = decodeURIComponent(rawKey);
  } catch {
    return null;
  }
  if (!documentKey) return null;
  const params = new URLSearchParams(rest.join("&"));
  const threadId = params.get("thread");
  const commentId = params.get("comment");
  return {
    documentKey,
    threadId: threadId && threadId.length > 0 ? threadId : null,
    commentId: commentId && commentId.length > 0 ? commentId : null,
    viewer: params.get("viewer") === "full" ? "full" : null,
  };
}

export function buildDocumentAnnotationHash(
  target: Omit<DocumentAnnotationHashTarget, "viewer"> & { viewer?: "full" | null },
): string {
  const params = new URLSearchParams();
  if (target.threadId) params.set("thread", target.threadId);
  if (target.commentId) params.set("comment", target.commentId);
  if (target.viewer) params.set("viewer", target.viewer);
  const qs = params.toString();
  const encodedKey = encodeURIComponent(target.documentKey);
  return qs ? `${DOCUMENT_HASH_PREFIX}${encodedKey}&${qs}` : `${DOCUMENT_HASH_PREFIX}${encodedKey}`;
}
