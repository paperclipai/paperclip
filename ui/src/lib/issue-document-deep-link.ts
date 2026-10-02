import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { parseDocumentAnnotationHash } from "./document-annotation-hash";

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

  if (target.documentKey === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY) {
    return { kind: "continuation-summary" };
  }
  const maximize = target.viewer === "full";
  if (target.documentKey === "plan") {
    return { kind: "properties-pane", tab: "plans", documentKey: "plan", maximize };
  }
  return { kind: "properties-pane", tab: "document", documentKey: target.documentKey, maximize };
}
