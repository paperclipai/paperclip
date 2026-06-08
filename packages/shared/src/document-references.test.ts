import { describe, expect, it } from "vitest";
import { buildDocumentReferenceHref, parseDocumentReferenceHref } from "./document-references.js";

describe("parseDocumentReferenceHref", () => {
  it("parses a company-prefixed documents path", () => {
    expect(parseDocumentReferenceHref("/PAP/documents/abc-123")).toEqual({
      documentId: "abc-123",
      fromIssueKey: null,
    });
  });

  it("parses a company-relative documents path", () => {
    expect(parseDocumentReferenceHref("/documents/abc-123")).toEqual({
      documentId: "abc-123",
      fromIssueKey: null,
    });
  });

  it("extracts the originating issue key from ?from=issue:<key>", () => {
    expect(parseDocumentReferenceHref("/documents/abc-123?from=issue:plan")).toEqual({
      documentId: "abc-123",
      fromIssueKey: "plan",
    });
  });

  it("parses absolute urls", () => {
    expect(parseDocumentReferenceHref("https://app.example.com/ACME/documents/doc_9")).toEqual({
      documentId: "doc_9",
      fromIssueKey: null,
    });
  });

  it("returns null for non-document paths", () => {
    expect(parseDocumentReferenceHref("/PAP/issues/PAP-1")).toBeNull();
    expect(parseDocumentReferenceHref("/documents")).toBeNull();
    expect(parseDocumentReferenceHref("not a url at all ::::")).toBeNull();
  });

  it("round-trips with buildDocumentReferenceHref", () => {
    expect(buildDocumentReferenceHref("abc-123")).toBe("/documents/abc-123");
    expect(buildDocumentReferenceHref("abc-123", "plan")).toBe("/documents/abc-123?from=issue:plan");
    const built = buildDocumentReferenceHref("abc-123", "spec");
    expect(parseDocumentReferenceHref(built)).toEqual({ documentId: "abc-123", fromIssueKey: "spec" });
  });
});
