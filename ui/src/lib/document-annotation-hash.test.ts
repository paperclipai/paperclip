import { describe, expect, it } from "vitest";
import {
  buildDocumentAnnotationHash,
  parseDocumentAnnotationHash,
} from "./document-annotation-hash";

describe("parseDocumentAnnotationHash", () => {
  it("returns null for non-document hashes", () => {
    expect(parseDocumentAnnotationHash("")).toBeNull();
    expect(parseDocumentAnnotationHash("#issue-foo")).toBeNull();
  });

  it("parses document key only", () => {
    expect(parseDocumentAnnotationHash("#document-plan")).toEqual({
      documentKey: "plan",
      threadId: null,
      commentId: null,
    });
  });

  it("parses thread and comment targets", () => {
    expect(
      parseDocumentAnnotationHash("#document-plan&thread=t1&comment=c2"),
    ).toEqual({
      documentKey: "plan",
      threadId: "t1",
      commentId: "c2",
    });
  });

  it("decodes URI-encoded keys", () => {
    expect(parseDocumentAnnotationHash("#document-my%20notes&thread=abc")).toEqual({
      documentKey: "my notes",
      threadId: "abc",
      commentId: null,
    });
  });
});

describe("buildDocumentAnnotationHash", () => {
  it("builds a hash without thread or comment", () => {
    expect(buildDocumentAnnotationHash({ documentKey: "plan", threadId: null, commentId: null })).toBe(
      "#document-plan",
    );
  });

  it("includes thread target", () => {
    expect(
      buildDocumentAnnotationHash({ documentKey: "plan", threadId: "t1", commentId: null }),
    ).toBe("#document-plan&thread=t1");
  });

  it("includes both targets", () => {
    expect(
      buildDocumentAnnotationHash({ documentKey: "plan", threadId: "t1", commentId: "c2" }),
    ).toBe("#document-plan&thread=t1&comment=c2");
  });

  it("survives a round trip", () => {
    const target = { documentKey: "plan-2", threadId: "t-abc", commentId: "c-xyz" };
    expect(parseDocumentAnnotationHash(buildDocumentAnnotationHash(target))).toEqual(target);
  });
});
