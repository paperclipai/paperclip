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
      viewer: null,
    });
  });

  it("parses thread and comment targets", () => {
    expect(
      parseDocumentAnnotationHash("#document-plan&thread=t1&comment=c2"),
    ).toEqual({
      documentKey: "plan",
      threadId: "t1",
      commentId: "c2",
      viewer: null,
    });
  });

  it("parses the viewer=full request", () => {
    expect(parseDocumentAnnotationHash("#document-direction-package&viewer=full")).toEqual({
      documentKey: "direction-package",
      threadId: null,
      commentId: null,
      viewer: "full",
    });
  });

  it("ignores unknown viewer values", () => {
    expect(parseDocumentAnnotationHash("#document-plan&viewer=huge")).toEqual({
      documentKey: "plan",
      threadId: null,
      commentId: null,
      viewer: null,
    });
  });

  it("decodes URI-encoded keys", () => {
    expect(parseDocumentAnnotationHash("#document-my%20notes&thread=abc")).toEqual({
      documentKey: "my notes",
      threadId: "abc",
      commentId: null,
      viewer: null,
    });
  });

  it("returns null for a malformed encoded document key", () => {
    expect(parseDocumentAnnotationHash("#document-%E0%A4%A")).toBeNull();
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

  it("includes the viewer request", () => {
    expect(
      buildDocumentAnnotationHash({
        documentKey: "direction-package",
        threadId: null,
        commentId: null,
        viewer: "full",
      }),
    ).toBe("#document-direction-package&viewer=full");
  });

  it("survives a round trip", () => {
    const target = {
      documentKey: "plan-2",
      threadId: "t-abc",
      commentId: "c-xyz",
      viewer: "full" as const,
    };
    expect(parseDocumentAnnotationHash(buildDocumentAnnotationHash(target))).toEqual(target);
  });
});
