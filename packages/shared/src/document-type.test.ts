import { describe, expect, it } from "vitest";
import { documentTypeForIssueDocumentKey } from "./constants.js";

describe("documentTypeForIssueDocumentKey", () => {
  it("maps known categorical keys to their document type", () => {
    expect(documentTypeForIssueDocumentKey("plan")).toBe("plan");
    expect(documentTypeForIssueDocumentKey("spec")).toBe("spec");
    expect(documentTypeForIssueDocumentKey("brief")).toBe("brief");
    expect(documentTypeForIssueDocumentKey("report")).toBe("report");
  });

  it("strips the locked-document numeric suffix before matching", () => {
    expect(documentTypeForIssueDocumentKey("plan-2")).toBe("plan");
    expect(documentTypeForIssueDocumentKey("report-17")).toBe("report");
  });

  it("normalizes case and whitespace", () => {
    expect(documentTypeForIssueDocumentKey("  Plan  ")).toBe("plan");
  });

  it("falls back to other for unknown or system keys", () => {
    expect(documentTypeForIssueDocumentKey("continuation-summary")).toBe("other");
    expect(documentTypeForIssueDocumentKey("browsable-files")).toBe("other");
    expect(documentTypeForIssueDocumentKey("planning")).toBe("other");
    expect(documentTypeForIssueDocumentKey("plan-notes")).toBe("other");
  });
});
