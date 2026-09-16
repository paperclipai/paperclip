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
      "Maya couldn't safely start this turn because this task was started for an unlinked external guest and isolated guest execution isn't available. Ask a Paperclip admin to create a private identity link for this account or enable isolated guest execution, then start a new task. Open the task in Paperclip: https://paperclip.example/issues/issue-1",
    );
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "low_trust_isolation_unavailable",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl: null,
      }),
    ).toBe(
      "Maya couldn't safely start this turn because this task was started for an unlinked external guest and isolated guest execution isn't available. Ask a Paperclip admin to create a private identity link for this account or enable isolated guest execution, then start a new task. Open the task in Paperclip for details.",
    );
  });

  it("gives permanent integrity failures a safe operator recovery path", () => {
    const text = safeMilestoneText({
      agentName: "Maya",
      errorCode: "native_event_replay_conflict",
      milestone: "failed",
      issueId: "issue-1",
    });
    expect(text).toBe(
      "Maya couldn't safely continue this turn. A Paperclip admin needs to review the run before it can be retried. Open the task in Paperclip for details.",
    );
    expect(text).not.toMatch(/digest|source.seq|semantic|replay.conflict/i);
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

  it.each([
    [null, " Open the task in Paperclip for details."],
    [
      "https://paperclip.example",
      " Open the task in Paperclip: https://paperclip.example/issues/issue-1",
    ],
  ])(
    "explains retained-session recovery without encouraging duplicate requests (%s)",
    (publicBaseUrl, suffix) => {
      const text = safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_session_cleanup_quarantined",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl,
      });
      expect(text).toBe(
        "Maya couldn't start this turn because an earlier session needs recovery. Your request is saved. Ask a Paperclip admin to recover that session before retrying; sending the request again won't repair it." +
          suffix,
      );
      expect(text).not.toMatch(
        /quarantin|checkpoint|process|native_session|runnerId|reset/i,
      );
      expect(
        projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text,
          progressState: "failed",
        }),
      ).toEqual({ text, progressState: "failed" });
    },
  );

  it("describes ownership recovery without claiming the retained process stopped", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_execution_ownership_unverified",
        milestone: "waiting_for_input",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya needs a Paperclip admin to safely recover this turn before more work can start. Open the task in Paperclip for details.",
    );
  });

  it.each(["server_shutdown_interrupted", "lease_released_before_terminal"])(
    "keeps interruption bookkeeping for %s inside Paperclip",
    (errorCode) => {
      expect(
        safeMilestoneText({
          agentName: "Maya",
          errorCode,
          milestone: "failed",
          issueId: "issue-1",
        }),
      ).toBe(
        "Maya stopped before completing this turn. Open the task in Paperclip for details.",
      );
    },
  );

  it("explains an allowlisted native provider capacity failure without exposing provider details", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_provider_usage_limit",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya couldn't complete this turn because the model provider's usage allowance is exhausted. A Paperclip admin needs to restore capacity before retrying. Open the task in Paperclip for details.",
    );
  });

  it("confirms an explicit Slack Stop without claiming an unexpected failure", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "slack_session_stopped",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe("Maya stopped at your request.");
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
    "allow_chat_run_presentation",
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
