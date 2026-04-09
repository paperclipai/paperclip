import type { CompanySkillFileDetail } from "@paperclipai/shared";

export function splitSkillFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  let closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    // Handle file ending with --- and no trailing newline
    if (normalized.endsWith("\n---")) {
      closing = normalized.length - 4;
    } else {
      return { frontmatter: null, body: normalized };
    }
  }
  const afterClosing = closing + 4 < normalized.length ? normalized.slice(closing + 5).trimStart() : "";
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: afterClosing,
  };
}

export function mergeSkillFrontmatter(markdown: string, body: string) {
  const parsed = splitSkillFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

export function getCompanySkillEditorDraft(
  file: Pick<CompanySkillFileDetail, "content" | "markdown"> | null | undefined,
  viewMode: "preview" | "code",
) {
  if (!file) return "";
  if (!file.markdown || viewMode === "code") return file.content;
  return splitSkillFrontmatter(file.content).body;
}

export function buildCompanySkillSaveContent(
  file: Pick<CompanySkillFileDetail, "content" | "markdown"> | null | undefined,
  draft: string,
  viewMode: "preview" | "code",
) {
  if (!file) return draft;
  if (!file.markdown || viewMode === "code") return draft;
  return mergeSkillFrontmatter(file.content, draft);
}
