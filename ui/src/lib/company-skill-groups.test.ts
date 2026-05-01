import { describe, expect, it } from "vitest";
import type { CompanySkillListItem } from "@paperclipai/shared";
import { groupCompanySkills, resolveCompanySkillGroup } from "./company-skill-groups";

function createSkill(overrides: Partial<CompanySkillListItem> = {}): CompanySkillListItem {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "paperclip/plan-review",
    slug: "plan-review",
    name: "Plan review",
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    attachedAgentCount: 0,
    editable: true,
    editableReason: null,
    sourceLabel: "Paperclip workspace",
    sourceBadge: "paperclip",
    sourcePath: null,
    ...overrides,
  };
}

describe("company skill grouping", () => {
  it("prefers explicit metadata categories when available", () => {
    const group = resolveCompanySkillGroup(createSkill({ metadata: { category: "Delivery" } }));

    expect(group).toMatchObject({
      id: "category:delivery",
      label: "Delivery",
      sortOrder: 0,
    });
  });

  it("normalizes explicit category labels for mixed capitalization", () => {
    const groups = groupCompanySkills([
      createSkill({ id: "1", metadata: { category: "delivery" }, key: "delivery-a" }),
      createSkill({ id: "2", metadata: { category: "Delivery" }, key: "delivery-b" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Delivery");
  });

  it("falls back to the skill namespace when the key is segmented", () => {
    const group = resolveCompanySkillGroup(createSkill({ metadata: null, key: "research/interview-notes" }));

    expect(group).toMatchObject({
      id: "namespace:research",
      label: "Research skills",
      sortOrder: 1,
    });
  });

  it("groups and sorts skills into stable sections", () => {
    const groups = groupCompanySkills([
      createSkill({ id: "2", name: "Shipping checklist", key: "ops/shipping-checklist" }),
      createSkill({ id: "1", name: "Review queue", metadata: { category: "Approvals" }, key: "review-queue" }),
      createSkill({ id: "3", name: "GitHub triage", key: "github-triage", sourceBadge: "github", sourceType: "github" }),
      createSkill({ id: "4", name: "Alpha", metadata: { category: "Approvals" }, key: "alpha" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Approvals",
      "Ops skills",
      "GitHub imports",
    ]);
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(["Alpha", "Review queue"]);
  });
});
