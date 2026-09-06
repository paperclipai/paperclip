import { describe, expect, it } from "vitest";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { safeMilestoneText } from "./chat-run-publications.js";

describe("chat run milestone projection", () => {
  it("allows only safe lifecycle state and text through the shared projection", () => {
    expect(
      projectSafeChatPublication({
        classification: "external",
        source: "safe_milestone",
        text: "Maya is working…",
        progressState: "working",
      }),
    ).toEqual({ text: "Maya is working…", progressState: "working" });
    expect(
      JSON.stringify(
        projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text: "Maya stopped before completing this turn.",
          progressState: "failed",
        }),
      ),
    ).not.toContain("stderr");
  });

  it("gives unlinked external identities a safe recovery path when isolation is unavailable", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "low_trust_isolation_unavailable",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl: "https://paperclip.example/path",
      }),
    ).toBe(
      "Maya couldn't safely start this turn because this external identity isn't linked to Paperclip and isolated guest execution isn't available. Link your identity to Paperclip, or ask a Paperclip admin to enable isolated guest execution. Open the task in Paperclip: https://paperclip.example/issues/issue-1",
    );
  });

  it("keeps every other run failure generic outside Paperclip", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "provider_secret_in_error_code",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya stopped before completing this turn. Open the task in Paperclip for details.",
    );
  });
});
