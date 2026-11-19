import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { buildDocumentAnnotationHash, parseDocumentAnnotationHash } from "./document-annotation-hash";

const ISSUE_DETAIL_PATH = /^(?:\/([^/]+))?\/issues\/([^/]+)\/?$/;

export type IssueDocumentDeepLinkRoute =
  | { kind: "continuation-summary" }
  | { kind: "properties-pane"; tab: "plans"; documentKey: "plan"; maximize: boolean }
  | { kind: "properties-pane"; tab: "document"; documentKey: string; maximize: boolean };

/**
 * Maps an issue document hash to the surface that owns that document.
 *
 * The continuation summary remains in the activity/handoff surface, the plan
 * keeps its dedicated pane tab, and every other document opens in its own tab.
 * `viewer=full` (LOOA-2181) additionally requests the maximized pane so
 * external links (Slack approval cards) land on a full-size reading surface.
 */
export function resolveIssueDocumentDeepLink(hash: string): IssueDocumentDeepLinkRoute | null {
  const target = parseDocumentAnnotationHash(hash);
  if (!target) return null;

  if (target.documentKey === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY && !target.documentIssueId) {
    return { kind: "continuation-summary" };
  }
  const maximize = target.viewer === "full";
  if (target.documentKey === "plan" && !target.revisionId && !target.documentIssueId) {
    return { kind: "properties-pane", tab: "plans", documentKey: "plan", maximize };
  }
  return { kind: "properties-pane", tab: "document", documentKey: target.documentKey, maximize };
}

/** Resolve document links to this task, including its UUID/identifier aliases. */
export function sameIssueDocumentHash(href: string, currentUrl: URL, issueReferences: string[]): string | null {
  let target: URL;
  try { target = new URL(href, currentUrl); } catch { return null; }
  if (target.origin !== currentUrl.origin || target.search !== currentUrl.search || !resolveIssueDocumentDeepLink(target.hash)) return null;
  if (target.pathname === currentUrl.pathname) return target.hash;
  const current = currentUrl.pathname.match(ISSUE_DETAIL_PATH);
  const next = target.pathname.match(ISSUE_DETAIL_PATH);
  if (!current || !next || (next[1] && next[1] !== current[1])) return null;
  try {
    const reference = decodeURIComponent(next[2]!).toLowerCase();
    return issueReferences.some((id) => id.toLowerCase() === reference) ? target.hash : null;
  } catch { return null; }
}

export function chatSidebarDocumentHash(href: string, currentUrl: URL, issueReferences: string[]): string | null {
  let url: URL;
  try { url = new URL(href, currentUrl); } catch { return null; }
  if (url.origin !== currentUrl.origin || (url.search && url.search !== currentUrl.search)) return null;
  const target = parseDocumentAnnotationHash(url.hash);
  if (!target) return null;
  if (url.pathname === currentUrl.pathname) return url.hash;

  const task = url.pathname.match(ISSUE_DETAIL_PATH);
  const chatPrefix = currentUrl.pathname.match(/^\/([^/]+)\/chats\//)?.[1];
  if (!task || (task[1] && task[1].toLowerCase() !== chatPrefix?.toLowerCase())) return null;
  let owner: string;
  try { owner = target.documentIssueId ?? decodeURIComponent(task[2]!); } catch { return null; }
  if (!/^[\w-]+$/.test(owner)) return null;
  const ownsDocument = issueReferences.some((id) => id.toLowerCase() === owner.toLowerCase());
  return buildDocumentAnnotationHash({ ...target, documentIssueId: ownsDocument ? undefined : owner });
}
