export const PLACEHOLDER_COMMENT_PREFIXES = [
  "acknowledg",
  "working on",
  "continuing",
  "stale",
  "pure self-comment",
  "heartbeat handled",
] as const;

export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~>#]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlaceholderCommentBody(body: string | null | undefined): boolean {
  if (body == null) return false;
  const stripped = stripMarkdown(body).trim();
  if (stripped.length < 30) return true;

  const lc = stripped.toLowerCase();
  if (PLACEHOLDER_COMMENT_PREFIXES.some((prefix) => lc.startsWith(prefix))) return true;
  if (lc.includes("no external context change")) return true;
  return false;
}
