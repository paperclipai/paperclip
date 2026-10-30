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

// `crypto.subtle` is only defined in a secure context (HTTPS or http://localhost).
// A Paperclip instance served over plain HTTP on a LAN or tailnet address has
// `crypto.subtle === undefined`, and reading `.digest` on it throws the opaque
// "Cannot read properties of undefined (reading 'digest')" TypeError. Replace
// that with a clear message that names the real cause and the two paths out.
const INSECURE_CONTEXT_HINT =
  "Large zip imports need the browser SubtleCrypto API, which is only available on HTTPS or http://localhost. "
  + "Serve Paperclip over HTTPS, or re-export the company without large attachments so the package fits the inline path.";

function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error(INSECURE_CONTEXT_HINT);
  return subtle;
}

async function sha256Hex(bytes: BufferSource, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash the zip and its byte-range parts. Works on the single ArrayBuffer the
 * caller reads from the File: the whole-file digest hashes the buffer itself
 * and each part digest hashes a view into it, so no second copy is ever held.
 */
export async function buildImportTransferManifest(buffer: ArrayBuffer): Promise<CompanyImportTransferDeclaration> {
  const subtle = requireSubtleCrypto();
  const zipSha256 = await sha256Hex(buffer, subtle);
  const parts: CompanyImportTransferDeclaredPart[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += IMPORT_TRANSFER_PART_SIZE_BYTES) {
    const byteSize = Math.min(IMPORT_TRANSFER_PART_SIZE_BYTES, buffer.byteLength - offset);
    parts.push({
      index: parts.length,
      byteSize,
      sha256: await sha256Hex(new Uint8Array(buffer, offset, byteSize), subtle),
    });
  }
  return {
    totalBytes: buffer.byteLength,
    zipSha256,
    partSizeBytes: IMPORT_TRANSFER_PART_SIZE_BYTES,
    parts,
  };
}
