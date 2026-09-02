import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { parseDocumentAnnotationHash } from "./document-annotation-hash";

export type IssueDocumentDeepLinkRoute =
  | { kind: "continuation-summary" }
  | { kind: "properties-pane"; tab: "plans"; documentKey: "plan" }
  | { kind: "properties-pane"; tab: "document"; documentKey: string };

/**
 * Maps an issue document hash to the surface that owns that document.
 *
 * The continuation summary remains in the activity/handoff surface, the plan
 * keeps its dedicated pane tab, and every other document opens in its own tab.
 */
export function resolveIssueDocumentDeepLink(hash: string): IssueDocumentDeepLinkRoute | null {
  const target = parseDocumentAnnotationHash(hash);
  if (!target) return null;

  if (target.documentKey === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY) {
    return { kind: "continuation-summary" };
  }
  if (target.documentKey === "plan") {
    return { kind: "properties-pane", tab: "plans", documentKey: "plan" };
  }
  return { kind: "properties-pane", tab: "document", documentKey: target.documentKey };
}
