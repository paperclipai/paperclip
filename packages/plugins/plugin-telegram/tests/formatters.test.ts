import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "../src/formatters.js";
import type { IssueEventPayload, ApprovalEventPayload, AgentRunEventPayload } from "../src/types.js";

function makeEvent<T>(payload: T, entityId = "ent_1"): PluginEvent<T> {
  return {
    type: "test",
    entityId,
    entityType: "issue",
    payload,
    metadata: {},
  } as unknown as PluginEvent<T>;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title in output", () => {
    const event = makeEvent<IssueEventPayload>({
      identifier: "PAP-42",
      title: "Fix login bug",
      status: "todo",
      priority: "high",
    });

    const result = formatIssueCreated(event);

    expect(result.text).toContain("PAP\\-42");
    expect(result.text).toContain("Fix login bug");
    expect(result.text).toContain("Issue Created");
    expect(result.options.parseMode).toBe("MarkdownV2");
  });

  it("includes optional metadata when present", () => {
    const event = makeEvent<IssueEventPayload>({
      identifier: "PAP-1",
      title: "Task",
      status: "in_progress",
      priority: "critical",
      assigneeName: "Alice",
      projectName: "Backend",
    });

    const result = formatIssueCreated(event);

    expect(result.text).toContain("in\\_progress");
    expect(result.text).toContain("critical");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("Backend");
  });

  it("falls back to entityId when identifier is missing", () => {
    const event = makeEvent<IssueEventPayload>({ title: "No ID task" }, "fallback_id");

    const result = formatIssueCreated(event);

    expect(result.text).toContain("fallback\\_id");
  });

  it("truncates long descriptions", () => {
    const longDesc = "A".repeat(300);
    const event = makeEvent<IssueEventPayload>({
      identifier: "PAP-99",
      title: "Long desc",
      description: longDesc,
    });

    const result = formatIssueCreated(event);

    // Description should be truncated to ~200 chars + ellipsis
    expect(result.text.length).toBeLessThan(longDesc.length + 100);
  });
});

describe("formatIssueDone", () => {
  it("formats completed issue message", () => {
    const event = makeEvent<IssueEventPayload>({
      identifier: "PAP-10",
      title: "Deploy v2",
    });

    const result = formatIssueDone(event);

    expect(result.text).toContain("Issue Completed");
    expect(result.text).toContain("PAP\\-10");
    expect(result.text).toContain("Deploy v2");
    expect(result.text).toContain("done");
    expect(result.options.parseMode).toBe("MarkdownV2");
  });
});

describe("formatApprovalCreated", () => {
  it("formats approval with inline keyboard buttons", () => {
    const event = makeEvent<ApprovalEventPayload>({
      type: "hire",
      approvalId: "apr_123",
      title: "Hire new engineer",
      agentName: "CEO",
    });

    const result = formatApprovalCreated(event);

    expect(result.text).toContain("Approval Requested");
    expect(result.text).toContain("Hire new engineer");
    expect(result.text).toContain("CEO");
    expect(result.text).toContain("hire");
    expect(result.options.parseMode).toBe("MarkdownV2");
    expect(result.options.inlineKeyboard).toHaveLength(1);
    expect(result.options.inlineKeyboard![0]).toHaveLength(2);
    expect(result.options.inlineKeyboard![0][0].text).toBe("Approve");
    expect(result.options.inlineKeyboard![0][0].callback_data).toBe("approve_apr_123");
    expect(result.options.inlineKeyboard![0][1].text).toBe("Reject");
    expect(result.options.inlineKeyboard![0][1].callback_data).toBe("reject_apr_123");
  });

  it("includes linked issues when present", () => {
    const event = makeEvent<ApprovalEventPayload>({
      approvalId: "apr_456",
      title: "Budget approval",
      linkedIssues: [
        { identifier: "PAP-1", title: "Task A", status: "todo", priority: "high", assignee: "Bob" },
        { identifier: "PAP-2", title: "Task B" },
      ],
    });

    const result = formatApprovalCreated(event);

    expect(result.text).toContain("Linked Issues");
    expect(result.text).toContain("PAP\\-1");
    expect(result.text).toContain("Task A");
    expect(result.text).toContain("PAP\\-2");
  });

  it("falls back to entityId when approvalId is missing", () => {
    const event = makeEvent<ApprovalEventPayload>({ title: "Some approval" }, "entity_fallback");

    const result = formatApprovalCreated(event);

    expect(result.options.inlineKeyboard![0][0].callback_data).toBe("approve_entity_fallback");
  });
});

describe("formatAgentError", () => {
  it("formats agent error with message", () => {
    const event = makeEvent<AgentRunEventPayload>({
      agentName: "Codex",
      error: "Connection timeout after 30s",
    });

    const result = formatAgentError(event);

    expect(result.text).toContain("Agent Error");
    expect(result.text).toContain("Codex");
    expect(result.text).toContain("Connection timeout after 30s");
    expect(result.options.parseMode).toBe("MarkdownV2");
  });

  it("falls back to name field when agentName is missing", () => {
    const event = makeEvent<AgentRunEventPayload>({
      name: "Fallback Agent",
      message: "Something broke",
    });

    const result = formatAgentError(event);

    expect(result.text).toContain("Fallback Agent");
    expect(result.text).toContain("Something broke");
  });
});

describe("formatAgentRunStarted", () => {
  it("formats run started notification", () => {
    const event = makeEvent<AgentRunEventPayload>({ agentName: "ClaudeCoder" });

    const result = formatAgentRunStarted(event);

    expect(result.text).toContain("ClaudeCoder");
    expect(result.text).toContain("started a new run");
    expect(result.options.disableNotification).toBe(true);
  });
});

describe("formatAgentRunFinished", () => {
  it("formats run finished notification", () => {
    const event = makeEvent<AgentRunEventPayload>({ agentName: "ClaudeCoder" });

    const result = formatAgentRunFinished(event);

    expect(result.text).toContain("ClaudeCoder");
    expect(result.text).toContain("completed successfully");
    expect(result.options.disableNotification).toBe(true);
  });
});
