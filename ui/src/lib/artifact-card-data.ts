import { t, useTranslation } from "@/i18n";
import { formatNumber } from "./utils";

/** Cached preview failures keep their presentation in the current UI language. */
class ArtifactPreviewError extends Error {
  constructor(key: string) {
    super(t(key));
    Object.defineProperty(this, "message", { configurable: true, get: () => t(key) });
  }
}
/** Optional producer metadata must never become invented facts in an artifact card. */
export function artifactText(
  metadata: Record<string, unknown> | null,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function artifactNumber(
  metadata: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return null;
}

export function artifactUrl(value: string | null | undefined): string {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

/** Optional link thumbnails and video posters must not contact producer-chosen hosts. */
export function artifactPreviewUrl(value: string): string {
  return /^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(value)
    ? value
    : "";
}

export function artifactFileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return t("localizationIssueDetail.bytes", { size: formatNumber(bytes) });
  const options = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (bytes < 1024 * 1024) return t("localizationIssueDetail.kilobytes", { size: formatNumber(bytes / 1024, options) });
  return t("localizationIssueDetail.megabytes", { size: formatNumber(bytes / (1024 * 1024), options) });
}

export const CSV_PREVIEW_MAX_BYTES = 1024 * 1024;
const CSV_PREVIEW_MAX_ROWS = 200;
const CSV_PREVIEW_MAX_COLUMNS = 50;

/** RFC 4180 quoting, CRLF, embedded newlines, and a UTF-8 BOM; bounded for the UI. */
export function parseArtifactCsv(text: string) {
  if (new TextEncoder().encode(text).length > CSV_PREVIEW_MAX_BYTES)
    throw new ArtifactPreviewError("oct5Core.s0214");
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closedQuote = false;
  const endField = () => {
    row.push(field);
    if (row.length > CSV_PREVIEW_MAX_COLUMNS)
      throw new ArtifactPreviewError("oct5Core.s0285");
    field = "";
    closedQuote = false;
  };
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else field += char;
    } else if (char === ",") {
      endField();
    } else if (char === "\n" || char === "\r") {
      endField();
      records.push(row);
      row = [];
      if (char === "\r" && input[i + 1] === "\n") i++;
      if (records.length > CSV_PREVIEW_MAX_ROWS + 1) break;
    } else if (char === '"' && !field && !closedQuote) {
      quoted = true;
    } else {
      if (closedQuote || char === '"')
        throw new ArtifactPreviewError("oct5Core.s0286");
      field += char;
    }
  }
  if (quoted)
    throw new ArtifactPreviewError("oct5Core.s0286");
  if (field || row.length || closedQuote) {
    endField();
    records.push(row);
  }
  return {
    columns: records[0] ?? [],
    rows: records.slice(1, CSV_PREVIEW_MAX_ROWS + 1),
    truncated: records.length > CSV_PREVIEW_MAX_ROWS + 1,
  };
}

/** Only fetch authenticated attachment bytes, never a producer-supplied remote URL. */
export async function loadArtifactCsv(
  contentPath: string,
  signal?: AbortSignal,
) {
  if (!/^\/api\/attachments\/[a-zA-Z0-9-]+\/content$/.test(contentPath))
    throw new ArtifactPreviewError("oct5Core.s0215");
  const response = await fetch(contentPath, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new ArtifactPreviewError("oct5Core.s0287");
  if (Number(response.headers.get("content-length")) > CSV_PREVIEW_MAX_BYTES) {
    await response.body?.cancel();
    throw new ArtifactPreviewError("oct5Core.s0214");
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new ArtifactPreviewError("oct5Core.s0287");
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CSV_PREVIEW_MAX_BYTES) {
        await reader.cancel();
        throw new ArtifactPreviewError("oct5Core.s0214");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return parseArtifactCsv(text);
}
