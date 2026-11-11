import { readConfigFile } from "../config-file.js";
import { runtimeCanonicalOrigin } from "./cloud-runtime-identity.js";
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

/** Resolve at use time so a claimed Cloud instance never advertises its pool URL. */
export function publicChatTaskUrl(issueId: string): string | null {
  const configured =
    runtimeCanonicalOrigin() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim() ||
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    readConfigFile()?.auth?.publicBaseUrl?.trim() ||
    process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL?.trim();
  return safeChatTaskUrl(configured, issueId);
}
