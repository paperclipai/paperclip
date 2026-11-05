import { describe, expect, it } from "vitest";
import { itemVerdictHref } from "./item-verdict-links";

describe("review output links", () => {
  const interaction = { issueId: "review-task", id: "review" };
  it("pins the exact document owner and revision ahead of a supplied display URL", () => {
    expect(itemVerdictHref({ id: "copy", label: "Copy", href: "https://example.com/latest", target: {
      type: "issue_document", issueId: "output-task", key: "launch copy", revisionId: "reviewed-v2",
    } }, interaction)).toBe("/issues/output-task#document-launch%20copy&revision=reviewed-v2&interaction=review");
  });
  it("opens the immutable attachment in its owning task", () => {
    expect(itemVerdictHref({ id: "art", label: "Artwork", target: { type: "issue_attachment", issueId: "owner", attachmentId: "asset-file", assetId: "asset", sha256: "hash" } }, interaction))
      .toBe("/api/attachments/asset-file/content");
  });
  it("keeps safe legacy links and rejects unsafe custom URLs", () => {
    expect(itemVerdictHref({ id: "legacy", label: "Legacy", href: "javascript:alert(1)" }, interaction)).toBeNull();
    expect(itemVerdictHref({ id: "legacy", label: "Legacy", href: "/issues/old" }, interaction)).toBe("/issues/old");
  });
});
