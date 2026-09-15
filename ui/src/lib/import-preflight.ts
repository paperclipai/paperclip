import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

// Inline imports post the whole parsed package as one JSON body, so oversized
// packages must be blocked before the request is built. Packages past this
// limit go through the zip upload path (a far higher, operator-configurable
// server cap); a blob-store relay is planned for arbitrarily large migrations.
export const INLINE_IMPORT_MAX_BYTES = 56 * 1024 * 1024;

export function isBlobStoreFilePath(filePath: string): boolean {
  return /(^|\/)blobs\/[^/]+$/.test(filePath);
}

const utf8 = new TextEncoder();

// Fixed serialization overhead of a base64 entry object around its data and
// contentType values: {"encoding":"base64","data":"…","contentType":"…"}.
const BASE64_ENTRY_STRUCTURE_BYTES = '{"encoding":"base64","data":"","contentType":""}'.length;

// Allowance for everything in the request body besides the files map itself
// (rootPath, include flags, target, collision strategy, adapter overrides,
// braces and commas). Deliberately generous so the estimate never undercounts.
export const REQUEST_ENVELOPE_ALLOWANCE_BYTES = 256 * 1024;

// The server enforces its body limit on raw request bytes, so estimate each
// entry the way it actually travels: JSON-escaped UTF-8 for text (multi-byte
// characters and escape sequences both inflate past `String.length`), and the
// base64 payload plus its object structure for blobs (base64 and MIME types
// are ASCII, one byte per character).
function fileEntryInlineBytes(entry: CompanyPortabilityFileEntry): number {
  if (typeof entry === "string") return utf8.encode(JSON.stringify(entry)).length;
  return BASE64_ENTRY_STRUCTURE_BYTES + entry.data.length + (entry.contentType?.length ?? 0);
}

/**
 * Approximate JSON request size of an inline import: JSON-escaped UTF-8 text
 * bytes, base64 payloads with their entry structure, the serialized file-path
 * keys (thousands of paths are real bytes), and an envelope allowance for the
 * rest of the request body.
 *
 * Mirrored by `estimateInlineImportBytes` in cli/src/commands/client/company.ts
 * (the CLI cannot import from ui/) — keep the math on both sides in sync.
 */
export function estimateInlineImportBytes(files: Record<string, CompanyPortabilityFileEntry>): number {
  let total = REQUEST_ENVELOPE_ALLOWANCE_BYTES;
  for (const [filePath, entry] of Object.entries(files)) {
    // "path": entry,  → key bytes + colon + comma.
    total += utf8.encode(JSON.stringify(filePath)).length + 2 + fileEntryInlineBytes(entry);
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
