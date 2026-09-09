import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  isPlanningDocumentKey,
  type PlanningDocumentKey,
} from "./issue-artifacts";
import { parseDocumentAnnotationHash } from "./document-annotation-hash";

export type IssueDocumentDeepLinkRoute =
  | { kind: "continuation-summary" }
  | { kind: "properties-pane"; tab: "plans"; documentKey: PlanningDocumentKey; maximize: boolean }
  | { kind: "properties-pane"; tab: "document"; documentKey: string; maximize: boolean };

/**
 * Maps an issue document hash to the surface that owns that document.
 *
 * Canonical specification and plan documents stay together in the Plans tab;
 * every other document opens in its own tab. `viewer=full` (LOOA-2181)
 * additionally requests the maximized pane so external review links land on a
 * full-size reading surface.
 */
export function resolveIssueDocumentDeepLink(hash: string): IssueDocumentDeepLinkRoute | null {
  const target = parseDocumentAnnotationHash(hash);
  if (!target) return null;

  if (target.documentKey === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY) {
    return { kind: "continuation-summary" };
  }
  const maximize = target.viewer === "full";
  if (isPlanningDocumentKey(target.documentKey)) {
    return { kind: "properties-pane", tab: "plans", documentKey: target.documentKey, maximize };
  }
  return { kind: "properties-pane", tab: "document", documentKey: target.documentKey, maximize };
}
