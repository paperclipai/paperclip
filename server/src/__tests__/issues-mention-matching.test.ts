import { describe, expect, it } from "vitest";
import { matchMentionedAgentIds } from "../services/issues.js";

const alice = { id: "agent-alice", name: "Alice" };
const seniorBackendDev = { id: "agent-sbd", name: "Senior Backend Dev" };
const bob = { id: "agent-bob", name: "Bob" };

describe("matchMentionedAgentIds", () => {
  it("resolves slug-style @senior-backend-dev to multi-word agent", () => {
    const ids = matchMentionedAgentIds("hey @senior-backend-dev please review", [seniorBackendDev]);
    expect(ids).toEqual(["agent-sbd"]);
  });

  it("resolves single-word @alice still works (unchanged behavior)", () => {
    const ids = matchMentionedAgentIds("ping @alice", [alice]);
    expect(ids).toEqual(["agent-alice"]);
  });

  it("resolves multiple distinct mentions in one body", () => {
    const ids = matchMentionedAgentIds(
      "@alice and @senior-backend-dev both need to look at this",
      [alice, seniorBackendDev, bob],
    );
    expect(ids).toContain("agent-alice");
    expect(ids).toContain("agent-sbd");
    expect(ids).not.toContain("agent-bob");
  });

  it("returns [] for empty body", () => {
    expect(matchMentionedAgentIds("", [alice, seniorBackendDev])).toEqual([]);
  });

  it("returns [] when no mentions match any agent", () => {
    expect(matchMentionedAgentIds("no mentions here", [alice])).toEqual([]);
  });

  it("matches case-insensitively for single-word names", () => {
    const ids = matchMentionedAgentIds("hello @Alice", [alice]);
    expect(ids).toEqual(["agent-alice"]);
  });
});
