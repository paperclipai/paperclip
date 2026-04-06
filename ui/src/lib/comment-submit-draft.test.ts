import { describe, expect, it } from "vitest";
import { restoreSubmittedCommentDraft } from "./comment-submit-draft";

describe("restoreSubmittedCommentDraft", () => {
  it("restores the submitted body when the editor is still empty after a failed request", () => {
    expect(
      restoreSubmittedCommentDraft({
        currentBody: "",
        submittedBody: "Retry me",
      }),
    ).toBe("Retry me");
  });

  it("treats whitespace-only input as empty when restoring a failed draft", () => {
    expect(
      restoreSubmittedCommentDraft({
        currentBody: "   ",
        submittedBody: "Retry me",
      }),
    ).toBe("Retry me");
  });

  it("preserves newer input when the user has already typed again", () => {
    expect(
      restoreSubmittedCommentDraft({
        currentBody: "new draft",
        submittedBody: "Retry me",
      }),
    ).toBe("new draft");
  });
});
