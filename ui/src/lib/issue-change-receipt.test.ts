import { describe, expect, it } from "vitest";

import {
  formatIssueChangeValue,
  issueAuthorizationReasonLabel,
  issueChangeFieldLabel,
  readIssueChangeReceipt,
} from "./issue-change-receipt";

describe("issueChangeFieldLabel", () => {
  it("uses curated labels for id-bearing fields", () => {
    expect(issueChangeFieldLabel("assigneeAgentId")).toBe("Assignee");
    expect(issueChangeFieldLabel("blockedByIssueIds")).toBe("Blockers");
    expect(issueChangeFieldLabel("workMode")).toBe("Work mode");
    expect(issueChangeFieldLabel("reviewPolicy")).toBe("Who can approve");
  });

  it("humanizes unknown camelCase and snake_case fields", () => {
    expect(issueChangeFieldLabel("status")).toBe("Status");
    expect(issueChangeFieldLabel("someNewField")).toBe("Some new field");
    expect(issueChangeFieldLabel("some_new_field")).toBe("Some new field");
  });
});

describe("formatIssueChangeValue", () => {
  it("renders empty values as 'none' rather than blank", () => {
    expect(formatIssueChangeValue(null)).toBe("none");
    expect(formatIssueChangeValue(undefined)).toBe("none");
    expect(formatIssueChangeValue("")).toBe("none");
    expect(formatIssueChangeValue("   ")).toBe("none");
    expect(formatIssueChangeValue([])).toBe("none");
  });

  it("humanizes enum-ish values", () => {
    expect(formatIssueChangeValue("in_progress")).toBe("in progress");
    expect(formatIssueChangeValue("high")).toBe("high");
  });

  // A cleared `reviewPolicy` means "anyone can approve" (PAP-16506), so the
  // receipt must not report the default as an absent value.
  it("reads a cleared review policy as 'anyone', not 'none'", () => {
    expect(formatIssueChangeValue(null, { field: "reviewPolicy" })).toBe("anyone");
    expect(formatIssueChangeValue("human_only", { field: "reviewPolicy" })).toBe("human only");
    expect(formatIssueChangeValue("not_creator", { field: "reviewPolicy" })).toBe("anyone else");
  });

  it("renders booleans and numbers plainly", () => {
    expect(formatIssueChangeValue(true)).toBe("yes");
    expect(formatIssueChangeValue(false)).toBe("no");
    expect(formatIssueChangeValue(0)).toBe("0");
    expect(formatIssueChangeValue(3)).toBe("3");
  });

  it("resolves agent and user ids to names when a directory is available", () => {
    expect(formatIssueChangeValue("3108ef8e-5ed0-41d9-b561-6b41c41b8545", {
      field: "assigneeAgentId",
      resolveAgentLabel: () => "ClaudeCoder",
    })).toBe("ClaudeCoder");

    expect(formatIssueChangeValue("user-1", {
      field: "responsibleUserId",
      resolveUserLabel: () => "Dotta",
    })).toBe("Dotta");
  });

  it("shortens unresolved uuids instead of printing them whole", () => {
    expect(formatIssueChangeValue("3108ef8e-5ed0-41d9-b561-6b41c41b8545", {
      field: "assigneeAgentId",
    })).toBe("3108ef8e");
  });

  it("summarizes arrays by count past a scannable length", () => {
    expect(formatIssueChangeValue(["a", "b"])).toBe("a, b");
    expect(formatIssueChangeValue(["a", "b", "c", "d"])).toBe("4 items");
    expect(formatIssueChangeValue([{ a: 1 }])).toBe("1 items");
  });

  it("truncates long free text", () => {
    const long = "x".repeat(200);
    const formatted = formatIssueChangeValue(long);
    expect(formatted.endsWith("…")).toBe(true);
    expect(formatted.length).toBeLessThan(long.length);
  });

  it("reports structural objects as 'updated'", () => {
    expect(formatIssueChangeValue({ mode: "isolated_workspace" })).toBe("updated");
  });
});

describe("readIssueChangeReceipt", () => {
  it("turns a change receipt into sorted display rows", () => {
    const rows = readIssueChangeReceipt({
      changes: {
        status: { from: "todo", to: "in_progress" },
        priority: { from: "medium", to: "high" },
      },
    });

    expect(rows.map((row) => row.label)).toEqual(["Priority", "Status"]);
    expect(rows[1]).toMatchObject({
      field: "status",
      from: "todo",
      to: "in progress",
      truncated: false,
    });
  });

  it("flags server-truncated long text", () => {
    const rows = readIssueChangeReceipt({
      changes: { description: { from: "old text", to: "new text", updated: true } },
    });
    expect(rows[0]).toMatchObject({ label: "Description", truncated: true });
  });

  it("returns nothing for events without a receipt", () => {
    expect(readIssueChangeReceipt(null)).toEqual([]);
    expect(readIssueChangeReceipt(undefined)).toEqual([]);
    expect(readIssueChangeReceipt({})).toEqual([]);
    // Older activity rows carried no `changes` key at all.
    expect(readIssueChangeReceipt({ status: "done" })).toEqual([]);
  });

  it("ignores malformed change entries instead of throwing", () => {
    const rows = readIssueChangeReceipt({
      changes: {
        status: { from: "todo", to: "done" },
        bogus: "not-an-entry",
        alsoBogus: { from: "only-from" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toBe("status");
  });

  it("survives a non-object changes value", () => {
    expect(readIssueChangeReceipt({ changes: "nope" })).toEqual([]);
    expect(readIssueChangeReceipt({ changes: ["nope"] })).toEqual([]);
  });
});

describe("issueAuthorizationReasonLabel", () => {
  it("explains the default-open rule in words", () => {
    expect(issueAuthorizationReasonLabel("allow_visible_issue_write"))
      .toBe("default-open write on a visible task");
    expect(issueAuthorizationReasonLabel("allow_board_actor")).toBe("board actor");
  });

  it("degrades unknown reasons rather than hiding them", () => {
    expect(issueAuthorizationReasonLabel("some_future_reason")).toBe("some future reason");
  });

  it("returns null when no reason was recorded", () => {
    expect(issueAuthorizationReasonLabel(null)).toBeNull();
    expect(issueAuthorizationReasonLabel(undefined)).toBeNull();
    expect(issueAuthorizationReasonLabel("  ")).toBeNull();
  });
});
