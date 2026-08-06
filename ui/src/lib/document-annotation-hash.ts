export interface DocumentAnnotationHashTarget {
  documentKey: string;
  threadId: string | null;
  commentId: string | null;
}

const DOCUMENT_HASH_PREFIX = "#document-";

export function parseDocumentAnnotationHash(hash: string): DocumentAnnotationHashTarget | null {
  if (!hash.startsWith(DOCUMENT_HASH_PREFIX)) return null;
  const stripped = hash.slice(DOCUMENT_HASH_PREFIX.length);
  const [rawKey, ...rest] = stripped.split("&");
  if (!rawKey) return null;
  const documentKey = decodeURIComponent(rawKey);
  const params = new URLSearchParams(rest.join("&"));
  const threadId = params.get("thread");
  const commentId = params.get("comment");
  return {
    documentKey,
    threadId: threadId && threadId.length > 0 ? threadId : null,
    commentId: commentId && commentId.length > 0 ? commentId : null,
  };
}

export function buildDocumentAnnotationHash(target: DocumentAnnotationHashTarget): string {
  const params = new URLSearchParams();
  if (target.threadId) params.set("thread", target.threadId);
  if (target.commentId) params.set("comment", target.commentId);
  const qs = params.toString();
  const encodedKey = encodeURIComponent(target.documentKey);
  return qs ? `${DOCUMENT_HASH_PREFIX}${encodedKey}&${qs}` : `${DOCUMENT_HASH_PREFIX}${encodedKey}`;
}
