import { describe, expect, it } from "vitest";
import {
  attachmentArtifactWorkProductMetadataSchema,
  createIssueWorkProductSchema,
} from "./work-product.js";

describe("attachmentArtifactWorkProductMetadataSchema", () => {
  it("accepts the attachment-backed artifact metadata contract", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      openPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content?download=1",
      originalFilename: "demo.mp4",
    });

    expect(parsed.contentType).toBe("video/mp4");
    expect(parsed.downloadPath).toContain("download=1");
  });

  it("rejects off-route or scriptable paths", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.safeParse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "https://evil.example/video.mp4",
      openPath: "javascript:alert(1)",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      originalFilename: "demo.mp4",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected invalid attachment artifact metadata");
    }
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "contentPath",
      "openPath",
      "downloadPath",
    ]);
  });
});

const validInput = {
  type: "artifact",
  provider: "paperclip",
  title: "SER-377 report",
};

describe("work product validators", () => {
  it.each(["", "   "])("rejects blank externalId %j", (externalId) => {
    expect(
      createIssueWorkProductSchema.safeParse({ ...validInput, externalId }).success,
    ).toBe(false);
  });

  it("trims a non-empty externalId", () => {
    const parsed = createIssueWorkProductSchema.parse({
      ...validInput,
      externalId: "  ser377-sha-95d0653d  ",
    });

    expect(parsed.externalId).toBe("ser377-sha-95d0653d");
  });
});
