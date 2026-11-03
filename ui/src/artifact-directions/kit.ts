import type { FC } from "react";

/**
 * The contract between the lab's frames and a design direction.
 *
 * A direction is one directory under `directions/` whose `index.tsx` exports
 * `kit: DirectionKit`. The frames render a kit's five slots inside static mocks
 * of the real chrome; a kit never renders chrome and never imports a frame, so
 * a direction can be rewritten wholesale without touching a shared file.
 *
 * Every slot is wrapped by the frame in `<div data-direction={kit.id}>`, so a
 * kit's `tokens.css` can scope its custom properties to
 * `[data-direction="d1-solid"]` (and `.dark [data-direction="d1-solid"]`).
 */

export type DirectionId = "today" | "d1-solid" | "d2-tint" | "d3-tactile" | "d4-hybrid" | "d5-v1-mvp";

export type LabKind =
  | "document"
  | "image"
  | "video"
  | "pdf"
  | "slides"
  | "sheet"
  | "archive"
  | "code"
  | "file"
  | "link";

/** The run that produced a work product. Task documents have none. */
export interface LabRun {
  id: string;
  agent: string;
  startedAt: string;
  /** "Sep 25, 2026, 1:20 PM" */
  startedLabel: string;
}

export interface LabArtifact {
  id: string;
  kind: LabKind;
  /** Human title, e.g. "Interface Craft revision — PDF". */
  title: string;
  filename?: string;
  ext?: string;
  contentType?: string;
  byteSize?: number | null;
  /** "57.7 KB" */
  sizeLabel?: string;
  /** "Inspected 12-page visual reference" */
  summary?: string;
  /** Plain-text preview for documents, text, code and sheets. */
  excerpt?: string;
  /**
   * Markdown source of a document, where the fixture has one. `excerpt` is the
   * same opening with the syntax stripped.
   */
  body?: string;
  /**
   * Set on task documents only ("Document · rev N"). A `document` without a
   * revision is a Markdown file an agent attached (`deck-guide.md`), which the
   * product treats as a file-backed work product, not a task document.
   */
  revision?: number;
  /** Images, video posters, slide overviews, link previews (imported asset URL). */
  thumbnailUrl?: string;
  /** Thumbnail width / height. */
  aspect?: number;
  /** A playable source for `video` (imported asset URL). */
  videoUrl?: string;
  durationLabel?: string;
  pageCount?: number;
  url?: string;
  review?: "needs_review" | "changes_requested" | null;
  commentCount?: number;
  author: string;
  /** Local ISO timestamp without a zone, so labels do not depend on the viewer's. */
  updatedAt: string;
  /** "Sep 28, 2026, 11:07 AM" */
  updatedLabel: string;
  /** "Monday, September 28" */
  dayLabel: string;
  taskIdentifier: string;
  taskTitle: string;
  run?: LabRun;
}

/** One stack on the Artifacts page. `artifacts` is everything in it, newest first. */
export interface LabGroup {
  id: string;
  taskIdentifier: string;
  title: string;
  count: number;
  /** "Sep 28, 2026" */
  updatedLabel: string;
  artifacts: LabArtifact[];
}

export interface DirectionKit {
  id: DirectionId;
  name: string;
  tagline: string;
  /** THREAD — one standalone work-product row between turns (document, file, image, …). Full width of the thread column. */
  ThreadWorkProduct: FC<{ artifact: LabArtifact }>;
  /** THREAD — the attachments block under an agent message (today: "Images · 1" thumbnails + "Files · 4" tiles). Owns its own labels and layout. */
  ThreadAttachments: FC<{ artifacts: LabArtifact[] }>;
  /** PANEL — the whole scroll body of the right panel's Artifacts tab (the pane is 434px wide; the body has 16px of padding around it). Owns sectioning, ordering and cards. */
  PanelBody: FC<{ artifacts: LabArtifact[] }>;
  /** GALLERY — the grid of task stacks below the page toolbar. */
  GalleryStacks: FC<{ groups: LabGroup[] }>;
  /** GALLERY — one opened stack: everything below the "← All stacks / ACM-3 Title" row. */
  GalleryStack: FC<{ group: LabGroup }>;
  /**
   * GALLERY — optional. A kit that redesigns the page's toolbar as well owns
   * everything under the top bar: toolbar, the opened stack's header row and
   * the grid. When present, the frame renders it instead of its own toolbar
   * plus GalleryStacks / GalleryStack (which the kinds sheet still uses).
   */
  GalleryView?: FC<{ groups: LabGroup[]; open: LabGroup | null }>;
  /**
   * THREAD — optional. When true the frame hangs ThreadAttachments under the
   * message's footer, 12px below it, instead of between the body and the
   * footer where the shipped bubble keeps them. The V1 mock (node 2096:86523)
   * places them there.
   */
  threadAttachmentsAfterFooter?: boolean;
}

/** Toolbar order: the numbered directions, then MVP V1, then the Today baseline. */
export const DIRECTION_IDS: readonly DirectionId[] = ["d1-solid", "d2-tint", "d3-tactile", "d4-hybrid", "d5-v1-mvp", "today"];

/** The digit key that selects each kit — the number in its label. */
export const KIT_KEYS: Record<DirectionId, string> = {
  "d1-solid": "1",
  "d2-tint": "2",
  "d3-tactile": "3",
  "d4-hybrid": "4",
  "d5-v1-mvp": "5",
  today: "0",
};

/** Labels for the lab's own chrome. A kit's `name`/`tagline` should say the same. */
export const KIT_META: Record<DirectionId, { name: string; tagline: string }> = {
  today: { name: "0.Today", tagline: "What ships now — outlined cards on the page fill" },
  "d1-solid": { name: "1.Solid", tagline: "Flat, filled, mostly monochrome" },
  "d2-tint": { name: "2.Tint", tagline: "Filled cards with colour used sparingly" },
  "d3-tactile": { name: "3.Tactile", tagline: "Paper, prints and folders" },
  "d4-hybrid": { name: "4.Hybrid", tagline: "Tint's containers and colour, Tactile's paper" },
  "d5-v1-mvp": { name: "5.MVP V1", tagline: "From the PCLP-Core mocks, one section at a time" },
};

/**
 * Kits load on demand, one module graph each. Directions are built in
 * parallel, and a static registry would let a half-written kit take every
 * other kit's page down with it.
 */
const KIT_LOADERS = import.meta.glob<{ kit: DirectionKit }>("./directions/*/index.tsx");

export function loadKit(id: DirectionId): Promise<DirectionKit> {
  const load = KIT_LOADERS[`./directions/${id}/index.tsx`];
  if (!load) return Promise.reject(new Error(`No kit at directions/${id}/index.tsx`));
  return load().then((module) => module.kit);
}

export const LAB_KINDS: readonly LabKind[] = [
  "document",
  "image",
  "video",
  "pdf",
  "slides",
  "sheet",
  "archive",
  "code",
  "file",
  "link",
];
