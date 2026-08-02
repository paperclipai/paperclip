import { describe, expect, it } from "vitest";
import type { CompanySkillDetail } from "@paperclipai/shared";
import {
  buildBlankSkillDraft,
  buildForkSkillDraft,
  defaultSkillMarkdown,
  normalizeSkillDraftSlug,
  skillCreateDraftToPayload,
  splitCategoryDraft,
} from "./skill-create";

function skill(overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "paperclip/demo-skill",
    slug: "demo-skill",
    name: "Demo Skill",
    description: "A demo skill.",
    markdown: "---\nname: Demo Skill\ndescription: Existing\n---\n\n# Demo Skill\n",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    iconUrl: null,
    color: null,
    tagline: "Existing tagline",
    authorName: null,
    homepageUrl: null,
    categories: ["engineering", "review"],
    sharingScope: "company",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion: null,
    starredByCurrentActor: false,
    existingForks: [],
    ...overrides,
  };
}

describe("skill create helpers", () => {
  it("normalizes slugs and category drafts", () => {
    expect(normalizeSkillDraftSlug("  My Fancy_SKILL!!  ")).toBe("my-fancy-skill");
    expect(splitCategoryDraft(" Review, memory tools, review, , Agent_QA ")).toEqual([
      "Review",
      "memory tools",
      "Agent_QA",
    ]);
  });

  it("keeps commas as draft delimiters while allowing spaces inside category names", () => {
    expect(splitCategoryDraft(" AI Tools, Developer Experience, ai tools,  ")).toEqual([
      "AI Tools",
      "Developer Experience",
    ]);
  });

  it("builds blank drafts with default SKILL.md frontmatter", () => {
    const draft = buildBlankSkillDraft();

    expect(draft.name).toBe("");
    expect(draft.slug).toBe("");
    expect(draft.sharingScope).toBe("company");
    expect(draft.markdown).toContain("name: New Skill");
    expect(draft.markdown).toContain("Describe when agents should use this skill.");
  });

  it("builds fork drafts from the source skill metadata", () => {
    const draft = buildForkSkillDraft(skill({ color: "#123456", folderId: "bundled-folder" }));

    expect(draft.name).toBe("Demo Skill Fork");
    expect(draft.slug).toBe("demo-skill-fork");
    expect(draft.color).toBe("#123456");
    expect(draft.categories).toEqual(["engineering", "review"]);
    expect(draft.forkedFromSkillId).toBe("skill-1");
    expect(draft.forkedFromName).toBe("Demo Skill");
    expect(draft.folderId).toBeNull();
    expect(draft.markdown).toContain("name: Demo Skill Fork");
  });

  it("converts drafts to create payloads with fallback slug and markdown", () => {
    const draft = {
      ...buildBlankSkillDraft(),
      name: "Code Review",
      tagline: "Review repository changes.",
      markdown: "",
      categories: ["review"],
      sharingScope: "private" as const,
    };

    expect(skillCreateDraftToPayload(draft)).toMatchObject({
      name: "Code Review",
      slug: "code-review",
      description: "Review repository changes.",
      tagline: "Review repository changes.",
      categories: ["review"],
      sharingScope: "private",
      forkedFromSkillId: null,
      markdown: defaultSkillMarkdown("Code Review", "Review repository changes."),
    });
  });
});
