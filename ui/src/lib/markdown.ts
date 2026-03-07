const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const SPACE_ENTITY_RE = /&#x20;/gi;
const ESCAPED_UNORDERED_LIST_RE = /^(\s{0,3})\\([*+-])([ \t]+)/;

/**
 * Normalize markdown artifacts emitted by rich-text serialization so
 * plain markdown list syntax remains usable in Paperclip editors.
 */
export function normalizeMarkdownArtifacts(markdown: string): string {
  if (!markdown) return markdown;

  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker: "`" | "~" | null = null;
  let fenceLength = 0;
  let changed = false;

  const normalized = lines.map((line) => {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0] as "`" | "~";
        fenceLength = marker.length;
      } else if (marker[0] === fenceMarker && marker.length >= fenceLength) {
        inFence = false;
        fenceMarker = null;
        fenceLength = 0;
      }
      return line;
    }

    if (inFence) return line;

    let next = line;
    if (next.includes("&#x20;")) {
      next = next.replace(SPACE_ENTITY_RE, " ");
    }
    const unescaped = next.replace(ESCAPED_UNORDERED_LIST_RE, "$1$2$3");
    if (unescaped !== line) changed = true;
    return unescaped;
  });

  if (!changed) return markdown;
  return normalized.join("\n");
}
