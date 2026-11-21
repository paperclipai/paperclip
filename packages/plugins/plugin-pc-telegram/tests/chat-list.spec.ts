import { describe, expect, it } from "vitest";
import { mergeLoadedChats, profileEventMatches, type TelegramChatRow } from "../src/ui/inbox-thread.js";

function row(issueId: string, label: string): TelegramChatRow {
  return { issueId, identifier: null, label, status: "todo", updatedAt: "2026-11-20T00:00:00.000Z" };
}

describe("mergeLoadedChats", () => {
  it("puts a refreshed latest page in front of chats already loaded", () => {
    const loaded = [row("old-a", "A"), row("old-b", "B")];
    const latest = [row("new", "New"), row("old-a", "A2")];
    expect(mergeLoadedChats(loaded, latest, "latest").map((chat) => chat.issueId)).toEqual(["new", "old-a", "old-b"]);
    expect(mergeLoadedChats(loaded, latest, "latest")[1]?.label).toBe("A2");
  });

  it("appends an older page without duplicating rows", () => {
    const loaded = [row("a", "A"), row("b", "B")];
    expect(mergeLoadedChats(loaded, [row("b", "B"), row("c", "C")], "older").map((chat) => chat.issueId)).toEqual(["a", "b", "c"]);
    expect(mergeLoadedChats(loaded, [row("b", "B")], "older")).toEqual(loaded);
  });
});

describe("profileEventMatches", () => {
  const profile = { issueRef: "AND-1", accountId: "1001", peerId: "2002" };

  it("refreshes an open profile from its task or its account and peer", () => {
    expect(profileEventMatches({ issueRef: "AND-1", peerId: "9" }, profile)).toBe(true);
    expect(profileEventMatches({ accountId: "1001", peerId: "2002" }, profile)).toBe(true);
    expect(profileEventMatches({ peerId: "AND-1" }, profile)).toBe(false);
    expect(profileEventMatches({ accountId: "1002", peerId: "2002" }, profile)).toBe(false);
    expect(profileEventMatches({ peerId: "2002" }, { issueRef: "", accountId: "", peerId: "" })).toBe(false);
  });
});
