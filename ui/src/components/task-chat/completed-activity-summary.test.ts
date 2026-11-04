import { AlertTriangle, Info } from "lucide-react";
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
  it("shows the preserved pricing estimate as informational, not a billing receipt", () => {
    const summary = "Pi estimates this turn at $0.000617 from its model prices. Billing cost is unverified.";
    expect(completedActivitySummary([{
      ...provider("provider_notice", "informational"), summary,
      details: [{ label: "Severity", value: "info" }],
    }])).toEqual({ label: summary, fullLabel: summary, icon: Info });
  });
  it.each(["warning", "error", undefined])("retains warning/error icons and safe notice text (%s)", (severity) => {
    const summary = "Provider request needs attention.";
    const result = completedActivitySummary([{
      ...provider("provider_notice", severity === "error" ? "failed" : "informational"),
      details: [
        { label: "Summary", value: summary },
        ...(severity ? [{ label: "Severity", value: severity }] : []),
      ],
    }]);
    expect(result).toEqual({ label: summary, fullLabel: summary, icon: AlertTriangle });
  });
  it("uses a generic fallback without promoting arbitrary detail fields", () => {
    expect(completedActivitySummary([{
      ...provider("provider_notice", "informational"), summary: "  ",
      details: [{ label: "Raw input", value: "private-command-or-path" }],
    }]).label).toBe("Received a provider update");
  });
  it("does not hide a failed notice behind informational metadata", () => {
    expect(completedActivitySummary([{
      ...provider("provider_notice", "failed"), summary: "Provider failed.",
      details: [{ label: "Severity", value: "info" }],
    }]).icon).toBe(AlertTriangle);
  });

  it("groups distinct notices and keeps a later error visible beside actual work", () => {
    const notices = ["info", "info", "warning", "error"].map((severity, index) => ({
      ...provider("provider_notice", "informational"),
      id: `notice-${index}`,
      summary: `Distinct provider message ${index}`,
      details: [{ label: "Severity", value: severity }],
    }));
    const result = completedActivitySummary([tool("bash"), ...notices]);
    expect(result.label).toBe("Provider error reported, ran commands");
    expect(result.fullLabel).toBe(result.label);
    expect(result.label).not.toContain("Distinct provider message");
  });

});
