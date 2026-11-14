// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  claimReviseDraftWork,
  clearReviseDraft,
  getReviseDraft,
  releaseReviseDraftWork,
  resetReviseDraftsForTests,
  reviseDraftKey,
  updateReviseDraft,
} from "./revise-draft-store";

afterEach(() => {
  sessionStorage.clear();
  resetReviseDraftsForTests();
});

describe("revise draft store", () => {
  it("keys a draft by interaction and plan revision", () => {
    expect(reviseDraftKey("i1", "r1")).toBe("i1:r1");
    expect(reviseDraftKey("i1", null)).toBe("i1");
    updateReviseDraft(reviseDraftKey("i1", "r1"), { revising: true, reason: "abc" });
    expect(getReviseDraft("i1:r1")).toMatchObject({ revising: true, reason: "abc" });
    // A newer revision of the same plan starts clean.
    expect(getReviseDraft("i1:r2")).toMatchObject({ revising: false, reason: "" });
  });

  it("clears a draft", () => {
    updateReviseDraft("k", { revising: true, reason: "abc" });
    clearReviseDraft("k");
    expect(getReviseDraft("k")).toMatchObject({ revising: false, reason: "" });
    expect(sessionStorage.getItem("paperclip:revise-drafts")).toBeNull();
  });

  it("lets only one view send at a time", () => {
    expect(claimReviseDraftWork("k", "reject")).toBe(true);
    expect(claimReviseDraftWork("k", "reject")).toBe(false);
    expect(claimReviseDraftWork("k", "accept")).toBe(false);
    releaseReviseDraftWork("k");
    expect(claimReviseDraftWork("k", "accept")).toBe(true);
  });

  it("survives a reload through sessionStorage, without the in-flight send", () => {
    updateReviseDraft("k", { revising: true, reason: "keep me", working: "reject" });
    resetReviseDraftsForTests();
    expect(getReviseDraft("k")).toEqual({ revising: true, reason: "keep me", working: null });
  });

  it("ignores a corrupt stored value", () => {
    sessionStorage.setItem("paperclip:revise-drafts", "{not json");
    resetReviseDraftsForTests();
    expect(getReviseDraft("k")).toMatchObject({ revising: false, reason: "" });
  });
});
