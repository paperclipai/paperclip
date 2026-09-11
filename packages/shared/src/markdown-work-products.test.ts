import { describe, expect, it } from "vitest";
import {
  ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX,
  artifactReviewDocumentKey,
  getAttachmentArtifactWorkProductMetadata,
  getMarkdownWorkProductAttachmentMetadata,
  isArtifactReviewDocumentKey,
  isMarkdownArtifactWorkProduct,
  isMarkdownAttachmentContent,
  workProductIdFromArtifactReviewDocumentKey,
} from "./markdown-work-products.js";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const WORK_PRODUCT_ID = "11111111-2222-4333-8444-555555555555";

function attachmentMetadata(overrides: Record<string, unknown> = {}) {
  const contentPath = `/api/attachments/${ATTACHMENT_ID}/content`;
  return {
    attachmentId: ATTACHMENT_ID,
    contentType: "text/markdown",
    byteSize: 128,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    originalFilename: "notes.md",
    ...overrides,
  };
}

function workProduct(overrides: Record<string, unknown> = {}) {
  return {
    type: "artifact" as const,
    provider: "paperclip",
    metadata: attachmentMetadata(),
    ...overrides,
  };
}

describe("isMarkdownAttachmentContent", () => {
  it.each([
    "text/markdown",
    "text/x-markdown",
    "application/markdown",
    "application/x-markdown",
  ])("accepts %s regardless of filename", (contentType) => {
    expect(isMarkdownAttachmentContent({ contentType, originalFilename: null })).toBe(true);
  });

  it("ignores MIME parameters and case", () => {
    expect(
      isMarkdownAttachmentContent({
        contentType: "Text/Markdown; charset=utf-8",
        originalFilename: null,
      }),
    ).toBe(true);
  });

  it.each([
    "text/plain",
    "application/octet-stream",
    "binary/octet-stream",
    "application/x-binary",
  ])("accepts a .md filename when the content type is %s", (contentType) => {
    expect(isMarkdownAttachmentContent({ contentType, originalFilename: "README.md" })).toBe(true);
  });

  it("accepts a .markdown filename with a generic content type", () => {
    expect(
      isMarkdownAttachmentContent({
        contentType: "application/octet-stream",
        originalFilename: "guide.markdown",
      }),
    ).toBe(true);
  });

  it("rejects .mdx files", () => {
    expect(
      isMarkdownAttachmentContent({
        contentType: "application/octet-stream",
        originalFilename: "page.mdx",
      }),
    ).toBe(false);
    expect(
      isMarkdownAttachmentContent({ contentType: "text/plain", originalFilename: "page.mdx" }),
    ).toBe(false);
  });

  it("rejects markdown filenames with non-generic content types", () => {
    expect(
      isMarkdownAttachmentContent({ contentType: "text/html", originalFilename: "notes.md" }),
    ).toBe(false);
  });

  it("rejects non-markdown filenames with generic content types", () => {
    expect(
      isMarkdownAttachmentContent({ contentType: "text/plain", originalFilename: "notes.txt" }),
    ).toBe(false);
  });

  it("rejects a missing content type", () => {
    expect(isMarkdownAttachmentContent({ contentType: null, originalFilename: "notes.md" })).toBe(
      false,
    );
  });
});

describe("getAttachmentArtifactWorkProductMetadata", () => {
  it("returns canonical metadata for a valid paperclip artifact work product", () => {
    const metadata = getAttachmentArtifactWorkProductMetadata(workProduct());
    expect(metadata?.attachmentId).toBe(ATTACHMENT_ID);
  });

  it("returns null for non-artifact work products", () => {
    expect(getAttachmentArtifactWorkProductMetadata(workProduct({ type: "document" }))).toBeNull();
  });

  it("returns null for non-paperclip providers", () => {
    expect(getAttachmentArtifactWorkProductMetadata(workProduct({ provider: "github" }))).toBeNull();
  });

  it("returns null when metadata is missing or non-canonical", () => {
    expect(getAttachmentArtifactWorkProductMetadata(workProduct({ metadata: null }))).toBeNull();
    expect(
      getAttachmentArtifactWorkProductMetadata(
        workProduct({
          metadata: attachmentMetadata({ openPath: "https://evil.example/content" }),
        }),
      ),
    ).toBeNull();
  });
});

describe("getMarkdownWorkProductAttachmentMetadata", () => {
  it("returns metadata only when the attachment is markdown-eligible", () => {
    expect(getMarkdownWorkProductAttachmentMetadata(workProduct())).not.toBeNull();
    expect(
      getMarkdownWorkProductAttachmentMetadata(
        workProduct({
          metadata: attachmentMetadata({ contentType: "application/pdf", originalFilename: "a.pdf" }),
        }),
      ),
    ).toBeNull();
  });

  it("backs the boolean eligibility helper", () => {
    expect(isMarkdownArtifactWorkProduct(workProduct())).toBe(true);
    expect(
      isMarkdownArtifactWorkProduct(
        workProduct({
          metadata: attachmentMetadata({ contentType: "image/png", originalFilename: "a.png" }),
        }),
      ),
    ).toBe(false);
  });
});

describe("artifact review document keys", () => {
  it("builds a deterministic key that fits the 64-character document key limit", () => {
    const key = artifactReviewDocumentKey(WORK_PRODUCT_ID);
    expect(key).toBe(`artifact-review-${WORK_PRODUCT_ID}`);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("identifies proxy review-document keys", () => {
    expect(isArtifactReviewDocumentKey(artifactReviewDocumentKey(WORK_PRODUCT_ID))).toBe(true);
    expect(isArtifactReviewDocumentKey("plan")).toBe(false);
    expect(isArtifactReviewDocumentKey("notes")).toBe(false);
    expect(isArtifactReviewDocumentKey(ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX)).toBe(false);
  });

  it("round-trips the work product id", () => {
    expect(
      workProductIdFromArtifactReviewDocumentKey(artifactReviewDocumentKey(WORK_PRODUCT_ID)),
    ).toBe(WORK_PRODUCT_ID);
    expect(workProductIdFromArtifactReviewDocumentKey("plan")).toBeNull();
  });
});
