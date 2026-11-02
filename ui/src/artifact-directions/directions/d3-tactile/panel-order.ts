import type { LabArtifact, LabRun } from "../../kit";
import { isTaskDocument } from "./kind";

/**
 * How the panel is sectioned and ordered — as in the product.
 *
 * Artifacts are grouped by the run that produced them (agent + run start),
 * and whatever has no run — task documents, loose attachments, links — forms
 * one more group. Sections are newest first, and so are the items in each.
 * What waits for review is not moved to the front: each section's divider
 * counts it, and the switch above the desk narrows the desk to it.
 */

export interface PanelSection {
  id: string;
  /** Null for the group that has no run. */
  run: LabRun | null;
  /** The divider's label: the agent, or what the unowned group holds. */
  label: string;
  items: LabArtifact[];
  /** How many items carry the Review flag. */
  reviewCount: number;
}

const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function sectionsOf(artifacts: LabArtifact[]): PanelSection[] {
  const byRun = new Map<string, { run: LabRun | null; items: LabArtifact[] }>();
  for (const artifact of artifacts) {
    const key = artifact.run?.id ?? "other";
    const group = byRun.get(key) ?? { run: artifact.run ?? null, items: [] };
    group.items.push(artifact);
    byRun.set(key, group);
  }

  const sections = [...byRun.entries()].map(([id, { run, items }]) => {
    const sorted = [...items].sort((a, b) => newestFirst(a.updatedAt, b.updatedAt));
    return {
      id,
      run,
      label: run ? run.agent : items.every(isTaskDocument) ? "Task documents" : "Documents and links",
      items: sorted,
      reviewCount: items.filter((a) => a.review === "needs_review").length,
      // The product dates the unowned group by its newest row.
      at: run ? run.startedAt : sorted[0].updatedAt,
    };
  });

  return sections.sort((a, b) => newestFirst(a.at, b.at)).map(({ at: _at, ...section }) => section);
}

/** The same sections, holding only what carries the Review flag. */
export function onlyToReview(sections: PanelSection[]): PanelSection[] {
  return sections
    .map((section) => ({ ...section, items: section.items.filter((a) => a.review === "needs_review") }))
    .filter((section) => section.items.length > 0);
}
