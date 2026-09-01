import { describe, expect, it } from "vitest";
import { resolveIssueDocumentDeepLink } from "./issue-document-deep-link";

describe("resolveIssueDocumentDeepLink", () => {
  it("preserves continuation-summary routing", () => {
    expect(resolveIssueDocumentDeepLink("#document-continuation-summary")).toEqual({
      kind: "continuation-summary",
    });
  });

  it("routes plan to its dedicated pane tab", () => {
    expect(resolveIssueDocumentDeepLink("#document-plan")).toEqual({
      kind: "properties-pane",
      tab: "plans",
      documentKey: "plan",
    });
  });

  it("routes ordinary and annotated documents to a dedicated document tab", () => {
    expect(resolveIssueDocumentDeepLink("#document-qa%20evidence&thread=thread-1")).toEqual({
      kind: "properties-pane",
      tab: "document",
      documentKey: "qa evidence",
    });
  });

  it("ignores empty, unrelated, and malformed hashes", () => {
    expect(resolveIssueDocumentDeepLink("#document-")).toBeNull();
    expect(resolveIssueDocumentDeepLink("#work-product-1")).toBeNull();
    expect(resolveIssueDocumentDeepLink("#document-%E0%A4%A")).toBeNull();
  });
});
