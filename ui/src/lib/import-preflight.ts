import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

// Inline imports post the whole parsed package as one JSON body, so oversized
// packages must be blocked before the request is built. Packages past this
// limit go through the CLI folder import today; a blob-store relay is planned.
export const INLINE_IMPORT_MAX_BYTES = 56 * 1024 * 1024;

export function isBlobStoreFilePath(filePath: string): boolean {
  return /(^|\/)blobs\/[^/]+$/.test(filePath);
}

function fileEntryInlineBytes(entry: CompanyPortabilityFileEntry): number {
  return typeof entry === "string" ? entry.length : entry.data.length;
}

/** Approximate JSON request size of an inline import: text lengths plus base64 payload lengths. */
export function estimateInlineImportBytes(files: Record<string, CompanyPortabilityFileEntry>): number {
  let total = 0;
  for (const entry of Object.values(files)) {
    total += fileEntryInlineBytes(entry);
  }
  return total;
}

export function stripBlobFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
): Record<string, CompanyPortabilityFileEntry> {
  return Object.fromEntries(
    Object.entries(files).filter(([filePath]) => !isBlobStoreFilePath(filePath)),
  );
}

export interface InlineImportPreflight {
  estimatedBytes: number;
  tooLarge: boolean;
  /** Dropping blobs/** attachment payloads would bring the package under the limit. */
  canDropAttachments: boolean;
}

export function buildInlineImportPreflight(
  files: Record<string, CompanyPortabilityFileEntry>,
): InlineImportPreflight {
  const estimatedBytes = estimateInlineImportBytes(files);
  if (estimatedBytes <= INLINE_IMPORT_MAX_BYTES) {
    return { estimatedBytes, tooLarge: false, canDropAttachments: false };
  }
  const bytesWithoutBlobs = estimateInlineImportBytes(stripBlobFiles(files));
  return {
    estimatedBytes,
    tooLarge: true,
    canDropAttachments: bytesWithoutBlobs < estimatedBytes && bytesWithoutBlobs <= INLINE_IMPORT_MAX_BYTES,
  };
}

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
