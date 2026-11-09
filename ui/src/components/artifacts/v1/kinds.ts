import { Archive, CodeXml, File, FileText, Film, Globe, Image, Music, Presentation, Table2, type LucideIcon } from "lucide-react";
import type { CompanyArtifact } from "@paperclipai/shared";

/**
 * What the V1 artwork knows about an artifact. Each surface adapts its own
 * payload (company artifacts, work products, documents, attachments) into
 * this; the artwork never reads an API type directly.
 */
export type ArtifactKind = "document" | "pdf" | "slides" | "sheet" | "archive" | "code" | "file" | "link" | "image" | "video";

export interface ArtifactSubject {
  kind: ArtifactKind;
  title: string;
  filename?: string | null;
  ext?: string | null;
  contentType?: string | null;
  /** A picture, a video poster or a link preview. */
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  /** Width / height when known; otherwise read from the loaded picture. */
  aspect?: number | null;
  /** Whether a document's text is known (a preview sheet can be set from it). */
  hasText?: boolean;
  /** A versioned task document, as opposed to an attached Markdown file. */
  isTaskDocument?: boolean;
  sizeLabel?: string | null;
  /** ISO timestamp; a thread attachment has none of its own. */
  updatedAt?: string | null;
  taskIdentifier?: string | null;
}

/**
 * Which of the mock's four treatments an artifact gets.
 *
 *  preview         a text file whose text is known: the white sheet with the
 *                  title set on it
 *  icon            any other file or document: the white sheet with a faint
 *                  centred glyph and the type in caps
 *  media           an image or video with a preview: the print with a white border
 *  media-fallback  media with nothing to show (audio, a video without a poster):
 *                  the sheet with the media glyph and a play button
 */
export type Treatment = "preview" | "icon" | "media" | "media-fallback";

const AUDIO = /^(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i;

export const extOf = (subject: Pick<ArtifactSubject, "ext" | "filename">): string | undefined =>
  (subject.ext ?? subject.filename?.match(/\.([a-z0-9]+)$/i)?.[1])?.toLowerCase();

export const isAudio = (subject: ArtifactSubject) => subject.kind === "file" && AUDIO.test(extOf(subject) ?? "");

export const isMedia = (subject: ArtifactSubject) => subject.kind === "image" || subject.kind === "video" || isAudio(subject);

/** A picture to print: the thumbnail, or for video its own stream (a poster is optional). */
export const previewSourceOf = (subject: ArtifactSubject): string | null =>
  subject.thumbnailUrl ?? (subject.kind === "video" ? subject.videoUrl ?? null : null);

export function treatmentOf(subject: ArtifactSubject): Treatment {
  if (subject.kind === "image" || subject.kind === "video") return previewSourceOf(subject) ? "media" : "media-fallback";
  if (isAudio(subject)) return "media-fallback";
  if (subject.kind === "document" && subject.hasText) return "preview";
  return "icon";
}

/** Portrait prints stand; everything else lies. A square counts as landscape. */
export const isPortrait = (aspect: number | null | undefined) => (aspect ?? 1) < 1;

const FALLBACK_LABEL: Record<ArtifactKind, string> = {
  document: "MD",
  pdf: "PDF",
  slides: "PPTX",
  sheet: "CSV",
  archive: "ZIP",
  code: "CODE",
  file: "FILE",
  link: "URL",
  image: "IMG",
  video: "VIDEO",
};

/** The type in caps, from the real extension when there is one. */
export function labelOf(subject: ArtifactSubject): string {
  if (subject.kind === "link") return "URL";
  return (extOf(subject) ?? FALLBACK_LABEL[subject.kind]).toUpperCase();
}

/** The glyph: the mock draws PDF with three bars; every other type takes its lucide icon. */
export type Glyph = "bars" | LucideIcon;

const ICON: Record<ArtifactKind, Glyph> = {
  pdf: "bars",
  document: FileText,
  slides: Presentation,
  sheet: Table2,
  archive: Archive,
  code: CodeXml,
  file: File,
  link: Globe,
  image: Image,
  video: Film,
};

export function glyphOf(subject: ArtifactSubject): Glyph {
  if (isAudio(subject)) return Music;
  return ICON[subject.kind];
}

/** The product's media kinds, which the Artifacts page's filter tabs are named after. */
export type MediaKind = "image" | "video" | "document" | "text" | "file";

const TEXT_TYPES = new Set(["application/json", "application/xml", "application/markdown"]);

/**
 * The server's rule (server/src/services/company-artifacts.ts,
 * `classifyMediaKind`): a task document is a Document; every file goes by its
 * content type — images and video by theirs, text, JSON, XML and Markdown are
 * Text, anything else is a File.
 */
export function mediaKindOf(subject: ArtifactSubject): MediaKind {
  if (subject.kind === "document" && subject.isTaskDocument) return "document";
  const type = (subject.contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) return "text";
  if (!type && (subject.kind === "image" || subject.kind === "video")) return subject.kind;
  return "file";
}

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: "document", markdown: "document", txt: "document",
  pdf: "pdf",
  ppt: "slides", pptx: "slides", key: "slides",
  csv: "sheet", tsv: "sheet", xls: "sheet", xlsx: "sheet", numbers: "sheet",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", "7z": "archive", rar: "archive",
  html: "code", htm: "code", css: "code", js: "code", ts: "code", tsx: "code", jsx: "code", json: "code", xml: "code", yml: "code", yaml: "code", py: "code", rb: "code", go: "code", rs: "code", sh: "code", sql: "code",
};

/** The artwork kind for a file, from its extension first and its content type second. */
export function kindFor(ext: string | undefined, contentType: string | null | undefined, mediaKind?: CompanyArtifact["mediaKind"]): ArtifactKind {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/") || mediaKind === "image") return "image";
  if (type.startsWith("video/") || mediaKind === "video") return "video";
  if (ext && KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) return "code";
  return "file";
}

const filenameOf = (artifact: CompanyArtifact): string | null => {
  const path = artifact.contentPath ?? artifact.downloadPath ?? artifact.openPath;
  const last = path?.split("?")[0].split("/").pop();
  return last && /\.[a-z0-9]+$/i.test(last) ? decodeURIComponent(last) : null;
};

/** A company artifact (the Artifacts page) as the artwork sees it. */
export function subjectFromCompanyArtifact(artifact: CompanyArtifact): ArtifactSubject {
  const isTaskDocument = artifact.source === "document";
  const filename = isTaskDocument ? null : filenameOf(artifact) ?? (/\.[a-z0-9]+$/i.test(artifact.title) ? artifact.title : null);
  const ext = extOf({ filename });
  const kind: ArtifactKind = isTaskDocument ? "document" : kindFor(ext, artifact.contentType, artifact.mediaKind);
  return {
    kind,
    title: artifact.title,
    filename,
    ext,
    contentType: artifact.contentType,
    // A video has no poster of its own in this payload; the print plays its stream instead.
    thumbnailUrl: kind === "image" ? artifact.contentPath : null,
    videoUrl: kind === "video" ? artifact.contentPath : null,
    hasText: Boolean(artifact.previewText?.trim()),
    isTaskDocument,
    updatedAt: artifact.updatedAt,
    taskIdentifier: artifact.issue.identifier,
  };
}
