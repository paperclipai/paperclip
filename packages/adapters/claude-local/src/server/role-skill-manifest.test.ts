import { describe, expect, it } from "vitest";
import {
  applyRoleSkillFilter,
  mapAgentNameToRoleKey,
  skillKeyMatchesPattern,
} from "./role-skill-manifest.js";

describe("skillKeyMatchesPattern", () => {
  it("matches exactly", () => {
    expect(skillKeyMatchesPattern("paperclip", "paperclip")).toBe(true);
  });

  it("matches versioned suffix (--hash)", () => {
    expect(skillKeyMatchesPattern("pdf--3924e73e8d", "pdf")).toBe(true);
    expect(skillKeyMatchesPattern("pptx--c1963e1344", "pptx")).toBe(true);
    expect(skillKeyMatchesPattern("verification-before-completion--a42c12e610", "verification-before-completion")).toBe(true);
  });

  it("matches hyphenated family prefix", () => {
    expect(skillKeyMatchesPattern("paperclip-dev", "paperclip")).toBe(true);
    expect(skillKeyMatchesPattern("paperclip-create-agent", "paperclip")).toBe(true);
    expect(skillKeyMatchesPattern("paperclip-converting-plans-to-tasks", "paperclip")).toBe(true);
  });

  it("does not match unrelated keys with same prefix letters", () => {
    expect(skillKeyMatchesPattern("paperclips-all", "paperclip")).toBe(false);
    expect(skillKeyMatchesPattern("pdf2", "pdf")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(skillKeyMatchesPattern("PDF--abc", "pdf")).toBe(true);
    expect(skillKeyMatchesPattern("pdf--abc", "PDF")).toBe(true);
  });
});

describe("mapAgentNameToRoleKey", () => {
  it("maps CTO agent names", () => {
    expect(mapAgentNameToRoleKey("CTO")).toBe("cto");
    expect(mapAgentNameToRoleKey("CTO (Claude)")).toBe("cto");
  });

  it("maps Coder agent names", () => {
    expect(mapAgentNameToRoleKey("Coder (Claude)")).toBe("coder");
    expect(mapAgentNameToRoleKey("Coder")).toBe("coder");
  });

  it("maps Director of Engineering", () => {
    expect(mapAgentNameToRoleKey("Director of Engineering")).toBe("doe");
    expect(mapAgentNameToRoleKey("Director of Engineering (GCP)")).toBe("doe");
  });

  it("maps QA roles by specificity", () => {
    expect(mapAgentNameToRoleKey("QA Regression GCP")).toBe("qa-regression");
    expect(mapAgentNameToRoleKey("QA Unit Tests GCP")).toBe("qa-unit");
    expect(mapAgentNameToRoleKey("QA Integration")).toBe("qa-integration");
    expect(mapAgentNameToRoleKey("QA Bench")).toBe("qa");
  });

  it("maps CEO as known but no manifest entry (pass-through)", () => {
    expect(mapAgentNameToRoleKey("CEO (Claude)")).toBe("ceo");
    expect(mapAgentNameToRoleKey("CEO")).toBe("ceo");
  });

  it("returns null for unknown roles", () => {
    expect(mapAgentNameToRoleKey("Unknown Role")).toBeNull();
    expect(mapAgentNameToRoleKey("")).toBeNull();
    expect(mapAgentNameToRoleKey("Pricing Director")).toBe("pricing-director");
  });
});

describe("applyRoleSkillFilter", () => {
  const ALL_SKILLS = new Set([
    "paperclip",
    "paperclip-dev",
    "paperclip-create-agent",
    "using-superpowers--18e47fa60f",
    "test-driven-development--f22c9c9eef",
    "verification-before-completion--a42c12e610",
    "requesting-code-review--c5ff6e3659",
    "pdf--3924e73e8d",
    "pptx--c1963e1344",
    "docx--09389f3e7a",
    "xlsx--9920361cca",
    "systematic-debugging--d9a83639ff",
    "review--fedc51a189",
    "security-review",
  ]);

  it("passes all skills through for unknown agent names", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "Unknown Role");
    expect(result).toBe(ALL_SKILLS); // same reference = pass-through
  });

  it("passes all skills through for CEO (no manifest entry)", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "CEO (Claude)");
    expect(result).toBe(ALL_SKILLS);
  });

  it("filters document skills for Coder role", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "Coder (Claude)");
    expect(result.has("pdf--3924e73e8d")).toBe(false);
    expect(result.has("pptx--c1963e1344")).toBe(false);
    expect(result.has("docx--09389f3e7a")).toBe(false);
    expect(result.has("xlsx--9920361cca")).toBe(false);
  });

  it("retains required engineering skills for Coder role", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "Coder (Claude)");
    expect(result.has("using-superpowers--18e47fa60f")).toBe(true);
    expect(result.has("test-driven-development--f22c9c9eef")).toBe(true);
    expect(result.has("verification-before-completion--a42c12e610")).toBe(true);
    expect(result.has("requesting-code-review--c5ff6e3659")).toBe(true);
    expect(result.has("paperclip")).toBe(true);
  });

  it("filters document skills for CTO role", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "CTO");
    expect(result.has("pdf--3924e73e8d")).toBe(false);
    expect(result.has("pptx--c1963e1344")).toBe(false);
    expect(result.has("docx--09389f3e7a")).toBe(false);
    expect(result.has("xlsx--9920361cca")).toBe(false);
    expect(result.has("paperclip")).toBe(true);
    expect(result.has("security-review")).toBe(true);
  });

  it("reports elided skills via callback", () => {
    const elided: string[] = [];
    applyRoleSkillFilter(ALL_SKILLS, "Coder (Claude)", (e) => elided.push(...e));
    expect(elided).toEqual(expect.arrayContaining(["pdf--3924e73e8d", "pptx--c1963e1344"]));
    expect(elided.length).toBeGreaterThan(0);
  });

  it("does not call elided callback when nothing is filtered", () => {
    const skills = new Set(["paperclip", "test-driven-development--f22c9c9eef"]);
    const elided: string[] = [];
    applyRoleSkillFilter(skills, "Coder (Claude)", (e) => elided.push(...e));
    // These skills are all in the coder manifest, so nothing should be elided
    expect(elided).toHaveLength(0);
  });

  it("intersection leaves empty set when no skills match the manifest", () => {
    const onlyDocSkills = new Set(["pdf--3924e73e8d", "pptx--c1963e1344", "docx--09389f3e7a"]);
    const result = applyRoleSkillFilter(onlyDocSkills, "CTO");
    expect(result.size).toBe(0);
  });

  it("handles QA Regression GCP agent name", () => {
    const result = applyRoleSkillFilter(ALL_SKILLS, "QA Regression GCP");
    expect(result.has("test-driven-development--f22c9c9eef")).toBe(true);
    expect(result.has("pdf--3924e73e8d")).toBe(false);
    expect(result.has("paperclip")).toBe(true);
  });
});
