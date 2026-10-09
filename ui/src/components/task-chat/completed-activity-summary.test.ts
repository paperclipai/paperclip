import { describe, expect, it } from "vitest";
import { completedActivitySummary } from "./completed-activity-summary";
import type {
  TaskChatActivityPhaseItem,
  TaskChatProviderActivityItem,
  TaskChatToolItem,
} from "./task-chat-model";

type Activity = TaskChatActivityPhaseItem["items"][number];
const tool = (
  name: string,
  status: TaskChatToolItem["status"] = "completed",
): TaskChatToolItem => ({
  id: name,
  kind: "tool",
  name,
  status,
  target: "private-command-or-path",
  detail: "private-output",
});
const provider = (
  family: TaskChatProviderActivityItem["family"],
  status: TaskChatProviderActivityItem["status"] = "completed",
): TaskChatProviderActivityItem => ({
  id: family,
  kind: "protocol",
  surface: "provider_activity",
  family,
  status,
  title: "provider internal title",
  eventType: "activity",
  details: [],
  steps: [],
  links: [],
  children: [],
});
const thought: Activity = {
  id: "thought",
  kind: "thinking",
  lines: ["Reasoning text"],
};

describe("completedActivitySummary", () => {
  it.each([
    "completed",
    "failed",
    "interrupted",
    "pending",
    "in_progress",
  ] as const)(
    "describes command attempts without claiming success (%s)",
    (status) => {
      expect(
        completedActivitySummary([
          tool("exec_command", status),
          tool("bash", status),
        ]).label,
      ).toBe("Ran commands");
    },
  );
  it("merges retries and hides reasoning, raw targets and output from the summary", () => {
    const summary = completedActivitySummary([
      thought,
      tool("read"),
      tool("exec_command", "failed"),
      tool("exec_command"),
    ]);
    expect(summary.label).toBe("Read files, ran commands");
    expect(summary.fullLabel).not.toMatch(/private|Reasoning|failed/);
  });
  it.each([
    ["read", "failed", "Checked files"],
    ["read", "interrupted", "Checked files"],
    ["apply_patch", "failed", "Worked on files"],
    ["apply_patch", "interrupted", "Worked on files"],
    ["read", "completed", "Read files"],
    ["apply_patch", "completed", "Edited files"],
  ] as const)(
    "does not claim an unsuccessful %s completed",
    (name, status, expected) => {
      expect(completedActivitySummary([tool(name, status)]).label).toBe(
        expected,
      );
    },
  );
  it("uses completed work once when a read or edit retry succeeds", () => {
    expect(
      completedActivitySummary([
        tool("read", "failed"),
        tool("apply_patch", "failed"),
        tool("read"),
        tool("apply_patch"),
      ]).label,
    ).toBe("Read files, edited files");
  });
  it("classifies native provider tools through the same taxonomy and keeps encounter order", () => {
    const native = {
      ...provider("tool_execution", "failed"),
      details: [{ label: "Name", value: "exec_command" }],
    };
    expect(
      completedActivitySummary([
        tool("read"),
        provider("research"),
        native,
        tool("bash"),
      ]).label,
    ).toBe("Read files, searched the web, ran commands");
  });
  it("supports canonical operation identity when a native tool has no useful name", () => {
    const native = {
      ...provider("tool_execution"),
      details: [
        { label: "Name", value: "tool" },
        { label: "Operation", value: "execute" },
      ],
    };
    expect(completedActivitySummary([native]).label).toBe("Ran commands");
  });
  it("bounds many categories while keeping the complete accessible description", () => {
    const summary = completedActivitySummary([
      tool("read"),
      tool("exec_command"),
      tool("grep"),
      tool("apply_patch"),
      provider("research"),
    ]);
    expect(summary.label).toBe("Read files, ran commands, and more");
    expect(summary.fullLabel).toBe(
      "Read files, ran commands, searched files, edited files, searched the web",
    );
  });
  it("does not invent tool activity for thoughts-only groups or expose unknown identifiers", () => {
    expect(completedActivitySummary([thought]).label).toBe(
      "Thought through the task",
    );
    expect(completedActivitySummary([tool("opaque_8792")]).label).toBe(
      "Used tools",
    );
    expect(
      completedActivitySummary([tool("mcp__github__get_pull_request")]).label,
    ).toBe("Used connected tools");
  });
});
