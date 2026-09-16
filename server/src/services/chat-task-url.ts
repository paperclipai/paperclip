import { sanitizeExternalChatUrl } from "./chat-publication-projection.js";

/** Omit unusable board links without weakening external publication safety. */
export function safeChatTaskUrl(
  baseUrl: string | null | undefined,
  issueId: string,
): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = `/issues/${encodeURIComponent(issueId)}`;
    url.search = "";
    url.hash = "";
    return sanitizeExternalChatUrl(url.toString());
  } catch {
    return null;
  }
}
