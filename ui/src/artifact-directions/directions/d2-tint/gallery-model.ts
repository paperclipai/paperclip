import type { LabArtifact, LabGroup, LabKind } from "../../kit";
import { hasTextPreview } from "./kinds";

/**
 * GALLERY — what a folder shows of its contents, and how an opened stack is
 * sectioned.
 */

/** By the one rule: a picture or a text sheet is SHOWN; anything else stands in the folder as its glyph. */
type FaceKind = "picture" | "sheet" | "glyph";

/** One thing standing in a folder. `span` is its width in twelfths of the folder's mouth. */
export interface StackFace {
  artifact: LabArtifact;
  kind: FaceKind;
  span: number;
}

const MOUTH = 12;
/** A glyph takes a quarter of the mouth, a sheet a third (anything narrower cannot hold a line of text), a picture five twelfths. */
const COST: Record<FaceKind, number> = { picture: 5, sheet: 4, glyph: 3 };
/** Spare room goes to what there is to look at: sheets first, then pictures, up to half the mouth each. */
const WIDEST = 6;

/**
 * The faces of a stack, newest first. One artifact per KIND goes in before
 * any kind repeats, so what stands in the folder says what is inside it
 * rather than what happened to be edited last (today the face is the single
 * newest artifact — for ACM-3 an empty "FILE" box in front of twenty other
 * things). Room that is left over widens the sheets and pictures. `failed`
 * holds pictures that did not load: they stand as glyphs, and the room they
 * give back is filled again.
 */
export function stackFaces(group: LabGroup, failed: ReadonlySet<string> = new Set()): StackFace[] {
  const faceKind = (a: LabArtifact): FaceKind => (a.thumbnailUrl && !failed.has(a.id) ? "picture" : hasTextPreview(a) ? "sheet" : "glyph");
  const faces: StackFace[] = [];
  const kinds = new Set<LabKind>();
  const taken = new Set<string>();
  let used = 0;
  const take = (artifact: LabArtifact) => {
    const kind = faceKind(artifact);
    if (used + COST[kind] > MOUTH) return;
    faces.push({ artifact, kind, span: COST[kind] });
    taken.add(artifact.id);
    kinds.add(artifact.kind);
    used += COST[kind];
  };
  for (const artifact of group.artifacts) {
    if (!kinds.has(artifact.kind)) take(artifact);
  }
  for (const artifact of group.artifacts) {
    if (used >= MOUTH) break;
    if (!taken.has(artifact.id)) take(artifact);
  }
  for (const kind of ["sheet", "picture"] as const) {
    const wider = faces.filter((face) => face.kind === kind);
    for (let i = 0; used < MOUTH && wider.some((face) => face.span < WIDEST); i += 1) {
      const face = wider[i % wider.length];
      if (face.span >= WIDEST) continue;
      face.span += 1;
      used += 1;
    }
  }
  return faces;
}

export interface StackSection {
  /** "2026-09-28", or "2026-09-25_2026-09-26" for a span of days. */
  id: string;
  /** "Monday, September 28" — or "September 25 – 26" for a span. */
  label: string;
  artifacts: LabArtifact[];
  /** A span of days: its tiles carry their own date, not only the time. */
  spansDays: boolean;
}

const sameYear = (iso: string) => iso.slice(0, 4) === String(new Date().getFullYear());
const monthDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" });

function spanLabel(newest: string, oldest: string): string {
  const [from, to] = [monthDay(oldest), monthDay(newest)];
  const sameMonth = oldest.slice(0, 7) === newest.slice(0, 7);
  return `${from} – ${sameMonth ? to.split(" ").pop() : to}`;
}

/**
 * An opened stack by the day of the last edit, newest first — but a heading
 * has to earn its row. A day that fills at least one row of the grid gets its
 * own heading; quieter days next to each other share one ("September 25 – 26")
 * instead of each leaving a tile or two alone in a row. A date outside the
 * current year says its year.
 */
export function stackSections(artifacts: LabArtifact[], columns = 3): StackSection[] {
  const days = new Map<string, LabArtifact[]>();
  for (const artifact of artifacts) {
    const id = artifact.updatedAt.slice(0, 10);
    days.set(id, [...(days.get(id) ?? []), artifact]);
  }
  const ordered = [...days.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
  const year = (id: string) => (sameYear(id) ? "" : `, ${id.slice(0, 4)}`);
  const sections: StackSection[] = [];
  let quiet: [string, LabArtifact[]][] = [];
  const flush = () => {
    if (quiet.length === 1) {
      const [id, items] = quiet[0];
      sections.push({ id, label: `${items[0].dayLabel}${year(id)}`, artifacts: items, spansDays: false });
    } else if (quiet.length > 1) {
      const [newest, oldest] = [quiet[0][0], quiet[quiet.length - 1][0]];
      sections.push({ id: `${oldest}_${newest}`, label: `${spanLabel(newest, oldest)}${year(newest)}`, artifacts: quiet.flatMap(([, items]) => items), spansDays: true });
    }
    quiet = [];
  };
  for (const [id, items] of ordered) {
    if (items.length < columns) {
      quiet.push([id, items]);
      continue;
    }
    flush();
    sections.push({ id, label: `${items[0].dayLabel}${year(id)}`, artifacts: items, spansDays: false });
  }
  flush();
  return sections;
}

export const artifactCount = (count: number) => `${count} ${count === 1 ? "artifact" : "artifacts"}`;
