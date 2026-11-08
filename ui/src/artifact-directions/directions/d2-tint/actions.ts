import type { LabArtifact } from "../../kit";
import { isMarkdownFile, isTaskDocument, isTextLike } from "./kinds";

/**
 * What you can do with an artifact on each surface, in the product's wording.
 * A unit has one primary action (its whole slab) and, where the product has
 * them, secondary ones as separate targets.
 */

export type ActionIntent = "document" | "gallery" | "preview" | "tab" | "download" | "comments" | "raw" | "data" | "play" | "task" | "stack";

export interface UnitAction {
  intent: ActionIntent;
  /** Visible label, production wording. */
  label: string;
  /** Accessible name: "Download: <title>". */
  name: string;
  href: string;
}

const anchor = (prefix: string, a: LabArtifact) => `#${prefix}-${a.id}`;

/** THREAD — the one thing you do with it, reachable from anywhere on the row. */
export function threadAction(a: LabArtifact): UnitAction {
  if (isTaskDocument(a)) return { intent: "document", label: "Open document", name: `Open document: ${a.title}`, href: anchor("document", a) };
  if (a.kind === "image" || a.kind === "video") return { intent: "gallery", label: "Open gallery", name: `Open gallery: ${a.title}`, href: anchor("gallery", a) };
  if (a.kind === "link") return { intent: "preview", label: "Open preview", name: `Open preview: ${a.title}`, href: a.url ?? anchor("preview", a) };
  if (isTextLike(a)) return { intent: "tab", label: "Open in tab", name: `Open in tab: ${a.title}`, href: anchor("file", a) };
  return downloadAction(a);
}

export function downloadAction(a: LabArtifact): UnitAction {
  return { intent: "download", label: "Download", name: `Download: ${a.title}`, href: anchor("download", a) };
}

/** PANEL — the product's button wording there: Read document, View image, Open video, Open link, Open file. */
export function panelAction(a: LabArtifact): UnitAction {
  if (a.kind === "document") return { intent: "document", label: "Read document", name: `Read document: ${a.title}`, href: anchor("document", a) };
  if (a.kind === "image") return { intent: "gallery", label: "View image", name: `View image: ${a.title}`, href: anchor("gallery", a) };
  if (a.kind === "video") return { intent: "gallery", label: "Open video", name: `Open video: ${a.title}`, href: anchor("gallery", a) };
  if (a.kind === "link") return { intent: "preview", label: "Open link", name: `Open link: ${a.title}`, href: a.url ?? anchor("preview", a) };
  // "Open file" leaves the app for a new browser tab, as the shipped button does.
  return { intent: "preview", label: "Open file", name: `Open file: ${a.title}`, href: anchor("file", a) };
}

/** PANEL — the second button on file cards. */
function panelDownload(a: LabArtifact): UnitAction {
  return { intent: "download", label: "Download file", name: `Download file: ${a.title}`, href: anchor("download", a) };
}

/**
 * PANEL — everything else a card offers today, as icon targets beside the
 * primary: the comments chip, Open in tab and Open raw on a Markdown file;
 * View data on a sheet; Open in tab on any text-like file; Download file on
 * every file. Task documents, images, videos and links have none.
 */
export function panelSecondary(a: LabArtifact): UnitAction[] {
  if (isTaskDocument(a) || a.kind === "image" || a.kind === "video" || a.kind === "link") return [];
  const actions: UnitAction[] = [];
  if (isMarkdownFile(a) && a.commentCount != null) {
    const n = a.commentCount;
    actions.push({ intent: "comments", label: `${n} comment${n === 1 ? "" : "s"}`, name: `${n} comment${n === 1 ? "" : "s"}: ${a.title}`, href: anchor("comments", a) });
  }
  if (a.kind === "sheet" && a.excerpt) actions.push({ intent: "data", label: "View data", name: `View data: ${a.title}`, href: anchor("data", a) });
  if (isTextLike(a)) actions.push({ intent: "tab", label: "Open in tab", name: `Open in tab: ${a.title}`, href: anchor("file", a) });
  if (isMarkdownFile(a)) actions.push({ intent: "raw", label: "Open raw", name: `Open raw: ${a.title}`, href: anchor("raw", a) });
  actions.push(panelDownload(a));
  return actions;
}

/**
 * GALLERY — a tile is a link to the artifact where it lives: the owning task,
 * at the artifact's anchor (today's whole-card link).
 */
export function galleryAction(a: LabArtifact): UnitAction {
  return { intent: "task", label: `Open in ${a.taskIdentifier}`, name: `Open in ${a.taskIdentifier}: ${a.title}`, href: `#${a.taskIdentifier}-${a.id}` };
}

/**
 * GALLERY — the two icon targets a tile has today, in the product's wording:
 * "Open file in new tab" and "Download file" for anything file-backed. A link
 * opens its address; a task document has neither (it has no file).
 */
export function gallerySecondary(a: LabArtifact): UnitAction[] {
  if (isTaskDocument(a)) return [];
  if (a.kind === "link") return [{ intent: "preview", label: "Open link in new tab", name: `Open link in new tab: ${a.title}`, href: a.url ?? anchor("preview", a) }];
  return [
    { intent: "preview", label: "Open file in new tab", name: `Open file in new tab: ${a.title}`, href: anchor("file", a) },
    panelDownload(a),
  ];
}

/** GALLERY — a folder, or a stack of one, opens its stack. */
export function stackAction(group: { taskIdentifier: string; title: string; count: number }): UnitAction {
  const count = `${group.count} ${group.count === 1 ? "artifact" : "artifacts"}`;
  return { intent: "stack", label: "Open stack", name: `Open stack ${group.taskIdentifier}: ${group.title}, ${count}`, href: `#stack-${group.taskIdentifier}` };
}
