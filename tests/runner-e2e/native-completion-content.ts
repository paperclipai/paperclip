/** Bounded release-access fixture: an action alone is not a blocker explanation. */
export function explainsMissingReleaseAccess(text: string): boolean {
  // The requested action must not supply the access fact that the explanation lacks.
  const explanation = text.replaceAll("Grant deployment access", "");
  const access = String.raw`(?:required\s+access|(?:required\s+)?(?:release|deployment)\s+access)`;
  const absent = String.raw`(?:missing|unavailable|absent|not\s+(?:yet\s+)?(?:(?:been|being)\s+)?(?:granted|provided|available)|hasn['’]t\s+been\s+granted)`;
  if (new RegExp(String.raw`\b${access}\s+(?:is|was|has\s+been)\s+(?:not\s+(?:missing|unavailable|absent)|(?:already\s+)?(?:available|granted|provided))\b`, "i").test(explanation)) return false;
  return new RegExp(String.raw`\b${access}\b[^.!?\n]{0,100}\b${absent}\b`, "i").test(explanation)
    || new RegExp(String.raw`\b(?:missing|unavailable|lack(?:ing)?)\b[^.!?\n]{0,60}\b${access}\b`, "i").test(explanation)
    || /\b(?:deployment|release)\b[^.!?\n]{0,60}\b(?:blocked|cannot proceed|can't proceed)\b[^.!?\n]{0,60}\b(?:until|without)\b[^.!?\n]{0,60}\baccess\b/i.test(explanation);
}

export interface NativeDocumentLinkContext {
  appOrigin: string;
  issuePrefix: string;
  issueIdentifier: string;
  documents: readonly { key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null }[];
}

/** A citation must resolve to this task's one saved, revisioned document. */
export function linksSavedNativeDocument(text: string, context: NativeDocumentLinkContext | undefined): boolean {
  if (!context?.appOrigin || !context.issuePrefix || !context.issueIdentifier || context.documents.length !== 1) return false;
  const document = context.documents[0]!;
  if (!document.key || !document.latestRevisionId || !Number.isSafeInteger(document.latestRevisionNumber) || Number(document.latestRevisionNumber) < 1) return false;
  let origin: URL;
  try { origin = new URL(context.appOrigin); } catch { return false; }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return false;
  const route = `/${encodeURIComponent(context.issuePrefix)}/issues/${encodeURIComponent(context.issueIdentifier)}#document-${encodeURIComponent(document.key)}`;
  const links = text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g);
  return [...links].some(link => {
    try {
      const url = new URL(link[1] ?? link[2]!, origin);
      return url.origin === origin.origin && !url.username && !url.password && !url.search && `${url.pathname}${url.hash}` === route;
    } catch { return false; }
  });
}
