import type { LabArtifact } from "../../kit";

/**
 * What a text-like artifact shows of itself: a document's opening as two
 * tiers of text, and a delimited file as a header with its first rows.
 */

interface ExcerptLine {
  text: string;
  /** A heading inside the document: its own line, foreground medium. At most one per excerpt. */
  heading: boolean;
  /** A list item: its own line behind a dash. */
  item: boolean;
}

const same = (a: string, b: string | undefined) => Boolean(b) && a.trim().toLowerCase() === b?.trim().toLowerCase();
/** "Revision 3 • 28 September 2026 • 12 slides • 16:9" — a document's own metadata line, which the meta line already covers. */
const isMetadataLine = (line: string) => line.length < 120 && line.split(/\s[•·|]\s/).length >= 3;

/** Characters of text above which a heading is no longer started (about two lines in the pane, three on a tile). */
const HEADING_AFTER = 110;

/**
 * The opening of a document as lines, not as one flattened run:
 *   - the opening heading is dropped (it restates the title right beside it),
 *     and so are a leading metadata line and a heading that repeats the summary;
 *   - at most ONE heading is kept, on its own line; the excerpt ends before a second;
 *   - a heading is only kept while the text above it is short (`HEADING_AFTER`),
 *     so a clamp cannot leave it stranded as the last visible line;
 *   - every paragraph and every list item is its own line.
 */
export function documentExcerpt(a: LabArtifact, maxChars = 600): ExcerptLine[] {
  const source = a.body ?? a.excerpt ?? "";
  const lines: ExcerptLine[] = [];
  let used = 0;
  let first = true;
  let headings = 0;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    const opening = first;
    first = false;
    if (heading && (opening || same(heading[1], a.summary) || same(heading[1], a.title))) continue;
    if (!heading && !item && lines.length === 0 && isMetadataLine(line)) continue;
    if (heading && ((headings += 1) > 1 || used > HEADING_AFTER)) break;
    const text = (heading?.[1] ?? item?.[1] ?? line).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "");
    lines.push({ text, heading: Boolean(heading), item: Boolean(item) });
    used += text.length;
    if (used >= maxChars) break;
  }
  // A heading with nothing under it says nothing.
  while (lines.length > 0 && lines[lines.length - 1].heading) lines.pop();
  return lines;
}

interface SheetPreview {
  header: string[];
  rows: string[][];
  /** Rows and columns that exist but are not shown: counted under the table, never clipped. */
  more: number;
  moreColumns: number;
}

/**
 * A delimited excerpt as a header and its first rows. `maxChars` is the width
 * the caller has, in monospace cells: columns are kept from the left while
 * they fit, and the rest are counted. The first column may truncate (it is
 * usually a name), so it is costed at twelve cells at most.
 */
export function sheetPreview(a: LabArtifact, maxRows = 3, maxChars = Number.POSITIVE_INFINITY): SheetPreview | null {
  if (!a.excerpt) return null;
  const lines = a.excerpt.trim().split("\n").map((line) => line.split(","));
  if (lines.length < 2) return null;
  const [header, ...rows] = lines;
  let columns = 0;
  let used = 0;
  for (let c = 0; c < header.length; c += 1) {
    const widest = Math.max(...lines.map((line) => (line[c] ?? "").length));
    const cost = (c === 0 ? Math.min(widest, 12) : widest) + (c === 0 ? 0 : 2);
    if (c > 0 && used + cost > maxChars) break;
    used += cost;
    columns += 1;
  }
  return {
    header: header.slice(0, columns),
    rows: rows.slice(0, maxRows).map((row) => row.slice(0, columns)),
    more: Math.max(0, rows.length - maxRows),
    moreColumns: header.length - columns,
  };
}
