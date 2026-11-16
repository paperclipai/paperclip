import type { LabArtifact } from "../../kit";
import { isTaskDocument } from "./kinds";

/**
 * How the panel is sectioned and ordered: exactly as the product does it.
 *
 * Work products are grouped by the run that produced them (agent + run start);
 * task documents, which no run produced, are a section of their own. Sections
 * and the cards inside them keep the order the product lists them in — Solid
 * changes how an artifact looks, not where it is found.
 */

export interface PanelSection {
  id: string;
  /** The producing agent, or a name for what was not produced by a run. */
  title: string;
  /** The agent every artifact in the section shares, when it is a run. A card repeats an author only when it differs. */
  agent?: string;
  /** "Sep 28, 2026, 10:52 AM" — a run's start. */
  startedLabel?: string;
  startedAt?: string;
  /** "artifact", or "document" when the section holds task documents only. */
  noun: string;
  items: LabArtifact[];
}

export function panelSections(artifacts: LabArtifact[]): PanelSection[] {
  // A Map keeps insertion order: sections appear where their first artifact does, cards as listed.
  const byRun = new Map<string, LabArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifact.run?.id ?? "";
    byRun.set(key, [...(byRun.get(key) ?? []), artifact]);
  }
  return [...byRun.entries()].map(([runId, items]): PanelSection => {
    const run = items[0].run;
    const documentsOnly = items.every(isTaskDocument);
    return {
      id: runId || "loose",
      title: run ? run.agent : documentsOnly ? "Task documents" : "Other artifacts",
      agent: run?.agent,
      startedLabel: run?.startedLabel,
      startedAt: run?.startedAt,
      noun: !run && documentsOnly ? "document" : "artifact",
      items,
    };
  });
}

/**
 * A timestamp for a narrow row: the product's label without the year when it
 * is this year ("Sep 28, 11:07 AM"). The full label stays in the tooltip.
 */
export const shortStamp = (label: string) => label.replace(`, ${new Date().getFullYear()}`, "");

const day = (label: string) => label.slice(0, label.lastIndexOf(", "));

/**
 * A card's stamp under a section header that already carries a date: the time
 * alone when the day is the section's ("11:07 AM"), the short stamp otherwise.
 */
export function stampUnder(label: string, sectionLabel: string | undefined): string {
  return sectionLabel && day(label) === day(sectionLabel) ? label.slice(label.lastIndexOf(", ") + 2) : shortStamp(label);
}
