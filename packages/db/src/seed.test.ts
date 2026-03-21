import { describe, expect, it } from "vitest";
import { createSampleLinkedInDraftApprovalPayload } from "./seed.js";

describe("createSampleLinkedInDraftApprovalPayload", () => {
  it("returns a sample LinkedIn draft approval payload", () => {
    const payload = createSampleLinkedInDraftApprovalPayload();

    expect(payload).toMatchObject({
      channel: "linkedin",
      requestedAction: "approve_post_copy",
    });
    expect(payload.title).toContain("LinkedIn");
    expect(payload.strategy).toContain("Comment \"guide\"");
  });
});
