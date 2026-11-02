import { describe, expect, it } from "vitest";
import {
  agentSkillMatchesSearch,
  buildAgentSkillHaystack,
  filterAgentSkills,
} from "./agent-skill-filter";

const ROWS = [
  {
    key: "agent-browser",
    name: "agent-browser",
    slug: "agent-browser",
    author: "Paperclip",
    tagline: "Drive a real browser",
    description: "Inspect and interact with web pages",
    categories: ["automation", "web"],
  },
  {
    key: "para-memory-files",
    name: "para-memory-files",
    slug: "para",
    author: "Tiago",
    tagline: "PARA method memory",
    description: null,
    categories: ["memory"],
  },
];

describe("buildAgentSkillHaystack", () => {
  it("joins every searchable field lowercased", () => {
    expect(buildAgentSkillHaystack(ROWS[0])).toBe(
      "agent-browser agent-browser paperclip drive a real browser inspect and interact with web pages automation web",
    );
  });

  it("tolerates null / missing fields", () => {
    // 6 fields joined by a single space; only name is present.
    expect(buildAgentSkillHaystack({ name: "Solo" })).toBe(["solo", "", "", "", "", ""].join(" "));
    expect(buildAgentSkillHaystack({ name: "X", slug: null, description: null, categories: null })).toBe(
      ["x", "", "", "", "", ""].join(" "),
    );
  });
});

describe("agentSkillMatchesSearch", () => {
  it("matches empty / whitespace query", () => {
    expect(agentSkillMatchesSearch(ROWS[0], "")).toBe(true);
    expect(agentSkillMatchesSearch(ROWS[0], "   ")).toBe(true);
  });

  it("matches on name, category, description, and author case-insensitively", () => {
    expect(agentSkillMatchesSearch(ROWS[0], "BROWSER")).toBe(true);
    expect(agentSkillMatchesSearch(ROWS[0], "automation")).toBe(true);
    expect(agentSkillMatchesSearch(ROWS[0], "web pages")).toBe(true);
    expect(agentSkillMatchesSearch(ROWS[1], "tiago")).toBe(true);
  });

  it("does not match unrelated queries", () => {
    expect(agentSkillMatchesSearch(ROWS[1], "browser")).toBe(false);
  });
});

describe("filterAgentSkills", () => {
  it("returns the original list for an empty query", () => {
    expect(filterAgentSkills(ROWS, "")).toBe(ROWS);
    expect(filterAgentSkills(ROWS, "  ")).toBe(ROWS);
  });

  it("filters by the shared haystack fields and preserves order", () => {
    expect(filterAgentSkills(ROWS, "memory").map((r) => r.key)).toEqual(["para-memory-files"]);
    expect(filterAgentSkills(ROWS, "a").map((r) => r.key)).toEqual([
      "agent-browser",
      "para-memory-files",
    ]);
    expect(filterAgentSkills(ROWS, "nonexistent")).toEqual([]);
  });
});
