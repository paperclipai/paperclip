import type { LabArtifact } from "../../kit";

/**
 * What is printed on a paper sheet: the artifact's own text, in the order it
 * has it. Where Tint's excerpt (excerpt.ts) is a summary for a caption —
 * opening heading dropped, one heading at most — the page is the document as
 * it is: its first heading as the title, then every paragraph, heading and
 * list item after it, until the page runs out (the fade hides the rest).
 */

interface PaperLine {
  text: string;
  /** A heading inside the document: its own line, heavier, in the page's ink. */
  kind: "heading" | "item" | "para";
}

interface PaperPage {
  title: string;
  lines: PaperLine[];
}

const strip = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "");

/** A document's page: the first heading is the title (else the artifact's), everything after it is set in order. */
export function paperPage(a: LabArtifact, maxChars = 900): PaperPage {
  const source = a.body ?? a.excerpt ?? "";
  let title: string | undefined;
  const lines: PaperLine[] = [];
  let used = 0;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const text = strip(heading?.[1] ?? bullet?.[1] ?? line);
    if (heading && title === undefined && lines.length === 0) {
      title = text;
      continue;
    }
    // A numbered item keeps its number; a bullet gets the page's own mark.
    lines.push({ text, kind: heading ? "heading" : bullet ? "item" : "para" });
    used += text.length;
    if (used >= maxChars) break;
  }
  // A heading with nothing under it says nothing.
  while (lines.length > 0 && lines[lines.length - 1].kind === "heading") lines.pop();
  return { title: title ?? a.title, lines };
}

interface PaperRows {
  header: string[];
  rows: string[][];
}

/** A delimited file as its header and first rows; columns that do not fit are clipped by the sheet's edge. */
export function paperRows(a: LabArtifact, maxRows = 12): PaperRows | null {
  if (!a.excerpt) return null;
  const lines = a.excerpt
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(","));
  if (lines.length < 2) return null;
  const [header, ...rows] = lines;
  return { header, rows: rows.slice(0, maxRows) };
}

/** A code file's first lines, indentation kept. */
export function paperCode(a: LabArtifact, maxLines = 24): string[] {
  return (a.excerpt ?? "").split("\n").slice(0, maxLines);
}
