import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectInvokedSkill, type SkillInvocationContext } from "./skill-invocation.js";

const skillRoot = path.resolve("/runtime/.claude/skills");
const coach = {
  key: "company/coaching/coach",
  runtimeName: "coach--a1b2c3",
  source: "/source/coach",
  versionId: "version-1",
};
const context: SkillInvocationContext = { skillRoot, entries: [coach] };

describe("detectInvokedSkill", () => {
  it.each([coach.runtimeName, coach.key])("maps a Skill call using %s", (skill) => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "Using skill",
      title: "Skill",
      rawInput: { skill },
    }, context)).toEqual(coach);
  });

  it("maps a contained Read call to its materialized skill", () => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "Reading",
      title: "Read",
      rawInput: { file_path: path.join(skillRoot, coach.runtimeName, "SKILL.md") },
    }, context)).toEqual(coach);
  });

  // Live Claude ACP adapter shape: tool_call_update with kind "read",
  // human-readable title, and the path in rawInput + locations.
  it("maps a live claude-adapter read update via kind + rawInput", () => {
    const skillFile = path.join(skillRoot, coach.runtimeName, "SKILL.md");
    expect(detectInvokedSkill({
      type: "tool_call",
      text: `Read ${skillFile} (1 - 30)`,
      tag: "tool_call_update",
      title: `Read ${skillFile} (1 - 30)`,
      toolCallId: "toolu_01",
      kind: "read",
      locations: [{ path: skillFile, line: 1 }],
      rawInput: { file_path: skillFile, limit: 30 },
      content: [],
    }, context)).toEqual(coach);
  });

  it("maps a read update that only carries locations", () => {
    const skillFile = path.join(skillRoot, coach.runtimeName, "references", "api.md");
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "Read File",
      title: `Read file '${skillFile}'`,
      kind: "read",
      locations: [{ path: skillFile }],
      rawInput: {},
    }, context)).toEqual(coach);
  });

  it.each([
    ["unknown skill", { title: "Skill", rawInput: { skill: "missing" } }],
    ["sibling path", { title: "Read", rawInput: { file_path: path.resolve(skillRoot, "../secret") } }],
    ["root itself", { title: "Read", rawInput: { file_path: skillRoot } }],
    ["other tool", { title: "Grep", rawInput: { path: path.join(skillRoot, coach.runtimeName, "SKILL.md") } }],
    ["missing input", { title: "Read" }],
    ["pathless initial claude read", { title: "Read File", kind: "read" as const, locations: [], rawInput: {} }],
    ["terminal command starting with read", { title: "read -r line < file", kind: "execute" as const, rawInput: { command: "read -r line < file" } }],
    ["terminal cat of skill file", { title: `cat ${path.join(skillRoot, coach.runtimeName, "SKILL.md")}`, kind: "execute" as const, rawInput: { command: "cat" } }],
  ])("does not count %s", (_label, fixture) => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "tool call",
      ...fixture,
    }, context)).toBeNull();
  });
});
