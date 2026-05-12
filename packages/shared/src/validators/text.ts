import { z } from "zod";

export const WORKSPACE_ROOT_PLAN_LINK_ERROR =
  "Workspace-root /plans links are not served. Publish this as an issue plan document or link a committed project repo docs file.";

export function normalizeEscapedLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);

const fencedCodeBlockPattern = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?=\n|$)|$)/g;
const inlineCodePattern = /`[^`\n]*`/g;
const markdownInlineLinkPattern = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const markdownReferenceLinkPattern = /^[ \t]{0,3}\[[^\]\n]+]:[ \t]*(<[^>\n]+>|[^ \t\n]+)/gim;
const rawLocalPlanTargetPattern =
  /(^|[\s<{"'( ])((?:\.\/)*(?:\/plans(?:[/?#][^\s<>)\]}"']*)?|plans\/[^\s<>)\]}"']*))/gi;

function stripMarkdownCode(value: string): string {
  return value
    .replace(fencedCodeBlockPattern, " ")
    .replace(inlineCodePattern, " ");
}

export function isWorkspaceRootPlanLinkTarget(rawTarget: string): boolean {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  target = target.replace(/\\([()<>])/g, "$1");
  while (target.startsWith("./")) {
    target = target.slice(2);
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return false;
  }

  return /^\/?plans(?:\/|[?#]|$)/i.test(target);
}

export function containsWorkspaceRootPlanLinks(value: string | null | undefined): boolean {
  if (!value) return false;
  const visibleMarkdown = stripMarkdownCode(value);

  for (const match of visibleMarkdown.matchAll(markdownInlineLinkPattern)) {
    if (match[1] && isWorkspaceRootPlanLinkTarget(match[1])) return true;
  }

  for (const match of visibleMarkdown.matchAll(markdownReferenceLinkPattern)) {
    if (match[1] && isWorkspaceRootPlanLinkTarget(match[1])) return true;
  }

  for (const match of visibleMarkdown.matchAll(rawLocalPlanTargetPattern)) {
    if (match[2] && isWorkspaceRootPlanLinkTarget(match[2])) return true;
  }

  return false;
}

export const paperclipTextSurfaceSchema = multilineTextSchema.refine(
  (value) => !containsWorkspaceRootPlanLinks(value),
  WORKSPACE_ROOT_PLAN_LINK_ERROR,
);
