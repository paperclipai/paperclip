import { describe, expect, it } from "vitest";
import { decisionReceiptHref } from "./decision-receipt-navigation";
import { parseDocumentAnnotationHash } from "./document-annotation-hash";
import { resolveIssueDocumentDeepLink } from "./issue-document-deep-link";

describe("decision receipt navigation", () => {
  it("keeps the origin interaction while carrying a different document owner", () => {
    const href = decisionReceiptHref({ issueHref: "/PAP/issues/PAP-A", interactionId: "review-on-a", target: { type: "issue_document", issueId: "task-b", key: "plan", revisionId: "b-v1" } });
    expect(href.split("#")[0]).toBe("/PAP/issues/PAP-A");
    expect(parseDocumentAnnotationHash(href.slice(href.indexOf("#")))).toMatchObject({ documentKey: "plan", revisionId: "b-v1", documentIssueId: "task-b", interactionId: "review-on-a" });
    expect(resolveIssueDocumentDeepLink(href.slice(href.indexOf("#")))).toMatchObject({ tab: "document" });
  });
  it("keeps the decision anchor and exact plan revision instead of opening the latest plan tab", () => {
    const href = decisionReceiptHref({ issueHref: "/PAP/issues/PAP-1", interactionId: "i-1", target: { type: "issue_document", key: "plan", revisionId: "r-2" } });
    const hash = href.slice(href.indexOf("#"));
    expect(parseDocumentAnnotationHash(hash)).toMatchObject({ documentKey: "plan", interactionId: "i-1", revisionId: "r-2" });
    expect(resolveIssueDocumentDeepLink(hash)).toMatchObject({ tab: "document", documentKey: "plan" });
    expect(resolveIssueDocumentDeepLink("#document-plan")).toMatchObject({ tab: "plans" });
  });
  it("keeps custom receipt links in their task even if the payload contains an external href", () => {
    expect(decisionReceiptHref({ issueHref: "/PAP/issues/PAP-1#old", interactionId: "i-1", target: { type: "custom", key: "thing", href: "https://outside.example" } })).toBe("/PAP/issues/PAP-1#interaction-i-1");
  });
});
