// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  pluginOperationIssueOriginKind,
  type Approval,
  type Issue,
  type IssueBlockedInboxAttention,
} from "@paperclipai/shared";
import { buildBlockedInboxRows, groupBlockedInboxRows } from "./blockedInbox";
import { groupInboxWorkItems, type InboxWorkItem } from "./inbox";
import { issueSourceGroup } from "./issue-source";

function issueWithOrigin(id: string, originKind: Issue["originKind"], extra: Partial<Issue> = {}): Issue {
  return { id, title: id, originKind, ...extra } as Issue;
}

function blockedAttention(): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: "2026-05-08T10:00:00.000Z",
    owner: { type: "agent", agentId: "agent-1", userId: null, label: null },
    action: { label: "Resolve", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
  };
}

describe("issueSourceGroup", () => {
  it("puts tasks a person or an agent made in Work", () => {
    expect(issueSourceGroup("manual")).toBe("work");
    expect(issueSourceGroup("onboarding_first_task")).toBe("work");
    expect(issueSourceGroup(undefined)).toBe("work");
    expect(issueSourceGroup(null)).toBe("work");
    expect(issueSourceGroup("task_bridge")).toBe("work");
    expect(issueSourceGroup("plugin:acme:sync")).toBe("work");
  });

  it("puts routine runs in Routines and chat tasks in Chat", () => {
    expect(issueSourceGroup("routine_execution")).toBe("routines");
    expect(issueSourceGroup("chat_channel")).toBe("chat");
  });

  it("puts tasks Paperclip made itself in System", () => {
    for (const kind of [
      "stale_active_run_evaluation",
      "harness_liveness_escalation",
      "issue_productivity_review",
      "stranded_issue_recovery",
      "task_watchdog",
      "task_watchdog_product_bug",
    ]) {
      expect(issueSourceGroup(kind)).toBe("system");
    }
    expect(issueSourceGroup(pluginOperationIssueOriginKind("acme"))).toBe("system");
  });
});

describe("source grouping", () => {
  it("groups inbox tasks in a fixed Work, Routines, System, Chat order, then other items by kind", () => {
    const items: InboxWorkItem[] = [
      { kind: "issue", timestamp: 9, issue: issueWithOrigin("chat", "chat_channel") },
      { kind: "issue", timestamp: 8, issue: issueWithOrigin("watchdog", "task_watchdog") },
      { kind: "approval", timestamp: 7, approval: { id: "approval-1" } as Approval },
      { kind: "issue", timestamp: 6, issue: issueWithOrigin("routine", "routine_execution") },
      { kind: "issue", timestamp: 5, issue: issueWithOrigin("recovery", "stranded_issue_recovery") },
      { kind: "issue", timestamp: 4, issue: issueWithOrigin("manual", "manual") },
      { kind: "issue", timestamp: 3, issue: issueWithOrigin("no-origin", undefined) },
    ];

    expect(groupInboxWorkItems(items, "source")).toEqual([
      { key: "source:work", label: "Work", items: [items[5], items[6]] },
      { key: "source:routines", label: "Routines", items: [items[3]] },
      { key: "source:system", label: "System", items: [items[1], items[4]] },
      { key: "source:chat", label: "Chat", items: [items[0]] },
      { key: "kind:approval", label: "Approvals", items: [items[2]] },
    ]);
  });

  it("groups blocked rows by source in the same fixed order", () => {
    const issues = [
      issueWithOrigin("chat-1", "chat_channel", { blockedInboxAttention: blockedAttention() }),
      issueWithOrigin("liveness-1", "harness_liveness_escalation", { blockedInboxAttention: blockedAttention() }),
      issueWithOrigin("routine-1", "routine_execution", { blockedInboxAttention: blockedAttention() }),
      issueWithOrigin("manual-1", "manual", { blockedInboxAttention: blockedAttention() }),
    ];

    const groups = groupBlockedInboxRows(buildBlockedInboxRows(issues), "urgency", "source");
    expect(groups.map((group) => [group.key, group.label, group.rows.map((row) => row.issue.id)])).toEqual([
      ["source:work", "Work", ["manual-1"]],
      ["source:routines", "Routines", ["routine-1"]],
      ["source:system", "System", ["liveness-1"]],
      ["source:chat", "Chat", ["chat-1"]],
    ]);
    expect(groups.every((group) => group.variant === undefined)).toBe(true);
  });

  it("keeps blocker-type grouping keyed by variant", () => {
    const groups = groupBlockedInboxRows(
      buildBlockedInboxRows([issueWithOrigin("manual-1", "manual", { blockedInboxAttention: blockedAttention() })]),
    );
    expect(groups.map((group) => [group.key, group.variant])).toEqual([["stalled", "stalled"]]);
  });
});
