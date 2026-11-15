import { describe, expect, it } from "vitest";
import { inboxArchivePersisted, inboxTaskMatches, inboxTaskResurfaced } from "./inbox-triage-evidence.js";

describe("personal inbox triage evidence", () => {
  const expected = { id: "owned-task", companyId: "company", userId: "reader", status: "in_progress" };
  const task = { id: expected.id, companyId: expected.companyId, assigneeUserId: expected.userId,
    assigneeAgentId: null, status: expected.status, isUnreadForMe: false };
  const archived = { ...task, archivedAt: "2020-01-01T12:00:00.000Z" };
  it("requires persisted personal archive state and actual exclusion from Mine", () => {
    expect(inboxArchivePersisted(archived, expected, [])).toBe(true);
    expect(inboxArchivePersisted(task, expected, [])).toBe(false);
    expect(inboxArchivePersisted(archived, expected, [task])).toBe(false);
    expect(inboxArchivePersisted({ ...archived, archivedAt: "not-a-time" }, expected, [])).toBe(false);
  });
  it.each([{ id: "foreign-task" }, { companyId: "foreign-company" }, { assigneeUserId: "other-user" },
    { assigneeAgentId: "unexpected-agent" }, { status: "done" }])("rejects changed ownership or completion %j", change => {
    expect(inboxTaskMatches({ ...task, ...change }, expected)).toBe(false);
    expect(inboxArchivePersisted({ ...archived, ...change }, expected, [])).toBe(false);
  });
  it("requires one correctly owned visible item after a relevant new status transition", () => {
    const blocked = { ...task, status: "blocked" }, updated = { ...expected, status: "blocked" };
    expect(inboxTaskResurfaced(blocked, updated, [blocked])).toBe(true);
    expect(inboxTaskResurfaced(blocked, updated, [])).toBe(false);
    expect(inboxTaskResurfaced(blocked, updated, [blocked, blocked])).toBe(false);
    expect(inboxTaskResurfaced({ ...blocked, archivedAt: archived.archivedAt }, updated, [blocked])).toBe(false);
    expect(inboxTaskResurfaced(blocked, updated, [{ ...blocked, assigneeUserId: "other-user" }])).toBe(false);
    expect(inboxTaskMatches(undefined, expected)).toBe(false);
  });
});
