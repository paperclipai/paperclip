import { describe, expect, it, vi } from "vitest";
import { callCreateSkillTool, createSkillToolInput } from "./skill-tools.js";

const input = {
  name: "release-review", description: "Review release notes.", idempotencyKey: "release-review-1",
  markdown: "---\nname: release-review\ndescription: Review release notes.\n---\n\n# Review\nCheck each release note against the change.\n",
};

describe("create skill tool", () => {
  it("requires a usable skill with matching frontmatter", () => {
    expect(createSkillToolInput.parse(input)).toEqual(input);
    for (const markdown of ["I created it", "---\nname: different\ndescription: Review release notes.\n---\nBody", "---\nname: release-review\ndescription: Review release notes.\n---\n"]) {
      expect(createSkillToolInput.safeParse({ ...input, markdown }).success).toBe(false);
    }
    expect(createSkillToolInput.safeParse({ ...input, companyId: "foreign" }).success).toBe(false);
  });

  it.each([
    { markdown: "---\nname: [broken\n---\nBody" },
    { markdown: input.markdown.replace("description: Review release notes.", "description: Different purpose.") },
    { slug: "another-skill" },
    { markdown: "No frontmatter." },
  ])("rejects invalid skill content before any API call (%j)", async (invalid) => {
    const fetcher = vi.fn();
    await expect(callCreateSkillTool({ arguments: { ...input, ...invalid },
      apiUrl: "http://localhost:3100", token: "test-token", companyId: "company-1" }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses authenticated company route and returns only a portable skill reference", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "skill-1", name: input.name,
      slug: input.name, description: input.description, currentVersionId: "version-1", sourceLocator: "/private/managed/skill", markdown: input.markdown }), { status: 201 }));
    const result = await callCreateSkillTool({ arguments: input, apiUrl: "http://localhost:3100/api", token: "test-token", companyId: "company-1" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("http://localhost:3100/api/companies/company-1/skills", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(input);
    expect(result).toEqual({ id: "skill-1", name: input.name, slug: input.name, description: input.description, versionId: "version-1", studioPath: "/skills/studio/skill-1" });
  });
});
