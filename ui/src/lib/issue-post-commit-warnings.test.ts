import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { issuePostCommitWarningBody } from "./issue-post-commit-warnings";

describe("issuePostCommitWarningBody", () => {
  it("joins warning messages for display", () => {
    const issue = {
      postCommitWarnings: [
        { code: "reference", message: "References are incomplete." },
        { code: "publication", message: "Live activity was not published." },
      ],
    } as Issue;

    expect(issuePostCommitWarningBody(issue)).toBe(
      "References are incomplete. Live activity was not published.",
    );
  });

  it("returns null when the response has no warnings", () => {
    expect(issuePostCommitWarningBody({} as Issue)).toBeNull();
  });
});
