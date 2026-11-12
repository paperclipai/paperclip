/**
 * Whether `later` restates `earlier` closely enough that saving both would
 * show the person the same answer twice.
 *
 * OpenCode models sometimes write their whole answer, call the completion
 * tool, and then write the answer again in slightly different words. Other
 * turns write the answer first and then a short line that only refers back to
 * it ("Answered above"). The first shape must be saved once; the second must
 * keep the earlier answer. A restatement therefore has to:
 *
 * - keep every link target and fenced code block of the earlier text, so no
 *   reference the person could follow is lost;
 * - be at least half as long as the earlier text, so a short pointer line is
 *   never treated as the answer; and
 * - repeat at least half of the earlier text's distinct words.
 */
export function restatesEarlierReply(earlier: string, later: string): boolean {
  const before = earlier.trim();
  const after = later.trim();
  if (!before || !after) return false;
  if (before === after) return true;
  if (after.length * 2 < before.length) return false;
  const laterTargets = new Set(linkTargets(after));
  if (!linkTargets(before).every((target) => laterTargets.has(target))) return false;
  const laterBlocks = new Set(fencedBlocks(after));
  if (!fencedBlocks(before).every((block) => laterBlocks.has(block))) return false;
  const earlierWords = proseWords(before);
  if (earlierWords.size === 0) return true;
  const laterWords = proseWords(after);
  let repeated = 0;
  for (const word of earlierWords) if (laterWords.has(word)) repeated += 1;
  return repeated * 2 >= earlierWords.size;
}

const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;

function linkTargets(text: string): string[] {
  return [...text.matchAll(LINK_TARGET)].map((match) => match[1]!);
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(FENCED_BLOCK)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
}

function proseWords(text: string): Set<string> {
  const prose = text.replace(FENCED_BLOCK, " ").replace(LINK_TARGET, "]");
  return new Set(prose.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}
