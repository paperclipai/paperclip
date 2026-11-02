import { LAB_KINDS, type LabArtifact, type LabKind, type LabRun } from "../../kit";
import { isTaskDocument } from "./kinds";

/**
 * PANEL — what goes where on the task's shelf.
 *
 * The product's own order, unchanged: artifacts are grouped by producing run
 * (agent + run start) with everything that has no run in one group, groups
 * are newest first, and inside a group the order is the one given. Review is
 * expressed without re-sorting: a section says how many of its items are
 * waiting, and the index has a Review filter.
 */

export type PanelFilter = "all" | "review" | LabKind;

export interface PanelSection {
  id: string;
  /** The agent for a run; "Task documents" (or the wider label) for the rest. */
  title: string;
  run?: LabRun;
  artifacts: LabArtifact[];
  /** Items in `needs_review`. */
  reviewCount: number;
  /** The newest edit in the section, for a section with no run. */
  latest: LabArtifact;
}

const needsReview = (a: LabArtifact) => a.review === "needs_review";

function matchesFilter(a: LabArtifact, filter: PanelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "review") return needsReview(a);
  return a.kind === filter;
}

export function buildSections(artifacts: LabArtifact[], filter: PanelFilter = "all"): PanelSection[] {
  const groups = new Map<string, LabArtifact[]>();
  for (const artifact of artifacts) {
    if (!matchesFilter(artifact, filter)) continue;
    const key = artifact.run?.id ?? "ungrouped";
    groups.set(key, [...(groups.get(key) ?? []), artifact]);
  }
  const sections = [...groups.entries()].map(([id, items]): PanelSection & { at: string } => {
    const run = items[0].run;
    const latest = items.reduce((newest, a) => (a.updatedAt > newest.updatedAt ? a : newest), items[0]);
    return {
      id,
      title: run ? run.agent : items.every(isTaskDocument) ? "Task documents" : "Documents and links",
      run,
      artifacts: items,
      reviewCount: items.filter(needsReview).length,
      latest,
      // The product's group order: a run by its start, the rest by their newest row.
      at: run ? run.startedAt : latest.updatedAt,
    };
  });
  sections.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return sections;
}

export interface KindTally {
  kind: LabKind;
  count: number;
}

/** One entry per kind present, in the vocabulary's order. */
export function tallyKinds(artifacts: LabArtifact[]): KindTally[] {
  return LAB_KINDS.map((kind) => ({ kind, count: artifacts.filter((a) => a.kind === kind).length })).filter((t) => t.count > 0);
}

export const countReview = (artifacts: LabArtifact[]) => artifacts.filter(needsReview).length;

const PLURAL: Record<LabKind, [string, string]> = {
  document: ["Document", "Documents"],
  image: ["Image", "Images"],
  video: ["Video", "Videos"],
  pdf: ["PDF", "PDFs"],
  slides: ["Slide deck", "Slide decks"],
  sheet: ["Sheet", "Sheets"],
  archive: ["Archive", "Archives"],
  code: ["Code file", "Code files"],
  file: ["File", "Files"],
  link: ["Link", "Links"],
};

export const kindNoun = (kind: LabKind, count: number) => PLURAL[kind][count === 1 ? 0 : 1];

/** The same noun inside a sentence: "documents", "slide decks" — and still "PDFs". */
export function kindNounInline(kind: LabKind, count: number): string {
  const noun = kindNoun(kind, count);
  return kind === "pdf" ? noun : noun.toLowerCase();
}
