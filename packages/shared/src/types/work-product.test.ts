import { describe, expect, it } from "vitest";
import {
  isIssueArtifactWorkProductMetadata,
  parseIssueArtifactWorkProductMetadata,
} from "./work-product.js";

const baseMetadata = {
  attachmentId: "11111111-1111-4111-8111-111111111111",
  contentPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
  sourcePath: "deliverables/final-packet.md",
  contentType: "text/markdown",
  originalFilename: "final-packet.md",
};

describe("issue artifact work product metadata types", () => {
  it("keeps the strict type guard rejecting zero-byte metadata", () => {
    expect(isIssueArtifactWorkProductMetadata({
      ...baseMetadata,
      byteSize: 0,
    })).toBe(false);
  });

  it("still parses stored zero-byte metadata for cleanup-oriented read paths", () => {
    expect(parseIssueArtifactWorkProductMetadata({
      type: "artifact",
      metadata: {
        ...baseMetadata,
        byteSize: 0,
      },
    })).toEqual({
      ...baseMetadata,
      byteSize: 0,
    });
  });
});
