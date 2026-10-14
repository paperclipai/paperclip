import { describe, expect, it } from "vitest";
import { skillFileLinkHref } from "./skill-file-links";

const skill = { id: "11111111-1111-4111-8111-111111111111", slug: "review", key: "github/review", sourceType: "github" as const,
  metadata: { packageMode: "repository", skillSourcePath: "skills/review/SKILL.md" },
  fileInventory: ["SKILL.md", ".paperclip-repository/skills/review/SKILL.md", ".paperclip-repository/shared/checklist.md", ".paperclip-repository/shared/guide one.md"].map(path => ({ path, kind: "markdown" as const })) };

describe("saved skill file links", () => {
  it("resolves root instructions from their original repository directory", () => {
    expect(skillFileLinkHref(skill, "SKILL.md", "../../shared/checklist.md")).toBe("/skills/review/files/.paperclip-repository/shared/checklist.md");
  });
  it("resolves links within the saved repository and preserves fragments", () => {
    expect(skillFileLinkHref(skill, ".paperclip-repository/shared/checklist.md", "./guide%20one.md#summary")).toBe("/skills/review/files/.paperclip-repository/shared/guide%20one.md#summary");
  });
  it("leaves external URLs, application links and local anchors unchanged", () => {
    for (const href of ["https://example.com/guide", "mailto:review@example.com", "/issues/PAP-1", "#summary"]) expect(skillFileLinkHref(skill, "SKILL.md", href)).toBe(href);
  });
  it("does not link missing files or paths outside the saved inventory", () => {
    for (const href of ["references/missing.md", "../../../../../etc/passwd", "%E0%A4%A"]) expect(skillFileLinkHref(skill, "SKILL.md", href)).toBeNull();
  });
  it("keeps generated discovery links working for local copies", () => {
    expect(skillFileLinkHref({ ...skill, sourceType: "local_path" }, "SKILL.md", ".paperclip-repository/skills/review/SKILL.md")).toBe("/skills/review/files/.paperclip-repository/skills/review/SKILL.md");
  });
});
