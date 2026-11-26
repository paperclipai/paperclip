import { describe, expect, it } from "vitest";
import type { CompanyUserDirectoryEntry } from "../api/access";
import { humanAgentCreatorUserId, resolveAgentCreatorLabel } from "./agent-creator";

function member(principalId: string, name: string | null, email: string | null = null): CompanyUserDirectoryEntry {
  return { principalId, status: "active", user: { id: principalId, name, email, image: null } };
}

describe("agent creator label", () => {
  const alice = member("user-alice", "Alice");
  const bob = member("user-bob", null, "bob@example.com");
  const board = member("local-board", "Board");

  it("names the creator once more than one human shares the company", () => {
    expect(resolveAgentCreatorLabel("user-alice", [alice, bob])).toBe("Alice");
    expect(resolveAgentCreatorLabel("user-bob", [alice, bob])).toBe("bob@example.com");
  });

  it("stays hidden for a single human, even alongside the local Board principal", () => {
    expect(resolveAgentCreatorLabel("user-alice", [alice])).toBeNull();
    expect(resolveAgentCreatorLabel("user-alice", [alice, board])).toBeNull();
  });

  it("never shows the local Board principal or a missing creator", () => {
    expect(humanAgentCreatorUserId("local-board")).toBeNull();
    expect(resolveAgentCreatorLabel("local-board", [alice, bob, board])).toBeNull();
    expect(resolveAgentCreatorLabel(null, [alice, bob])).toBeNull();
    expect(resolveAgentCreatorLabel("user-alice", undefined)).toBeNull();
  });

  it("labels a creator who is no longer an active member", () => {
    expect(resolveAgentCreatorLabel("user-carol", [alice, bob])).toBe("Former member");
  });
});
