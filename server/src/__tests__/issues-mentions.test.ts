import { describe, expect, it } from "vitest";
import { findMentionedAgentIds } from "../services/issues.ts";

describe("findMentionedAgentIds", () => {
  const agents = [
    { id: "agent-qa", name: "QA Engineer" },
    { id: "agent-fe", name: "Frontend Eng" },
  ];

  it("matches normalized agent names from mention tokens", () => {
    expect(findMentionedAgentIds("ping @qa-engineer", agents)).toEqual(["agent-qa"]);
  });

  it("deduplicates when multiple tokens resolve to the same agent", () => {
    const result = findMentionedAgentIds("ping @qa-engineer and @QA_Engineer", agents);
    expect(result).toEqual(["agent-qa"]);
    expect(result).toHaveLength(1);
  });

  it("matches multiple distinct agents", () => {
    expect(findMentionedAgentIds("cc @qa-engineer @frontend-eng", agents)).toEqual([
      "agent-qa",
      "agent-fe",
    ]);
  });

  it("ignores unknown mentions", () => {
    expect(findMentionedAgentIds("hello @nobody", agents)).toEqual([]);
  });

  it("returns empty array when body has no mentions", () => {
    expect(findMentionedAgentIds("just a normal comment", agents)).toEqual([]);
  });
});
