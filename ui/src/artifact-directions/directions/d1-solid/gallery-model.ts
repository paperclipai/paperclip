import { ArrowRight, Download, ExternalLink } from "lucide-react";
import type { LabArtifact, LabGroup } from "../../kit";
import type { SolidAction } from "./actions";
import { blockLabel, hasThumbnail, isTaskDocument, slug } from "./kinds";

/**
 * How the gallery reads its data: what a tile's preview is, which previews a
 * stack shows, how an opened stack is sectioned, and what a tile offers.
 */

/**
 * The three previews of the direction, by what the artifact has to show:
 *   picture  image, video poster, link preview      → the picture, kind tab in the corner
 *   text     task document, Markdown, code, sheet   → its own words on a sheet, kind tab in the corner
 *   facts    PDF, slides, archive, any other file   → a sheet that says what is known of it, the kind block docked in the corner
 */
export type PreviewKind = "picture" | "text" | "facts";

export function previewKind(a: LabArtifact): PreviewKind {
  if (hasThumbnail(a)) return "picture";
  return a.excerpt ? "text" : "facts";
}

const VISUAL: Record<PreviewKind, number> = { picture: 0, text: 1, facts: 2 };

/**
 * A stack's mosaic: its three newest artifacts (what the API already sends as
 * `previewArtifacts`), with the one that has most to show in the large cell —
 * a picture before text before bare facts.
 */
export function stackPreviews(group: LabGroup): LabArtifact[] {
  return group.artifacts
    .slice(0, 3)
    .map((artifact, index) => ({ artifact, index }))
    .sort((a, b) => VISUAL[previewKind(a.artifact)] - VISUAL[previewKind(b.artifact)] || a.index - b.index)
    .map((entry) => entry.artifact);
}

/** How many slabs sit behind a stack's face: none for one artifact, one for two or three, two for a real pile. */
export const pileDepth = (count: number): 0 | 1 | 2 => (count <= 1 ? 0 : count <= 3 ? 1 : 2);

/**
 * What is in the pile, for the edge of the slab behind a stack's face: kinds
 * by their block label, most numerous first ("PDF 4 · PPTX 4 · PNG 3").
 * Task documents are counted together as DOCS — their block label is a revision.
 */
export function kindTally(artifacts: LabArtifact[]): string[] {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    const label = isTaskDocument(artifact) ? "DOCS" : blockLabel(artifact);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => `${label} ${count}`);
}

export interface DaySection {
  /** "2026-09-28" */
  id: string;
  /** "Monday, September 28" */
  label: string;
  items: LabArtifact[];
}

/** An opened stack by the day of the last edit, newest day first; inside a day the page's own order (newest first) is kept. */
export function daySections(artifacts: LabArtifact[]): DaySection[] {
  const byDay = new Map<string, DaySection>();
  for (const artifact of artifacts) {
    const id = artifact.updatedAt.slice(0, 10);
    const section = byDay.get(id) ?? { id, label: artifact.dayLabel, items: [] };
    section.items.push(artifact);
    byDay.set(id, section);
  }
  return [...byDay.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export interface GalleryActions {
  /** The tile itself: the owning task, at this artifact. */
  primary: SolidAction;
  /** The product's two ways straight to the file, where it has them. */
  secondary: SolidAction[];
}

/**
 * What a gallery tile offers, in the product's wording. The tile is a link to
 * the owning task at the artifact's anchor; "Open file in new tab" and
 * "Download file" exist for anything file-backed (a task document has no file,
 * a link only opens).
 */
export function galleryActions(a: LabArtifact): GalleryActions {
  const primary: SolidAction = {
    id: "document",
    label: `Open in ${a.taskIdentifier}`,
    icon: ArrowRight,
    href: isTaskDocument(a) ? `#document-${slug(a)}` : `#work-product-${a.id}`,
  };
  if (isTaskDocument(a)) return { primary, secondary: [] };
  if (a.kind === "link") {
    return { primary, secondary: [{ id: "preview", label: "Open link in new tab", icon: ExternalLink, href: a.url ?? "#", external: true }] };
  }
  return {
    primary,
    secondary: [
      { id: "preview", label: "Open file in new tab", icon: ExternalLink, href: `#file-${a.id}`, external: true },
      { id: "download", label: "Download file", icon: Download, href: `#download-${a.id}` },
    ],
  };
}
