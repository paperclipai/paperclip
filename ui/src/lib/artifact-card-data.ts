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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const CSV_PREVIEW_MAX_BYTES = 1024 * 1024;
const CSV_PREVIEW_MAX_ROWS = 200;
const CSV_PREVIEW_MAX_COLUMNS = 50;

/** RFC 4180 quoting, CRLF, embedded newlines, and a UTF-8 BOM; bounded for the UI. */
export function parseArtifactCsv(text: string) {
  if (new TextEncoder().encode(text).length > CSV_PREVIEW_MAX_BYTES)
    throw new Error(
      "CSV is too large to preview. Download the file to view it.",
    );
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closedQuote = false;
  const endField = () => {
    row.push(field);
    if (row.length > CSV_PREVIEW_MAX_COLUMNS)
      throw new Error(
        "CSV has too many columns to preview. Download the file to view it.",
      );
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
        throw new Error(
          "CSV could not be previewed. Download the file to view it.",
        );
      field += char;
    }
  }
  if (quoted)
    throw new Error(
      "CSV could not be previewed. Download the file to view it.",
    );
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
    throw new Error(
      "CSV preview is unavailable. Download the file to view it.",
    );
  const response = await fetch(contentPath, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error("CSV could not be loaded. Try again or download the file.");
  if (Number(response.headers.get("content-length")) > CSV_PREVIEW_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(
      "CSV is too large to preview. Download the file to view it.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("CSV could not be loaded. Try again or download the file.");
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
        throw new Error(
          "CSV is too large to preview. Download the file to view it.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return parseArtifactCsv(text);
}
