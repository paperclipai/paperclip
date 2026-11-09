import type { LabArtifact, LabGroup, LabKind } from "../../kit";
import { kindLabel } from "./kind";

/**
 * What the gallery derives from a stack: which of its artifacts stand in the
 * folder, how thick the pile behind them is, what kinds it holds, and its
 * artifacts by day.
 */

/** The kinds that say most about a stack come first; a box or a blank sheet only when nothing else is left. */
const PEEK_RANK: readonly LabKind[] = ["image", "video", "document", "slides", "pdf", "sheet", "code", "link"];
const DULL: ReadonlySet<LabKind> = new Set(["file", "archive"]);

/** Objects that stand taller than wide in a folder. */
export const standsTall = (a: LabArtifact) =>
  a.kind === "document" || a.kind === "pdf" || a.kind === "code" || a.kind === "file" || ((a.kind === "image" || a.kind === "video") && (a.aspect ?? 4 / 3) < 1.15);

/** How wide an `fd` object is, in rem (the `fd` table in tokens-gallery.css): the shelf keeps each one inside its folder's sides by it. */
export function widthOf(a: LabArtifact): number {
  switch (a.kind) {
    case "image":
    case "video": {
      const aspect = Math.min(1.9, Math.max(0.75, a.aspect ?? 4 / 3));
      return aspect < 1.15 ? 7.75 * aspect : 9.5;
    }
    case "slides":
    case "link":
      return 8.8;
    case "sheet":
      return 8.4;
    case "archive":
      return 7.125;
    default:
      return 7.5;
  }
}

/** A folder is 21.5rem inside its edges; contents may overlap by about a third. */
const POCKET_BUDGET = 29.5;
const MAX_PEEK = 4;

/**
 * The artifacts that stand in a stack's folder: one of each telling kind
 * first (so a mixed stack shows its mix), then the newest of what is left (so
 * a stack of photos shows photos), as many as fit the pocket — three or four.
 * Tall sheets and wide prints alternate so neither hides the other.
 */
export function peekOf(group: LabGroup): LabArtifact[] {
  const picked: LabArtifact[] = [];
  let width = 0;
  const take = (a: LabArtifact | undefined) => {
    if (!a || picked.includes(a) || picked.length >= MAX_PEEK || width + widthOf(a) > POCKET_BUDGET) return;
    picked.push(a);
    width += widthOf(a);
  };
  for (const kind of PEEK_RANK) take(group.artifacts.find((a) => a.kind === kind));
  for (const a of group.artifacts) if (!DULL.has(a.kind)) take(a);
  for (const a of group.artifacts) take(a);

  const tall = picked.filter(standsTall);
  const wide = picked.filter((a) => !standsTall(a));
  const arranged: LabArtifact[] = [];
  while (tall.length > 0 || wide.length > 0) {
    const next = tall.shift();
    if (next) arranged.push(next);
    const other = wide.shift();
    if (other) arranged.push(other);
  }
  return arranged;
}

/** How much more a folder holds than it shows, as a pile level: 0 nothing, 1 a little (one sheet top behind the contents), 2 some (two), 3 a lot (four, and a deeper mouth). */
export function pileOf(count: number, shown: number): 0 | 1 | 2 | 3 {
  const hidden = count - shown;
  if (hidden <= 0) return 0;
  if (hidden < 4) return 1;
  if (hidden < 12) return 2;
  return 3;
}

export const reviewCountOf = (artifacts: readonly LabArtifact[]) => artifacts.filter((a) => a.review === "needs_review").length;

export const countLabel = (count: number) => (count === 1 ? "artifact" : "artifacts");

/** "Document 7 · Slides 3 · PDF 3 …": what a stack holds, largest group first, in the product's kind wording. */
export function tallyOf(artifacts: readonly LabArtifact[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of artifacts) counts.set(kindLabel(a), (counts.get(kindLabel(a)) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export interface DayGroup {
  /** "2026-09-28" */
  day: string;
  /** "Monday, September 28, 2026" */
  label: string;
  items: LabArtifact[];
}

/** A stack's artifacts by the day they were last edited: newest day first, newest first within a day. */
export function daysOf(artifacts: readonly LabArtifact[]): DayGroup[] {
  const days = new Map<string, DayGroup>();
  for (const a of [...artifacts].sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0))) {
    const day = a.updatedAt.slice(0, 10);
    // The year is part of the heading: a stack outlives the year it was started in.
    const group = days.get(day) ?? { day, label: `${a.dayLabel}, ${day.slice(0, 4)}`, items: [] };
    group.items.push(a);
    days.set(day, group);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** "11:07 AM" from "Sep 28, 2026, 11:07 AM". */
export function timeOf(a: LabArtifact): string {
  const cut = a.updatedLabel.lastIndexOf(", ");
  return cut >= 0 ? a.updatedLabel.slice(cut + 2) : a.updatedLabel;
}
