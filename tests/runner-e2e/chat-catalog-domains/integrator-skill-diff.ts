// Grades a written review of a file change against the real line diff of the
// two pinned revisions. It reads only quoted text (diff blocks, other fenced
// blocks, block quotes, inline code and double-quoted strings), never wording.
// A quote in a diff block must sit on its claimed side of a real changed hunk;
// any other block quote must exist verbatim in one of the two revisions.
export interface LineHunk { removed: string[]; added: string[] }
type Side = "removed" | "added" | "context" | "block" | "inline";
interface Quote { side: Side; text: string }

const normalize = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

export function lineHunks(oldText: string, newText: string): LineHunk[] {
  const a = oldText.split("\n"), b = newText.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const hunks: LineHunk[] = []; let current: LineHunk | undefined; let i = 0, j = 0;
  const flush = () => { if (current && [...current.removed, ...current.added].some(line => line.trim())) hunks.push(current); current = undefined; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; continue; }
    current ??= { removed: [], added: [] };
    if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) current.added.push(b[j++]!);
    else current.removed.push(a[i++]!);
  }
  flush();
  return hunks;
}

// Ellipses mark omitted text; each remaining piece must be a verbatim excerpt.
function segments(text: string) {
  return text.split(/…|\.\.\./).map(normalize).filter(piece => piece.replace(/[^A-Za-z0-9]/g, "").length >= 6);
}

export function reviewQuotes(reply: string): Quote[] {
  const quotes: Quote[] = [];
  let prose = reply.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang: string, body: string) => {
    const lines = body.split("\n").filter(line => line.trim());
    // Only an explicit diff block, or an unlabeled one with both + and - lines,
    // assigns sides; a Markdown bullet list in a plain block stays a plain quote.
    const diff = /^diff$/i.test(lang.trim()) || (!lang.trim() && lines.every(line => /^[+\- ]|^@@/.test(line))
      && lines.some(line => /^\+(?!\+\+)/.test(line)) && lines.some(line => /^-(?!--)/.test(line)));
    if (!diff) { quotes.push({ side: "block", text: body }); return "\n"; }
    for (const line of lines) {
      if (/^(?:---|\+\+\+|@@)/.test(line)) continue;
      quotes.push({ side: line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context", text: line.slice(1) });
    }
    return "\n";
  });
  // Block quotes may be indented under a list item.
  prose = prose.replace(/(?:^[ \t]*>[^\n]*(?:\n|$))+/gm, block => { quotes.push({ side: "block", text: block.replace(/^[ \t]*>\s?/gm, "") }); return "\n"; });
  // Emphasis inside an inline quote is presentation, not quoted text.
  for (const match of prose.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/g)) quotes.push({ side: "inline", text: (match[1] ?? match[2] ?? match[3]!).replace(/\*\*|__/g, "") });
  return quotes;
}

export function gradeDiffReview(reply: string, oldText: string, newText: string) {
  const hunks = lineHunks(oldText, newText), oldAll = normalize(oldText), newAll = normalize(newText);
  const removed = hunks.map(h => h.removed.map(normalize)), added = hunks.map(h => h.added.map(normalize));
  const misplaced: string[] = []; const covered = new Set<number>();
  for (const quote of reviewQuotes(reply)) {
    for (const piece of segments(quote.text)) {
      const inOld = oldAll.includes(piece), inNew = newAll.includes(piece);
      const removedHunk = removed.findIndex(lines => lines.some(line => line.includes(piece)));
      const addedHunk = added.findIndex(lines => lines.some(line => line.includes(piece)));
      // Multi-line block quotes may span several added lines of one hunk.
      const addedSpan = added.findIndex(lines => normalize(lines.join("\n")).includes(piece));
      const removedSpan = removed.findIndex(lines => normalize(lines.join("\n")).includes(piece));
      // A side-marked excerpt must come from a changed line on that side; text the
      // changed line shares with its counterpart (e.g. a bullet's lead-in) is
      // allowed but only a side-unique excerpt identifies the hunk.
      if (quote.side === "removed") { if (removedHunk < 0) misplaced.push(`-${piece}`); else if (!inNew) covered.add(removedHunk); continue; }
      if (quote.side === "added") { if (addedHunk < 0) misplaced.push(`+${piece}`); else if (!inOld) covered.add(addedHunk); continue; }
      if (quote.side !== "inline" && !inOld && !inNew) { misplaced.push(piece); continue; }
      if (inNew && !inOld && addedSpan >= 0) covered.add(addedSpan);
      if (inOld && !inNew && removedSpan >= 0) covered.add(removedSpan);
    }
  }
  return { hunkCount: hunks.length, covered: [...covered].sort(), misplaced };
}
