import { describe, expect, it } from "vitest";
import { findMentionedAgentIds } from "../services/issues.ts";

describe("findMentionedAgentIds", () => {
  const agents = [
    { id: "agent-qa", name: "QA Engineer" },
    { id: "agent-fe", name: "Frontend Eng" },
    { id: "agent-custom", name: "Ops", urlKey: "custom-handle" },
  ];

  it("matches normalized agent names from mention tokens", () => {
    expect(findMentionedAgentIds("ping @qa-engineer and @QA_Engineer", agents)).toEqual(["agent-qa"]);
  });

  it("matches explicit url keys when present", () => {
    expect(findMentionedAgentIds("check with @custom-handle", agents)).toEqual(["agent-custom"]);
  });

  it("ignores unknown mentions", () => {
    expect(findMentionedAgentIds("hello @nobody", agents)).toEqual([]);
  });
});
