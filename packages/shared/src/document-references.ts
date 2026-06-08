/**
 * Path-based references to company documents, e.g. `/PAP/documents/<id>` or the
 * company-relative `/documents/<id>`. Mirrors `issue-references.ts` so comment
 * bodies can render a cross-issue document mention chip. The `<id>` segment is
 * the company document id used by the documents library detail route.
 */

export interface ParsedDocumentReference {
  documentId: string;
  /** When the href carries `?from=issue:<key>`, the originating issue document key. */
  fromIssueKey: string | null;
}

/** Document ids are UUIDs in practice; accept any non-empty url-safe slug to stay forgiving. */
const DOCUMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseFromParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^issue:(.+)$/i.exec(trimmed);
  if (!match) return null;
  const key = match[1]?.trim();
  return key ? key : null;
}

export function buildDocumentReferenceHref(documentId: string, fromIssueKey?: string | null): string {
  const id = documentId.trim();
  const key = fromIssueKey?.trim();
  return key ? `/documents/${id}?from=issue:${encodeURIComponent(key)}` : `/documents/${id}`;
}

export function parseDocumentReferenceHref(href: string): ParsedDocumentReference | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/") ? new URL(raw, "https://paperclip.invalid") : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "documents") continue;
    const candidate = segments[index + 1] ?? "";
    if (DOCUMENT_ID_RE.test(candidate)) {
      return {
        documentId: candidate,
        fromIssueKey: parseFromParam(url.searchParams.get("from")),
      };
    }
  }

  return null;
}
