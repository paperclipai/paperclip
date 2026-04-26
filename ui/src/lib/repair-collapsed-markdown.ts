import { normalizeMarkdown } from "./normalize-markdown";

const BLOCK_MARKER_AT_LINE_START = /^\s*(?:>\s|#{1,6}\s|[-*]\s|\d+\.\s|---(?:\s|$))/;

function countInlineBlockMarkers(text: string) {
  const matches = text.match(/(?:^|[^\n])[ \t]+(?=(?:>\s|#{1,6}\s|[-*]\s|\d+\.\s|---(?:\s|$)))/g);
  return matches?.length ?? 0;
}

function looksLikeCollapsedMarkdown(text: string) {
  const normalized = normalizeMarkdown(text);
  const lines = normalized.split("\n");
  const lineCount = lines.length;
  if (lineCount > 8) return false;
  const structuredLineCount = lines.filter((line) => BLOCK_MARKER_AT_LINE_START.test(line)).length;
  const inlineMarkerCount = countInlineBlockMarkers(normalized);
  return inlineMarkerCount >= 3 && inlineMarkerCount > structuredLineCount;
}

export function repairCollapsedMarkdown(text: string): string {
  const normalized = normalizeMarkdown(text);
  if (!looksLikeCollapsedMarkdown(normalized)) return normalized;

  return normalized
    .replace(/[ \t]+(?=>\s)/g, "\n")
    .replace(/[ \t]+(?=(?:#{1,6}\s|---(?:\s|$)))/g, "\n\n")
    .replace(/(?<!#)[ \t]+(?=(?:[-*]\s|\d+\.\s))/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isCollapsedMarkdown(text: string): boolean {
  return looksLikeCollapsedMarkdown(text);
}
