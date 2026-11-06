// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildGroupedInboxSections, getInboxWorkItems } from "./inbox";
import { collectInboxGroupUnreadIssueIds } from "./inboxGroupUnread";

function makeIssue(id: string, isUnreadForMe: boolean, originKind: Issue["originKind"], parentId: string | null): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: `PAP-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    originKind,
    isUnreadForMe,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
  } as Issue;
}

describe("collectInboxGroupUnreadIssueIds", () => {
  it("collects unread ids for large nested source groups with bounded work", () => {
    const parentCount = 300;
    const issues: Issue[] = [];
    for (let index = 0; index < parentCount; index += 1) {
      const originKind = index % 3 === 0 ? "routine_execution" : "manual";
      issues.push(
        makeIssue(`parent-${index}`, index % 2 === 0, originKind, null),
        makeIssue(`child-${index}`, true, originKind, `parent-${index}`),
        makeIssue(`grandchild-${index}`, index % 5 === 0, originKind, `child-${index}`),
      );
    }
    const sections = buildGroupedInboxSections(
      getInboxWorkItems({ issues, approvals: [] }),
      "source",
      {},
      { nestingEnabled: true },
    );
    expect(sections.map((section) => section.key)).toEqual(["source:work", "source:routines"]);
    expect(sections.every((section) => section.childrenByIssueId.size > 0)).toBe(true);

    const unreadTotal = issues.filter((issue) => issue.isUnreadForMe).length;
    let exclusionChecks = 0;
    const isExcluded = (issueId: string) => {
      exclusionChecks += 1;
      if (exclusionChecks > unreadTotal) {
        throw new Error(`did ${exclusionChecks} exclusion checks for ${unreadTotal} unread issues`);
      }
      return issueId === "child-0";
    };

    const collected = sections.flatMap((section) => collectInboxGroupUnreadIssueIds(section, isExcluded));

    expect(exclusionChecks).toBe(unreadTotal);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toHaveLength(unreadTotal - 1);
    expect(collected).not.toContain("child-0");
  });
});
