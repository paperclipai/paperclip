import { fileKindForName } from "@/components/task-chat/task-chat-attachments";
import type { LabArtifact } from "../../kit";

/**
 * What an artifact is called and what one does with it — the wording every
 * surface of this direction shares. Labels come from the product's own
 * extension mapper wherever it has one (PDF, Markdown, ZIP, Sheet, HTML, File).
 */

/** The colour family of an object's extension tab. */
export type TabTone = "pdf" | "slides" | "sheet" | "code" | "note";

/** One part of a meta line; `mono` marks a machine value, `lead` / `unit` are the words around it ("rev", "pages"). */
export interface MetaPart {
  text: string;
  mono?: boolean;
  lead?: string;
  unit?: string;
}

export type ActionIcon = "open" | "gallery" | "download" | "external";

export interface ArtifactAction {
  /** Visible label, production wording. */
  label: string;
  icon: ActionIcon;
  /** Where an anchor would go; buttons (gallery) have none. */
  href?: string;
}

/** A task document, as opposed to a Markdown file an agent attached. */
export const isTaskDocument = (a: LabArtifact) => a.kind === "document" && a.revision != null;

const TEXT_LIKE = new Set(["md", "txt", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "tsx", "sql", "log"]);
export const isTextLike = (a: LabArtifact) => !isTaskDocument(a) && TEXT_LIKE.has((a.ext ?? "").toLowerCase());

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** "Document", "Image", "PDF", "Markdown", "Slides", "Sheet", "ZIP", "HTML", "File", "Link". */
export function kindLabel(a: LabArtifact): string {
  if (isTaskDocument(a)) return "Document";
  switch (a.kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "link":
      return "Link";
    case "slides":
      // The product's mapper has no entry for .pptx and says "File"; the object is a slide, so the word is too.
      return "Slides";
    default:
      return fileKindForName(a.filename ?? "").label;
  }
}

/** The extension as it is printed on an object's tab: "PDF", "PPTX", "MD". */
export function tabLabel(a: LabArtifact): string | null {
  if (isTaskDocument(a) || a.kind === "image" || a.kind === "video" || a.kind === "link") return null;
  const ext = (a.ext ?? "").toUpperCase();
  return ext ? ext.slice(0, 4) : null;
}

export function tabTone(a: LabArtifact): TabTone {
  switch (a.kind) {
    case "pdf":
      return "pdf";
    case "slides":
      return "slides";
    case "sheet":
      return "sheet";
    case "code":
      return "code";
    default:
      return "note";
  }
}

/** The second line of a row or caption: kind, then the machine values. */
export function metaParts(a: LabArtifact): MetaPart[] {
  const parts: MetaPart[] = [{ text: kindLabel(a) }];
  if (isTaskDocument(a)) {
    parts.push({ lead: "rev", text: String(a.revision), mono: true });
    return parts;
  }
  if (a.kind === "link") {
    parts.push({ text: hostOf(a.url), mono: true });
    return parts;
  }
  if (a.sizeLabel) parts.push({ text: a.sizeLabel, mono: true });
  if (a.kind === "video" && a.durationLabel) parts.push({ text: a.durationLabel, mono: true });
  if (a.pageCount && a.pageCount > 1) parts.push({ text: String(a.pageCount), mono: true, unit: a.kind === "slides" ? "slides" : "pages" });
  return parts;
}

const anchor = (a: LabArtifact) => (isTaskDocument(a) ? `#document-${(a.filename ?? a.id).replace(/\.md$/, "")}` : `#work-product-${a.id}`);

/** GALLERY — where an artifact's tile goes: the owning task, at the artifact (ArtifactCard.tsx:203). */
export const taskHref = anchor;

/**
 * GALLERY — the two quiet targets beside a tile's caption (ArtifactCard.tsx:188-229). Task documents have neither
 * path in the product; a link opens itself.
 */
export function galleryActions(a: LabArtifact): ArtifactAction[] {
  if (isTaskDocument(a)) return [];
  if (a.kind === "link") return [{ label: "Open link in new tab", icon: "external", href: anchor(a) }];
  return [
    { label: "Open file in new tab", icon: "external", href: anchor(a) },
    { label: "Download file", icon: "download", href: anchor(a) },
  ];
}

/** THREAD — the one thing to do with it (RichWorkProductCard.tsx:148-191). */
export function primaryAction(a: LabArtifact): ArtifactAction {
  if (isTaskDocument(a)) return { label: "Open document", icon: "open", href: anchor(a) };
  if (a.kind === "image" || a.kind === "video") return { label: "Open gallery", icon: "gallery" };
  if (a.kind === "link") return { label: "Open preview", icon: "external", href: anchor(a) };
  if (isTextLike(a)) return { label: "Open in tab", icon: "open", href: anchor(a) };
  return { label: "Download", icon: "download", href: anchor(a) };
}

/** THREAD — text-like files open in the side panel and keep Download as its own target. */
export function secondaryAction(a: LabArtifact): ArtifactAction | null {
  return isTextLike(a) ? { label: "Download", icon: "download", href: anchor(a) } : null;
}

/** PANEL — the wording of the pane's buttons (RichArtifactCards.tsx). */
export function panelActions(a: LabArtifact): ArtifactAction[] {
  if (a.kind === "document") return [{ label: "Read document", icon: "open", href: anchor(a) }];
  if (a.kind === "image") return [{ label: "View image", icon: "gallery" }];
  if (a.kind === "video") return [{ label: "Open video", icon: "gallery" }];
  if (a.kind === "link") return [{ label: "Open link", icon: "external", href: anchor(a) }];
  return [
    { label: "Open file", icon: "external", href: anchor(a) },
    { label: "Download file", icon: "download", href: anchor(a) },
  ];
}

/**
 * PANEL — the quieter targets beside the buttons, icon only (IssuePropertiesArtifactsTab.tsx:237-265):
 * a Markdown file keeps Open in tab, Open raw and Download; any other text-like file keeps Open in tab.
 */
export function panelIconActions(a: LabArtifact): ArtifactAction[] {
  if (isTaskDocument(a) || !isTextLike(a)) return [];
  const inTab: ArtifactAction = { label: "Open in tab", icon: "open", href: anchor(a) };
  if (a.kind !== "document") return [inTab];
  return [inTab, { label: "Open raw", icon: "external", href: anchor(a) }, { label: "Download", icon: "download", href: anchor(a) }];
}

/**
 * What a caption calls the thing when it has to be one machine string: the filename, a link's host, else the title.
 * A task document is not a file — its name is its key, without the `.md` the store appends — so an extension always
 * means a file, on the caption as on the object's tab.
 */
export function splitName(a: LabArtifact): [base: string, ext: string] {
  const name = a.filename ?? (a.kind === "link" ? hostOf(a.url) : a.title);
  const dot = name.lastIndexOf(".");
  if (!a.filename || dot <= 0) return [name, ""];
  return [name.slice(0, dot), isTaskDocument(a) ? "" : name.slice(dot)];
}

/**
 * Focus: a strong ring (`--tac-ring`, 72% of the foreground) with a 2px gap; add `RING_ON.*` for the gap's colour —
 * that of whatever the control lies on. On a pseudo-element hit area use `RING_AFTER`.
 */
export const RING = "outline-none focus-visible:ring-2 focus-visible:ring-(--tac-ring) focus-visible:ring-offset-2";
export const RING_AFTER = "outline-none focus-visible:after:ring-2 focus-visible:after:ring-(--tac-ring) focus-visible:after:ring-offset-2";
export const RING_ON = {
  canvas: "focus-visible:ring-offset-background",
  ground: "focus-visible:ring-offset-(--tac-ground)",
  desk: "focus-visible:ring-offset-(--tac-desk)",
} as const;

export const REVIEW_LABEL = { needs_review: "Review", changes_requested: "Changes requested" } as const;
export const REVIEW_VAR = {
  needs_review: "var(--status-task-in_review)",
  changes_requested: "var(--status-task-blocked)",
} as const;

/** A stable 0-3 from an id, for the angle an object lies at. */
export function reposeOf(id: string): 0 | 1 | 2 | 3 {
  let h = 0;
  for (const char of id) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return (h % 4) as 0 | 1 | 2 | 3;
}

/** A plain-text excerpt as title + blocks; a block is a heading, a bullet or a paragraph. */
export interface ExcerptBlock {
  type: "heading" | "bullet" | "para";
  text: string;
}

/** The first running text of a document after its title, as one string: the panel's two-line excerpt in the UI face. */
export function excerptLead(a: LabArtifact): string {
  const { blocks } = excerptBlocks(a);
  return blocks
    .filter((block) => block.type !== "heading")
    .slice(0, 3)
    .map((block) => block.text)
    .join(" ");
}

export function excerptBlocks(a: LabArtifact): { title: string; blocks: ExcerptBlock[] } {
  const chunks = (a.excerpt ?? "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (chunks.length === 0) return { title: a.title, blocks: [] };
  const [title, ...rest] = chunks;
  const blocks = rest.slice(0, 14).map<ExcerptBlock>((text) => {
    if (text.startsWith("• ")) return { type: "bullet", text: text.slice(2) };
    if (text.length < 44 && !/[.:;,]$/.test(text)) return { type: "heading", text };
    return { type: "para", text };
  });
  return { title, blocks };
}
