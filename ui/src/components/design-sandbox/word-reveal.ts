/** Whole whitespace-delimited words; preserve original Markdown and whitespace. */
export function wordCount(text: string): number {
  return [...text.matchAll(/\S+/gu)].length;
}
export function revealWords(text: string, count: number): string {
  const matches = [...text.matchAll(/\S+\s*/gu)];
  if (count >= matches.length) return text;
  if (count <= 0) return "";
  const last = matches[Math.floor(count) - 1];
  return last ? text.slice(0, last.index + last[0].length) : "";
}
export function revealWordProgress(text: string, progress: number): string {
  return revealWords(text, Math.max(1, Math.ceil(wordCount(text) * Math.min(1, Math.max(0, progress)))));
}
