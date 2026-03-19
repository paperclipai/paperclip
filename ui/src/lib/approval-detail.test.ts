import { describe, expect, it } from "vitest";
import {
  APPROVAL_DRAFT_DEBOUNCE_MS,
  buildApprovalDraftStorageKey,
  normalizeDecisionNote,
  normalizeDraftValue,
} from "./approval-detail";

describe("approval detail helpers", () => {
  it("builds stable storage keys for each draft kind", () => {
    expect(buildApprovalDraftStorageKey("comment", "company-1", "approval-1")).toBe(
      "paperclip:approval:comment-draft:company-1:approval-1",
    );
    expect(buildApprovalDraftStorageKey("decision", "company-1", "approval-1")).toBe(
      "paperclip:approval:decision-draft:company-1:approval-1",
    );
  });

  it("drops blank draft values before persistence", () => {
    expect(normalizeDraftValue("")).toBe("");
    expect(normalizeDraftValue("   ")).toBe("");
    expect(normalizeDraftValue("  Keep this  ")).toBe("  Keep this  ");
  });

  it("normalizes decision notes to the API shape", () => {
    expect(normalizeDecisionNote("")).toBeUndefined();
    expect(normalizeDecisionNote("   ")).toBeUndefined();
    expect(normalizeDecisionNote("  Needs workspace path cleanup  ")).toBe(
      "Needs workspace path cleanup",
    );
  });

  it("keeps approval draft autosave aligned with issue comment drafts", () => {
    expect(APPROVAL_DRAFT_DEBOUNCE_MS).toBe(800);
  });
});
