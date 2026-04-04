import type { CompanySkillFileDetail } from "@paperclipai/shared";

export function splitSkillFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
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
