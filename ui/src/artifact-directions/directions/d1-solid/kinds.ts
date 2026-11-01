import { Archive, CodeXml, File, FilePenLine, FileText, Film, Globe, Image, NotebookText, Presentation, Table2, type LucideIcon } from "lucide-react";
import { fileKindForName } from "@/components/task-chat/task-chat-attachments";
import type { LabArtifact, LabKind } from "../../kit";

/**
 * The Solid vocabulary: for each of the ten kinds, the glyph that goes in the
 * kind block, the mono-caps label under it, and the wording of the meta line.
 * Every surface reads kinds from here so a PDF is the same PDF in the thread,
 * the panel and the gallery.
 *
 * Glyphs are chosen to differ in shape at 20px, not only in their letters: a
 * notebook (task document — kept and revised in the task), a page with a pen
 * (Markdown — a source you edit), a lined page (PDF — the finished page), an
 * easel, a grid, a box, brackets, a blank page, a globe, a framed picture, a
 * film strip.
 */

interface KindSpec {
  glyph: LucideIcon;
  /** Kind-block label when the artifact has no extension to show. */
  block: string;
  /** Meta-line label when the product's extension mapper only says "File". */
  meta: string;
}

export const KINDS: Record<LabKind, KindSpec> = {
  document: { glyph: FilePenLine, block: "MD", meta: "Markdown" },
  image: { glyph: Image, block: "IMG", meta: "Image" },
  video: { glyph: Film, block: "VID", meta: "Video" },
  pdf: { glyph: FileText, block: "PDF", meta: "PDF" },
  slides: { glyph: Presentation, block: "PPT", meta: "Slides" },
  sheet: { glyph: Table2, block: "XLS", meta: "Sheet" },
  archive: { glyph: Archive, block: "ZIP", meta: "Archive" },
  code: { glyph: CodeXml, block: "CODE", meta: "Code" },
  file: { glyph: File, block: "FILE", meta: "File" },
  link: { glyph: Globe, block: "URL", meta: "Link" },
};

/** A task document ("Document · rev N"), as opposed to a Markdown file an agent attached. */
export const isTaskDocument = (a: LabArtifact) => a.kind === "document" && a.revision != null;

/** A task document is a notebook: it is kept and revised in the task, not a file on disk. */
export const kindGlyph = (a: LabArtifact): LucideIcon => (isTaskDocument(a) ? NotebookText : KINDS[a.kind].glyph);

/**
 * The mono-caps label in the kind block. A file is labelled by its extension
 * (PDF, PPTX, MD, PNG, ZIP, CSV, WEBM); a task document has none, and is
 * labelled by what tells one from the next — its revision (REV 3).
 */
export function blockLabel(a: LabArtifact): string {
  if (a.kind === "link") return KINDS.link.block;
  if (isTaskDocument(a)) return `REV ${a.revision}`;
  const ext = a.ext?.replace(/[^a-z0-9]/gi, "");
  return ext ? ext.slice(0, 4).toUpperCase() : KINDS[a.kind].block;
}

/** The first word of the meta line, in production wording where production has one. */
export function metaLabel(a: LabArtifact): string {
  if (isTaskDocument(a)) return "Document";
  if (a.kind === "link") return KINDS.link.meta;
  if (a.kind === "image" || a.kind === "video") return KINDS[a.kind].meta;
  const shipped = a.filename ? fileKindForName(a.filename).label : "File";
  return shipped === "File" ? KINDS[a.kind].meta : shipped;
}

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The key a document or file is addressed by in the lab's inert hashes. */
export const slug = (a: LabArtifact) => (a.filename ?? a.id).replace(/\.md$/, "");

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** How much of it there is: pages, slides, a duration, or where a link points. */
export function extent(a: LabArtifact): string | null {
  if (a.kind === "video") return a.durationLabel ?? null;
  if (a.kind === "link") return host(a.url);
  if (!a.pageCount) return null;
  return plural(a.pageCount, a.kind === "slides" ? "slide" : "page");
}

/**
 * The meta line's parts, in one grammar everywhere: kind · size · rev · extent
 * (pages, slides, duration or host). A surface may take a prefix of this list
 * when it is short of room, never reorder it.
 */
export function metaParts(a: LabArtifact): string[] {
  return [metaLabel(a), a.sizeLabel, a.revision != null ? `rev ${a.revision}` : null, extent(a)].filter((part): part is string => Boolean(part));
}

/** What the product can open in the side panel instead of downloading (`isTextAttachment`). */
export function isTextLike(a: LabArtifact): boolean {
  if (a.kind === "link" || isTaskDocument(a)) return false;
  const type = a.contentType ?? "";
  return type.startsWith("text/") || type === "application/json" || /\.(md|txt|log|csv|json|ya?ml|html|css)$/i.test(a.filename ?? "");
}

/** Whether the artifact has a picture to put where the kind block would go. */
export const hasThumbnail = (a: LabArtifact) => Boolean(a.thumbnailUrl);

/** The name a file is listed under when the surface shows files rather than titles. A link has no file, so it keeps its title. */
export const fileName = (a: LabArtifact) => a.filename ?? a.title;

/** Whether anything waits on the reader: the artifact's primary action is then ink at rest. */
export const isWaiting = (a: LabArtifact) => a.review === "needs_review";
