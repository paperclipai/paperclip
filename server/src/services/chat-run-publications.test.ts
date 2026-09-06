import { describe, expect, it } from "vitest";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { safeMilestoneText } from "./chat-run-publications.js";
import { isExplicitExternalAgentComment } from "./issues.js";

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

  it("projects a successful run without an explicit reply as a generic completion", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        milestone: "completed",
        issueId: "issue-1",
      }),
    ).toBe("Maya completed this turn.");
  });
});

describe("chat agent comment publication authorization", () => {
  const metadata = (authorizationReason: string | null) => ({
    version: 1 as const,
    authorizationReason,
    sections: [
      {
        title: "Authorization",
        rows: [
          {
            type: "key_value" as const,
            label: "Reason",
            value: authorizationReason ?? "none",
          },
        ],
      },
    ],
  });

  it.each([
    "paperclip_runner_protocol",
    "allow_visible_issue_write",
    "allow_scoped_agent_write",
  ])("allows an explicitly authored agent reply with reason %s", (reason) => {
    expect(isExplicitExternalAgentComment(metadata(reason))).toBe(true);
  });

  it.each([
    "internal_agent_write",
    "execution_workspace_branch_reconcile",
    "",
    null,
  ])(
    "keeps an internal agent comment with reason %s inside Paperclip",
    (reason) => {
      expect(isExplicitExternalAgentComment(metadata(reason))).toBe(false);
    },
  );
});
