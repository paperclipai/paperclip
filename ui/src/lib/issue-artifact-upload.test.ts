import { describe, expect, it } from "vitest";
import { isArtifactReviewDocumentKey, isSystemIssueDocumentKey, issueDocumentKeySchema } from "@paperclipai/shared";
import { uploadedDocumentKey } from "./issue-artifact-upload";

describe("uploadedDocumentKey", () => {
  it.each(["artifact-review-notes", "continuation-summary", "pipeline-case-body"])("keeps %s uploads visible and separate from internal documents", (reserved) => {
    const key = uploadedDocumentKey(`${reserved}.md`, [reserved]);
    expect(key).toBe(`upload-${reserved}`);
    expect(isArtifactReviewDocumentKey(key)).toBe(false);
    expect(isSystemIssueDocumentKey(key)).toBe(false);
    expect(uploadedDocumentKey(`${reserved}.md`, [key])).toBe(`${key}-2`);
  });

  it("preserves existing filename-derived documents and bounds long keys", () => {
    expect(uploadedDocumentKey("Core handoff.md", ["core-handoff", "core-handoff-2"])).toBe("core-handoff-3");
    const filename = `artifact-review-${"notes-".repeat(30)}.md`;
    const first = uploadedDocumentKey(filename, []);
    const repeated = uploadedDocumentKey(filename, [first]);
    expect(issueDocumentKeySchema.safeParse(repeated).success).toBe(true);
    expect(isArtifactReviewDocumentKey(repeated)).toBe(false);
    expect(repeated).not.toBe(first);
  });
});
