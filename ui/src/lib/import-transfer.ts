// Chunked resumable upload plan for large local .zip imports. Zips over the
// threshold are sliced into fixed byte-range parts; each part and the whole
// file are content-addressed with sha256 so the server can verify every part
// on arrival and a resumed transfer re-uploads only the parts it lost. The
// declaration's wire shape is the shared transfer contract.

import type {
  CompanyImportTransferDeclaration,
  CompanyImportTransferDeclaredPart,
} from "@paperclipai/shared/company-import-transfer";

/** Local zips larger than this take the chunked transfer path. */
export const CHUNKED_IMPORT_THRESHOLD_BYTES = 48 * 1024 * 1024;
/** Declared byte-range size of every part except the last. */
export const IMPORT_TRANSFER_PART_SIZE_BYTES = 32 * 1024 * 1024;
/** Upload attempts per part before the transfer surfaces a failure. */
export const IMPORT_TRANSFER_PART_ATTEMPTS = 3;

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash the zip and its byte-range parts. Works on the single ArrayBuffer the
 * caller reads from the File: the whole-file digest hashes the buffer itself
 * and each part digest hashes a view into it, so no second copy is ever held.
 */
export async function buildImportTransferManifest(buffer: ArrayBuffer): Promise<CompanyImportTransferDeclaration> {
  const zipSha256 = await sha256Hex(buffer);
  const parts: CompanyImportTransferDeclaredPart[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += IMPORT_TRANSFER_PART_SIZE_BYTES) {
    const byteSize = Math.min(IMPORT_TRANSFER_PART_SIZE_BYTES, buffer.byteLength - offset);
    parts.push({
      index: parts.length,
      byteSize,
      sha256: await sha256Hex(new Uint8Array(buffer, offset, byteSize)),
    });
  }
  return {
    totalBytes: buffer.byteLength,
    zipSha256,
    partSizeBytes: IMPORT_TRANSFER_PART_SIZE_BYTES,
    parts,
  };
}
