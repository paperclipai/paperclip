import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  formatActivityEntityLabel,
  formatActivityOutcome,
  formatActivityVerb,
  formatIssueActivityAction,
} from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("labels a Slack settlement as idle while retaining actual review wording", () => {
    const details = { status: "in_review", externalConversationState: "waiting" };
    expect(formatActivityVerb("issue.updated", details)).toBe("changed status to idle on");
    expect(formatIssueActivityAction("issue.updated", details)).toBe("changed the status to idle");
    expect(formatActivityVerb("issue.updated", { status: "in_review" })).toBe("changed status to in review on");
  });

  it("uses readable verbs for task read-state changes", () => {
    expect(formatActivityVerb("issue.read_marked")).toBe("read");
    expect(formatActivityVerb("issue.read_unmarked")).toBe("marked unread");
  });

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });

  it("formats monitor activity with direct verbs", () => {
    expect(formatActivityVerb("issue.monitor_scheduled")).toBe("scheduled monitor on");
    expect(formatActivityVerb("issue.monitor_exhausted")).toBe("exhausted monitor on");
    expect(formatIssueActivityAction("issue.monitor_triggered")).toBe("triggered a monitor");
    expect(formatIssueActivityAction("issue.monitor_cleared")).toBe("cleared a monitor");
    expect(formatIssueActivityAction("issue.monitor_recovery_issue_created")).toBe("created a monitor recovery issue");
  });

  it("labels each queued-comment queue mutation", () => {
    expect(formatActivityVerb("issue.queued_comment_edited")).toBe("edited a queued comment on");
    expect(formatActivityVerb("issue.queued_comments_reordered")).toBe("reordered queued comments on");
    expect(formatActivityVerb("issue.queued_comment_discarded")).toBe("discarded a queued comment on");
    expect(formatIssueActivityAction("issue.queued_comment_edited")).toBe("edited a queued comment");
    expect(formatIssueActivityAction("issue.queued_comments_reordered")).toBe("reordered queued comments");
    expect(formatIssueActivityAction("issue.queued_comment_discarded")).toBe("discarded a queued comment");
  });

  // PAP-16506 P4: agents can now resolve an interaction, including a review of
  // their own work, so an outcome has to read as an outcome in the timeline
  // instead of leaking the raw action id.
  it("reads an interaction outcome as an outcome, whoever gave it", () => {
    expect(formatIssueActivityAction("issue.thread_interaction_accepted")).toBe("accepted the request");
    expect(formatIssueActivityAction("issue.thread_interaction_rejected")).toBe("rejected the request");
    expect(formatIssueActivityAction("issue.thread_interaction_withdrawn")).toBe("withdrew the request");
    expect(formatIssueActivityAction("issue.thread_interaction_expired")).toBe("expired the request");
    expect(formatActivityVerb("issue.thread_interaction_accepted")).toBe("accepted the request on");
    expect(formatActivityVerb("issue.thread_interaction_rejected")).toBe("rejected the request on");
  });

  // The accepted/rejected actions fire for every interaction kind, so only a
  // confirmation may read as an approval.
  it("says 'approved' only for a confirmation, never for a suggestion or a question", () => {
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "request_confirmation" }))
      .toBe("approved the request");
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "request_checkbox_confirmation" }))
      .toBe("approved the request");
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "suggest_tasks" }))
      .toBe("accepted the task suggestions");
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "ask_user_questions" }))
      .toBe("accepted the answers");
    expect(formatIssueActivityAction("issue.thread_interaction_rejected", { interactionKind: "request_confirmation" }))
      .toBe("rejected the request");
    expect(formatIssueActivityAction("issue.thread_interaction_rejected", { interactionKind: "suggest_tasks" }))
      .toBe("declined the task suggestions");
    expect(formatActivityVerb("issue.thread_interaction_accepted", { interactionKind: "suggest_tasks" }))
      .toBe("accepted the task suggestions on");
  });

  it("keeps the neutral wording for a kind it does not know", () => {
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "request_item_verdicts" }))
      .toBe("accepted the request");
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: "future_kind" }))
      .toBe("accepted the request");
    expect(formatIssueActivityAction("issue.thread_interaction_accepted", { interactionKind: 7 }))
      .toBe("accepted the request");
  });

  it("names the verb an actor chose on a stalled review", () => {
    expect(formatIssueActivityAction("issue.stalled_review_decided", { action: "approve" }))
      .toBe("approved the review");
    expect(formatIssueActivityAction("issue.stalled_review_decided", { action: "request_changes" }))
      .toBe("requested changes on the review");
    expect(formatIssueActivityAction("issue.stalled_review_decided", { action: "send_back" }))
      .toBe("sent the review back to work");
    expect(formatActivityVerb("issue.stalled_review_decided", { action: "approve" }))
      .toBe("approved the review on");
  });

  it("falls back to a generic verdict line when the decision verb is missing", () => {
    expect(formatIssueActivityAction("issue.stalled_review_decided")).toBe("recorded a review verdict");
    expect(formatIssueActivityAction("issue.stalled_review_decided", { action: "shrug" }))
      .toBe("recorded a review verdict");
  });

  it("describes a review-policy change without calling the default 'none'", () => {
    expect(formatIssueActivityAction("issue.updated", { reviewPolicy: null }))
      .toBe("changed who can approve to anyone");
    expect(formatIssueActivityAction("issue.updated", { reviewPolicy: "human_only" }))
      .toBe("changed who can approve to human only");
    expect(formatIssueActivityAction("issue.updated", { reviewPolicy: "not_creator" }))
      .toBe("changed who can approve to anyone else");
  });

  it("uses plain next-step copy for successful-run handoff activity", () => {
    expect(formatActivityVerb("issue.successful_run_handoff_required")).toBe("flagged missing next step on");
    expect(formatIssueActivityAction("issue.successful_run_handoff_required")).toBe("Run finished without a clear next step");
    expect(formatIssueActivityAction("issue.successful_run_handoff_resolved")).toBe("Next step chosen");
    expect(formatIssueActivityAction("issue.successful_run_handoff_escalated")).toBe(
      "Run finished without a next step - recovery escalated",
    );
  });
  describe("connected app activity", () => {
    const connectionId = "7f3c2a10-5b4e-4d2a-9c1f-0e8d6b5a4c3d";
    const gatewayName = "mcp.google-workspace-7f3c2a10:gmail-get-message";
    const internalName = /__|[a-z]_[a-z]|[0-9a-f]{8}-[0-9a-f]{4}|7f3c2a10/i;

    it("names Google Workspace actions with the same label as the Permissions page", () => {
      const details = { tool: gatewayName, upstreamToolName: "gmail__get_message", connectionId };
      expect(formatActivityVerb("tool_gateway.call_completed", details)).toBe("used Gmail: Get message on");
      expect(formatActivityVerb("tool_gateway.call_completed", { ...details, source: "test" })).toBe("tested Gmail: Get message on");
      expect(formatActivityVerb("tool_gateway.call_denied", details)).toBe("was blocked from using Gmail: Get message on");
      expect(formatActivityVerb("tool_gateway.approval_requested", details)).toBe("asked to use Gmail: Get message on");
      expect(formatActivityVerb("tool_gateway.call_completed", { ...details, toolTitle: "Read a message" }))
        .toBe("used Gmail: Read a message on");
      for (const action of [
        "tool_gateway.call_completed", "tool_gateway.call_allowed", "tool_gateway.call_denied",
        "tool_gateway.approval_requested", "tool_gateway.call_failed", "tool_gateway.call_deferred",
      ]) {
        expect(formatActivityVerb(action, details)).not.toMatch(internalName);
      }
    });

    it("keeps a readable name for other tools", () => {
      expect(formatActivityVerb("tool_gateway.call_completed", { tool: "get_repository" })).toBe("used get repository on");
      expect(formatActivityVerb("tool_gateway.call_completed", { tool: "create_issue", toolTitle: "Create issue" }))
        .toBe("used Create issue on");
      expect(formatActivityVerb("tool_gateway.call_denied", {})).toBe("was blocked from using an app action on");
    });

    it("describes failed and delayed calls in words", () => {
      const details = { upstreamToolName: "calendar__list_events" };
      expect(formatActivityVerb("tool_gateway.call_failed", details)).toBe("could not use Calendar: List events on");
      expect(formatActivityVerb("tool_gateway.call_deferred", details)).toBe("could not finish using Calendar: List events on");
      expect(formatActivityVerb("tool_gateway.call_deferred", { ...details, source: "test" })).toBe("could not finish testing Calendar: List events on");
    });

    it("drops the connection namespace when a row has only the gateway tool name", () => {
      const verb = formatActivityVerb("tool_gateway.call_failed", { tool: gatewayName, connectionId });
      expect(verb).toBe("could not use gmail get message on");
      expect(verb).not.toMatch(internalName);
    });

    it("drops the length-bound hash from a long gateway tool name", () => {
      const verb = formatActivityVerb("tool_gateway.call_failed", {
        tool: "mcp.app-gallery-github-connection:create-repository-0123456789abcdef",
        connectionId,
      });
      expect(verb).toBe("could not use create repository on");
    });

    it("names a Google connection when its removal reports Google access", () => {
      const providerAccess = { provider: "google", result: "ended", outcomes: [] };
      expect(formatActivityVerb("tool_connection.archived", { transport: "remote_http", providerAccess })).toBe("removed");
      expect(formatActivityEntityLabel("tool_connection", { providerAccess })).toBe("the Google Workspace connection");
      expect(formatActivityEntityLabel("tool_connection", { transport: "remote_http" })).toBe("the connection");
      expect(formatActivityOutcome("tool_connection.archived", { providerAccess })).toBeNull();
    });

    it("reads app removal as a sentence with the app's name", () => {
      const details = { type: "mcp", name: "Google Workspace", reason: "last_connection_removed" };
      expect(formatActivityVerb("tool_application.archived", details)).toBe("removed");
      expect(formatActivityEntityLabel("tool_application", details)).toBe("Google Workspace");
      expect(formatActivityOutcome("tool_application.archived", details)).toBe("Its last connection was removed.");
      expect(formatActivityEntityLabel("tool_application", {})).toBe("the app");
      expect(formatActivityEntityLabel("heartbeat_run", {})).toBe("a run");
      expect(formatActivityEntityLabel("company", {})).toBe("the organization");
    });

    it("describes stored content deletion in words", () => {
      expect(formatActivityVerb("tool_connection.content_deletion_requested")).toBe("asked to delete stored content from");
      expect(formatActivityVerb("tool_connection.content_deleted")).toBe("deleted stored content from");
      expect(formatActivityVerb("issue.connection_content_deleted")).toBe("deleted connected app content from");
      expect(formatActivityVerb("issue.connection_content_deletion_incomplete")).toBe("partly deleted connected app content from");
      expect(formatIssueActivityAction("issue.connection_content_deleted")).toBe("deleted connected app content");
      expect(formatIssueActivityAction("issue.connection_content_deletion_incomplete"))
        .toBe("partly deleted connected app content; some is still in use");
    });

    it("reads connect and reconnect rows without internal names", () => {
      expect(formatActivityVerb("tool_app.connected", { galleryKey: "google_workspace", applicationId: connectionId })).toBe("connected");
      expect(formatActivityVerb("tool_app.reconnected", { healthStatus: "healthy" })).toBe("reconnected");
    });
  });
});
