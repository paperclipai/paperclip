import {
  attachmentArtifactWorkProductMetadataSchema,
  type AttachmentArtifactWorkProductMetadata,
  type IssueWorkProduct,
} from "@paperclipai/shared";

/**
 * Helpers + selectors for the issue Output surface (PAP-10162 Phase 3).
 *
 * The Output surface promotes attachment-backed artifact work products to a
 * first-class slot on the issue page so cloud users can watch / download files
 * an agent produced without digging through comments or the host filesystem.
 */

export type OutputFileTone = "video" | "pdf" | "zip" | "image" | "bin";

export interface OutputFileGlyph {
  /** Short (≤4 char) label for the file-type tile, e.g. "MP4". */
  label: string;
  tone: OutputFileTone;
}

/**
 * Format a byte count for display.
 *
 * Examples: `0 B`, `512 B`, `412 KB`, `18.4 MB`, `1.2 GB`. One decimal place is
 * used from KB upward, with a trailing `.0` trimmed so round values stay clean.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value.toFixed(1);
  const trimmed = rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
  return `${trimmed} ${units[unitIndex]}`;
}

/**
 * Format a duration in seconds as `m:ss` (under an hour) or `h:mm:ss`.
 * Examples: `0:58`, `1:42:09`.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${mins}:${pad(secs)}`;
}

/**
 * Map a MIME type to a short label + tone for the 32×32 file-type tile.
 */
export function getOutputFileGlyph(contentType: string | null | undefined): OutputFileGlyph {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("video/")) {
    const subtype = type.slice("video/".length);
    if (subtype === "quicktime") return { label: "MOV", tone: "video" };
    return { label: (subtype || "vid").toUpperCase().slice(0, 4), tone: "video" };
  }
  if (type === "application/pdf") return { label: "PDF", tone: "pdf" };
  if (type === "application/zip" || type === "application/x-zip-compressed" || type.endsWith("+zip")) {
    return { label: "ZIP", tone: "zip" };
  }
  if (type.startsWith("image/")) return { label: "IMG", tone: "image" };
  return { label: "BIN", tone: "bin" };
}

export function isVideoContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("video/");
}

export function isImageContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("image/");
}

/**
 * A single rendered output. `metadata` is null when the work product's stored
 * metadata fails validation — the row is still surfaced (degraded) so we never
 * silently drop an artifact the agent reported producing.
 */
export interface IssueOutputItem {
  id: string;
  title: string;
  status: string;
  isPrimary: boolean;
  createdAt: string | Date;
  metadata: AttachmentArtifactWorkProductMetadata | null;
  /** True when stored metadata could not be parsed into a usable artifact. */
  degraded: boolean;
  workProduct: IssueWorkProduct;
}

export interface IssueOutputs {
  items: IssueOutputItem[];
  primary: IssueOutputItem | null;
  rest: IssueOutputItem[];
  count: number;
}

function toTime(value: string | Date): number {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Parse attachment-backed artifact work products into renderable outputs.
 *
 * - Only `type: "artifact"` work products are considered outputs.
 * - Metadata is validated against the shared contract; invalid metadata yields
 *   a degraded item rather than an exception.
 * - Ordering: the explicit primary (or the most-recent artifact when none is
 *   marked primary) comes first, then remaining artifacts by most-recent.
 */
export function getIssueOutputs(workProducts: IssueWorkProduct[] | null | undefined): IssueOutputs {
  const artifacts = (workProducts ?? []).filter((wp) => wp.type === "artifact" && wp.provider === "paperclip");

  const items: IssueOutputItem[] = artifacts.map((wp) => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.safeParse(wp.metadata);
    return {
      id: wp.id,
      title: wp.title,
      status: typeof wp.status === "string" ? wp.status : "active",
      isPrimary: Boolean(wp.isPrimary),
      createdAt: wp.createdAt,
      metadata: parsed.success ? parsed.data : null,
      degraded: !parsed.success,
      workProduct: wp,
    };
  });

  items.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return toTime(b.createdAt) - toTime(a.createdAt);
  });

  return {
    items,
    primary: items[0] ?? null,
    rest: items.slice(1),
    count: items.length,
  };
}

/** Best display filename for an output, falling back to the work product title. */
export function outputFilename(item: IssueOutputItem): string {
  return item.metadata?.originalFilename || item.title || "output";
}
