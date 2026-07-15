import { describe, expect, it } from "vitest";
import {
  normalizeSkillPolicySourceLocator,
  skillPolicyDocumentSchema,
  skillPolicyEvaluationResourceSchema,
} from "./skill-policy.js";

const credentialBearingLocators = [
  "https://vault.example/?token=hvs.x",
  "https://vault.example/?api_key=secret",
  "https://vault.example/#token=hvs.x",
  "https://vault.example/#section?authorization=Bearer",
];

describe("skill policy source locators", () => {
  it.each(credentialBearingLocators)("rejects credential-bearing locator %s in policy rules", (sourceLocator) => {
    expect(() => skillPolicyDocumentSchema.parse({
      schemaVersion: 1,
      defaultEffect: "allow",
      rules: [{
        id: "deny-secret-source",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: [sourceLocator] },
      }],
    })).toThrow(/credentials or secret query or fragment parameters/i);
  });

  it.each(credentialBearingLocators)("rejects credential-bearing locator %s in evaluations", (sourceLocator) => {
    expect(() => skillPolicyEvaluationResourceSchema.parse({ sourceLocator }))
      .toThrow(/credentials or secret query or fragment parameters/i);
  });

  it("allows non-secret URL fragments", () => {
    expect(skillPolicyEvaluationResourceSchema.parse({
      sourceLocator: "https://docs.example/skill#installation",
    })).toEqual({ sourceLocator: "https://docs.example/skill#installation" });
  });
});

describe("normalizeSkillPolicySourceLocator", () => {
  it.each([
    ["https://github.com/Owner/Repo.git", "https://github.com/owner/repo"],
    ["https://WWW.GitHub.com/Owner/Repo", "https://github.com/owner/repo"],
    ["https://GitLab.com/Owner/Repo.git", "https://gitlab.com/owner/repo"],
    ["https://github.com/Owner/Repo/tree/Main/Skills", "https://github.com/owner/repo/tree/Main/Skills"],
    ["  https://github.com/owner/repo  ", "https://github.com/owner/repo"],
  ])("canonicalizes repo-style locator %s", (input, expected) => {
    expect(normalizeSkillPolicySourceLocator(input)).toBe(expected);
  });

  it.each([
    "/srv/company/skills/pr-gardening",
    "@paperclipai/skill-pack",
    "https://gist.github.com/Owner/abc123",
    "https://raw.githubusercontent.com/Owner/Repo/main/SKILL.md",
    "https://docs.example/skill#installation",
  ])("leaves non-repo locator %s unchanged", (input) => {
    expect(normalizeSkillPolicySourceLocator(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = normalizeSkillPolicySourceLocator("https://github.com/Owner/Repo.git");
    expect(normalizeSkillPolicySourceLocator(once)).toBe(once);
  });

  it("normalizes rule sourceLocators on parse so deny rules match normalized resources", () => {
    const parsed = skillPolicyDocumentSchema.parse({
      schemaVersion: 1,
      defaultEffect: "allow",
      rules: [{
        id: "deny-repo",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: ["https://github.com/Owner/Repo.git"] },
      }],
    });
    expect(parsed.rules[0]!.resources!.sourceLocators).toEqual(["https://github.com/owner/repo"]);
  });

  it("normalizes evaluation resource sourceLocators on parse", () => {
    expect(skillPolicyEvaluationResourceSchema.parse({
      sourceLocator: "https://WWW.GitHub.com/Owner/Repo.git",
    })).toEqual({ sourceLocator: "https://github.com/owner/repo" });
  });

  it("rejects locators that collapse to duplicates after normalization", () => {
    expect(() => skillPolicyDocumentSchema.parse({
      schemaVersion: 1,
      defaultEffect: "allow",
      rules: [{
        id: "deny-repo",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: ["https://github.com/Owner/Repo.git", "https://github.com/owner/repo"] },
      }],
    })).toThrow(/unique/i);
  });
});
