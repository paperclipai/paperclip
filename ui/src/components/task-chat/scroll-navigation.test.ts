import { describe, expect, it } from "vitest";
import { taskChatScrollEntry } from "./scroll-navigation";

describe("document scroll navigation", () => {
  it("keeps the original reading entry across multiple document links", () => {
    const original = { key: "inbox-entry", hash: "#comment-2", pathname: "/PAP/issues/PAP-1", state: null };
    const first = { ...original, key: "plan-entry", hash: "#document-plan", state: { taskDocumentScrollEntry: taskChatScrollEntry(original) } };
    const second = { ...original, key: "qa-entry", hash: "#document-qa", state: { taskDocumentScrollEntry: taskChatScrollEntry(first) } };
    expect(taskChatScrollEntry(second)).toEqual({ key: "inbox-entry", hash: "#comment-2", pathname: original.pathname });
    expect(taskChatScrollEntry(first)).toEqual(taskChatScrollEntry(original));
  });
  it.each([null, {}, { taskDocumentScrollEntry: { key: 1, hash: null } }, { taskDocumentScrollEntry: { key: "old-task", hash: "", pathname: "/PAP/issues/PAP-2" } }])("uses normal history identity without a valid preserved entry for this task", (state) => {
    expect(taskChatScrollEntry({ key: "entry", hash: "#document-plan", pathname: "/PAP/issues/PAP-1", state })).toEqual({ key: "entry", hash: "#document-plan", pathname: "/PAP/issues/PAP-1" });
  });
});
