import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { mergeIssueRowDetails } from "./useIssueRowDetails";

const index = {
  id: "task-1", companyId: "company-1", title: "Current title", status: "todo",
  updatedAt: new Date("2026-10-26T10:00:00Z"), isUnreadForMe: true, listProjection: "index",
} as Issue;

describe("visible task row enrichment", () => {
  it("keeps the index's ordering, read state, and title when diagnostics arrive", () => {
    const details = {
      ...index, title: "Old title", status: "done", isUnreadForMe: false,
      activeRecoveryAction: { id: "recovery-1" },
    } as Issue;
    const merged = mergeIssueRowDetails(index, details);
    expect(merged).toMatchObject({
      title: "Current title", status: "todo", isUnreadForMe: true, listProjection: "index",
      activeRecoveryAction: { id: "recovery-1" },
    });
    expect(merged.updatedAt).toBe(index.updatedAt);
  });

  it("rejects stale diagnostics and a different task or company", () => {
    for (const overrides of [
      { updatedAt: new Date("2026-10-26T09:00:00Z") },
      { id: "task-2" },
      { companyId: "company-2" },
    ]) {
      expect(mergeIssueRowDetails(index, { ...index, ...overrides })).toBe(index);
    }
  });

  it("accepts newer diagnostics without replacing the index's order or content", () => {
    const merged = mergeIssueRowDetails(index, {
      ...index, updatedAt: new Date("2026-10-26T10:00:01Z"), title: "Changed during loading",
      activeRecoveryAction: { id: "new-recovery" },
    } as Issue);
    expect(merged.title).toBe(index.title);
    expect(merged.updatedAt).toBe(index.updatedAt);
    expect(merged.activeRecoveryAction?.id).toBe("new-recovery");
  });
});
