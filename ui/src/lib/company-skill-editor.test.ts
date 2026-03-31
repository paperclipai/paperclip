import { describe, expect, it } from "vitest";
import {
  buildCompanySkillSaveContent,
  getCompanySkillEditorDraft,
  mergeSkillFrontmatter,
  splitSkillFrontmatter,
} from "./company-skill-editor";

describe("company skill editor helpers", () => {
  const markdownFile = {
    markdown: true,
    content: [
      "---",
      "name: demo-skill",
      "description: demo",
      "---",
      "",
      "# Demo",
      "",
      "Body text",
      "",
    ].join("\n"),
  };

  it("splits frontmatter from markdown skill files", () => {
    expect(splitSkillFrontmatter(markdownFile.content)).toEqual({
      frontmatter: "name: demo-skill\ndescription: demo",
      body: "# Demo\n\nBody text\n",
    });
  });

  it("keeps frontmatter when saving preview-mode markdown edits", () => {
    expect(mergeSkillFrontmatter(markdownFile.content, "# Demo\n\nUpdated body\n")).toContain("name: demo-skill");
    expect(buildCompanySkillSaveContent(markdownFile, "# Demo\n\nUpdated body\n", "preview")).toContain("Updated body");
  });

  it("returns raw markdown in code mode so frontmatter can be edited", () => {
    expect(getCompanySkillEditorDraft(markdownFile, "code")).toBe(markdownFile.content);
    expect(buildCompanySkillSaveContent(markdownFile, "---\nname: renamed\n---\n\n# Demo\n", "code")).toBe(
      "---\nname: renamed\n---\n\n# Demo\n",
    );
  });

  it("treats non-markdown files as raw text", () => {
    const file = { markdown: false, content: "echo hello\n" };
    expect(getCompanySkillEditorDraft(file, "preview")).toBe("echo hello\n");
    expect(buildCompanySkillSaveContent(file, "echo updated\n", "preview")).toBe("echo updated\n");
  });
});
