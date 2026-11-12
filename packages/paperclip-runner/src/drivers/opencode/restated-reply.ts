export function restatesEarlierReply(earlier: string, later: string): boolean {
  const before = earlier.trim();
  const after = later.trim();
  if (!before || !after) return false;
  if (before === after) return true;
  if (after.length * 2 < before.length) return false;
  const laterTargets = linkTargets(after);
  if (![...linkTargets(before)].every((target) => laterTargets.has(target))) return false;
  const laterBlocks = new Set(fencedBlocks(after));
  if (!fencedBlocks(before).every((block) => laterBlocks.has(block))) return false;
  const earlierWords = proseWords(before);
  if (earlierWords.size === 0) return true;
  const laterWords = proseWords(after);
  let repeated = 0;
  for (const word of earlierWords) if (laterWords.has(word)) repeated += 1;
  return repeated * 2 >= earlierWords.size;
}

const INLINE_LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)>?/gm;
const AUTOLINK = /<([a-z][a-z\d+.-]*:[^\s<>]+)>/gi;
const BARE_URL = /\b(?:https?|ftp|mailto):[^\s<>()[\]`"']+/gi;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;

function linkTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const pattern of [INLINE_LINK_TARGET, REFERENCE_DEFINITION, AUTOLINK]) {
    for (const match of text.matchAll(pattern)) targets.add(match[1]!);
  }
  for (const match of text.replace(FENCED_BLOCK, " ").matchAll(BARE_URL)) {
    targets.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return targets;
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(FENCED_BLOCK)].map((match) => match[1]!.replace(/\n$/, ""));
}

function proseWords(text: string): Set<string> {
  const prose = text.replace(FENCED_BLOCK, " ").replace(INLINE_LINK_TARGET, "]");
  return new Set(prose.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}
