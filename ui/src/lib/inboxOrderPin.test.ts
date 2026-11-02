import type { Approval, HeartbeatRun, Issue, JoinRequest } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  getInboxWorkItemKey,
  type InboxGroupedSection,
  type InboxWorkItem,
} from "./inbox";
import { INBOX_ARCHIVE_CONFIRMATION_GRACE_MS } from "./inboxArchiveCache";
import {
  captureInboxOrderPin,
  reconcileInboxOrderPin,
} from "./inboxOrderPin";

function issue(id: string, title = id): Issue {
  return {
    id,
    title,
    status: "todo",
  } as Issue;
}

function issueItem(value: Issue, timestamp = 0): InboxWorkItem {
  return { kind: "issue", issue: value, timestamp };
}

function section(
  key: string,
  items: Issue[],
  childrenByIssueId: ReadonlyArray<readonly [string, Issue[]]> = [],
): InboxGroupedSection {
  return {
    key,
    label: key,
    displayItems: items.map((item) => issueItem(item)),
    childrenByIssueId: new Map(childrenByIssueId),
    searchSection: "none",
  };
}

function sectionKeys(sections: readonly InboxGroupedSection[]): string[] {
  return sections.map((value) => value.key);
}

function workItemSection(key: string, displayItems: InboxWorkItem[]): InboxGroupedSection {
  return {
    key,
    label: key,
    displayItems,
    childrenByIssueId: new Map(),
    searchSection: "none",
  };
}

function rowIds(value: InboxGroupedSection): string[] {
  return value.displayItems.map((item) => item.kind === "issue" ? item.issue.id : "non-issue");
}

describe("inboxOrderPin", () => {
  it("keeps a parent, its group, and neighboring groups in place when a child is archived", () => {
    const parent = issue("parent");
    const child = issue("child");
    const neighbor = issue("neighbor");
    const committed = [
      section("parent-group", [parent], [[parent.id, [child]]]),
      section("neighbor-group", [neighbor]),
    ];
    const pin = captureInboxOrderPin(committed);

    const fresh = [
      section("neighbor-group", [neighbor]),
      section("parent-group", [parent], [[parent.id, []]]),
    ];
    const result = reconcileInboxOrderPin(pin, fresh, 100);

    expect(sectionKeys(result.sections)).toEqual(["parent-group", "neighbor-group"]);
    expect(rowIds(result.sections[0]!)).toEqual([parent.id]);
    expect(result.sections[0]!.childrenByIssueId.get(parent.id)).toEqual([]);
  });

  it("removes a group in place when its last row is archived", () => {
    const archived = issue("archived");
    const neighbor = issue("neighbor");
    const pin = captureInboxOrderPin([
      section("archived-group", [archived]),
      section("neighbor-group", [neighbor]),
    ]);

    const result = reconcileInboxOrderPin(
      pin,
      [section("neighbor-group", [neighbor])],
      200,
    );

    expect(sectionKeys(result.sections)).toEqual(["neighbor-group"]);
    expect(rowIds(result.sections[0]!)).toEqual([neighbor.id]);
    expect(result.pin.sections.map((value) => [value.key, value.missingSince])).toEqual([
      ["archived-group", 200],
      ["neighbor-group", null],
    ]);
  });

  it("restores an archived row to its original position within the tombstone grace window", () => {
    const first = issue("first");
    const restored = issue("restored");
    const last = issue("last");
    const pin = captureInboxOrderPin([section("group", [first, restored, last])]);
    const archived = reconcileInboxOrderPin(pin, [section("group", [last, first])], 1_000);

    expect(rowIds(archived.sections[0]!)).toEqual([first.id, last.id]);

    const undone = reconcileInboxOrderPin(
      archived.pin,
      [section("group", [last, restored, first])],
      1_000 + INBOX_ARCHIVE_CONFIRMATION_GRACE_MS - 1,
    );

    expect(rowIds(undone.sections[0]!)).toEqual([first.id, restored.id, last.id]);
    expect(undone.pin.sections[0]!.rows.every((entry) => entry.missingSince === null)).toBe(true);
  });

  it("treats a row restored after the grace window as a new algorithmic insertion", () => {
    const first = issue("first");
    const expired = issue("expired");
    const last = issue("last");
    const pin = captureInboxOrderPin([section("group", [first, expired, last])]);
    const archived = reconcileInboxOrderPin(pin, [section("group", [last, first])], 1_000);

    const restored = reconcileInboxOrderPin(
      archived.pin,
      [section("group", [last, first, expired])],
      1_000 + INBOX_ARCHIVE_CONFIRMATION_GRACE_MS,
    );

    expect(rowIds(restored.sections[0]!)).toEqual([first.id, last.id, expired.id]);
  });

  it("inserts new rows and groups algorithmically without reordering existing entries", () => {
    const first = issue("first");
    const last = issue("last");
    const inserted = issue("inserted");
    const neighbor = issue("neighbor");
    const newGroupItem = issue("new-group-item");
    const pin = captureInboxOrderPin([
      section("existing", [first, last]),
      section("neighbor", [neighbor]),
    ]);

    const result = reconcileInboxOrderPin(
      pin,
      [
        section("neighbor", [neighbor]),
        section("new-group", [newGroupItem]),
        section("existing", [last, inserted, first]),
      ],
      300,
    );

    expect(sectionKeys(result.sections)).toEqual(["existing", "new-group", "neighbor"]);
    expect(rowIds(result.sections[0]!)).toEqual([first.id, inserted.id, last.id]);
  });

  it("uses fresh row content while retaining the pinned order", () => {
    const first = issue("first", "Old first");
    const last = issue("last", "Old last");
    const pin = captureInboxOrderPin([section("group", [first, last])]);
    const freshLast = { ...last, title: "Updated last", status: "in_progress" } as Issue;
    const freshFirst = { ...first, title: "Updated first", status: "blocked" } as Issue;

    const result = reconcileInboxOrderPin(
      pin,
      [section("group", [freshLast, freshFirst])],
      400,
    );

    expect(rowIds(result.sections[0]!)).toEqual([first.id, last.id]);
    expect(result.sections[0]!.displayItems[0]).toBeDefined();
    expect(result.sections[0]!.displayItems[0]!.kind).toBe("issue");
    expect(result.sections[0]!.displayItems[0]).toMatchObject({
      issue: { title: "Updated first", status: "blocked" },
    });
    expect(result.sections[0]!.displayItems[1]).toMatchObject({
      issue: { title: "Updated last", status: "in_progress" },
    });
  });

  it("pins approval, failed-run, and join-request rows by their stable keys", () => {
    const approval = {
      kind: "approval",
      timestamp: 3,
      approval: { id: "approval", status: "pending" } as Approval,
    } satisfies InboxWorkItem;
    const failedRun = {
      kind: "failed_run",
      timestamp: 2,
      run: { id: "run", status: "failed" } as HeartbeatRun,
    } satisfies InboxWorkItem;
    const joinRequest = {
      kind: "join_request",
      timestamp: 1,
      joinRequest: { id: "join", status: "pending_approval" } as JoinRequest,
    } satisfies InboxWorkItem;
    const pin = captureInboxOrderPin([
      workItemSection("mixed", [approval, failedRun, joinRequest]),
    ]);

    const result = reconcileInboxOrderPin(
      pin,
      [workItemSection("mixed", [
        { ...joinRequest, timestamp: 4 },
        { ...failedRun, timestamp: 5 },
        {
          ...approval,
          timestamp: 6,
          approval: { ...approval.approval, status: "approved" } as Approval,
        },
      ])],
      500,
    );

    expect(result.sections[0]!.displayItems.map(getInboxWorkItemKey)).toEqual([
      "approval:approval",
      "run:run",
      "join:join",
    ]);
    expect(result.sections[0]!.displayItems[0]).toMatchObject({
      timestamp: 6,
      approval: { status: "approved" },
    });
  });
});
