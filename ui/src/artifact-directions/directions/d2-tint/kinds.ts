import { fileKindForName } from "@/components/task-chat/task-chat-attachments";
import type { LabArtifact, LabKind } from "../../kit";

/**
 * The words of the set. One place decides what a kind is called and what its
 * glyph says, so the three surfaces cannot drift (the actions are in
 * actions.ts). Labels reuse the product's own mapper (`fileKindForName`)
 * wherever it has an answer: PDF, Markdown, ZIP, Sheet, CSV, HTML, File.
 */

/** A task document ("Document · rev N"), as opposed to a Markdown file an agent attached. */
export const isTaskDocument = (a: LabArtifact) => a.kind === "document" && a.revision != null;

/** A Markdown file an agent attached: a `document` the product reviews inline, with comments. */
export const isMarkdownFile = (a: LabArtifact) => a.kind === "document" && a.revision == null;

const GLYPH_FALLBACK: Record<LabKind, string> = {
  document: "MD",
  image: "IMG",
  video: "VID",
  pdf: "PDF",
  slides: "PPT",
  sheet: "XLS",
  archive: "ZIP",
  code: "CODE",
  file: "FILE",
  link: "URL",
};

/**
 * The bold word on the glyph and on a preview's tab: always the real
 * extension, four characters at most (URL for a link). A task document has
 * none — it is the product's own document, not a file — so its glyph carries
 * the pictogram alone, larger, and "Document · rev N" stays on the meta line.
 */
export function glyphLabel(a: LabArtifact): string | undefined {
  if (isTaskDocument(a)) return undefined;
  if (a.kind === "link") return "URL";
  const ext = a.ext ?? a.filename?.split(".").pop();
  return ext && ext.length <= 4 ? ext.toUpperCase() : GLYPH_FALLBACK[a.kind];
}

/** What a kind is called when the filename cannot say (no filename, or an extension the product does not know). */
const KIND_NOUN: Partial<Record<LabKind, string>> = {
  document: "Markdown",
  pdf: "PDF",
  // The product has no entry for .pptx and calls it "File"; the kind is known here.
  slides: "Slides",
  sheet: "Sheet",
  archive: "Archive",
  code: "Code",
};

/** The first word of the meta line, in the product's wording. */
export function kindLabel(a: LabArtifact): string {
  if (isTaskDocument(a)) return "Document";
  if (a.kind === "image") return "Image";
  if (a.kind === "video") return "Video";
  if (a.kind === "link") return "Link preview";
  if (a.kind === "slides") return "Slides";
  const byName = a.filename ? fileKindForName(a.filename).label : "File";
  return byName === "File" ? (KIND_NOUN[a.kind] ?? "File") : byName;
}

/** A link's address without the scheme: "preview.acmehats.example/storefront". */
export function linkLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Data rows and columns of a delimited excerpt (the header is not a row). */
function sheetShape(a: LabArtifact): { rows: number; columns: number } | undefined {
  if (a.kind !== "sheet" || !a.excerpt) return undefined;
  const lines = a.excerpt.trim().split("\n");
  return { rows: Math.max(0, lines.length - 1), columns: lines[0].split(",").length };
}

/** "12 pages", "12 slides", "0:06", "4 rows" — the countable fact a kind has, if any. */
function kindFact(a: LabArtifact): string | undefined {
  if (a.kind === "video") return a.durationLabel;
  const shape = sheetShape(a);
  if (shape) return plural(shape.rows, "row");
  if (a.pageCount == null) return undefined;
  return plural(a.pageCount, a.kind === "slides" ? "slide" : "page");
}

/** The one fact a preview with nothing to show can lead with: the count, or failing that the size. */
export const headlineFact = (a: LabArtifact) => kindFact(a) ?? a.sizeLabel;

interface MetaOptions {
  /** Append the countable fact — and a sheet's columns, as the product's card does. Panel and gallery have room for it. */
  facts?: boolean;
  /** A part already shown right beside the line (a duration chip, a well's headline), so it is not said twice. */
  omit?: string;
  /** A link's address is set by the caller where it has to truncate on its own. */
  address?: boolean;
}

/** The mono meta line, one grammar everywhere: kind · size · rev (· fact). */
export function metaParts(a: LabArtifact, { facts = false, omit, address = true }: MetaOptions = {}): string[] {
  const parts = [kindLabel(a)];
  if (a.kind === "link") {
    const link = address ? linkLabel(a.url) : undefined;
    if (link) parts.push(link);
  } else if (a.sizeLabel) {
    parts.push(a.sizeLabel);
  }
  if (a.revision != null) parts.push(`rev ${a.revision}`);
  const fact = facts || a.kind === "video" ? kindFact(a) : undefined;
  if (fact) parts.push(fact);
  const shape = facts ? sheetShape(a) : undefined;
  if (shape) parts.push(plural(shape.columns, "column"));
  return omit ? parts.filter((part) => part !== omit) : parts;
}

/** Files the product opens in the side panel on a plain click (lib/issue-attachments.ts `isTextAttachment`). */
export function isTextLike(a: LabArtifact): boolean {
  if (isTaskDocument(a) || a.kind === "link") return false;
  const type = (a.contentType ?? "").toLowerCase();
  if (type.startsWith("text/") || /^application\/(json|xml|javascript|x-yaml|yaml)$/.test(type)) return true;
  return /\.(md|markdown|txt|log|csv|json|ya?ml|toml|ini|sh|tsx?|jsx?|py|css|html)$/i.test(a.filename ?? "");
}

/** Kinds whose preview is their own text: a document's opening, a sheet's rows, a file's code. */
export function hasTextPreview(a: LabArtifact): boolean {
  if (a.kind === "document") return Boolean(a.body ?? a.excerpt);
  if (a.kind === "sheet" || a.kind === "code") return Boolean(a.excerpt);
  return false;
}

/** The timestamp of the current year reads without its year; an older one keeps it. `label` is "Sep 28, 2026, 11:07 AM". */
export function shortDateTime(label: string, iso: string): string {
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? label.replace(/, \d{4}(?=,)/, "") : label;
}

/** "Sep 28, 2026, 11:07 AM" → "11:07 AM". */
export const timeOnly = (label: string) => label.split(", ").pop() ?? label;
