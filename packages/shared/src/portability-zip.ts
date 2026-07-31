import { inflateRawSync } from "node:zlib";
import path from "node:path";
import type { CompanyPortabilityFileEntry } from "./types/company-portability.js";

// Node-side reader for the company portability zip package. It produces the
// exact `{ rootPath, files }` shape the inline import source carries, so the
// server can accept a raw uploaded zip and feed the importer the same bundle
// the browser used to expand and post as inline JSON. The browser has its own
// reader in `ui/src/lib/zip.ts` (DecompressionStream); this one uses node zlib.
// Both must stay byte-compatible with the writer in `ui/src/lib/zip.ts`.

const textDecoder = new TextDecoder();
// ignoreBOM keeps a leading BOM in the decoded text so text entries
// re-encode to their original bytes; fatal surfaces invalid UTF-8.
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Decompression-bomb guards. The compressed upload is already capped upstream
// (multer/express.raw at PORTABLE_ZIP_UPLOAD_LIMIT_BYTES), but DEFLATE lets a
// small compressed archive expand to gigabytes. Bound the expansion so a
// malicious highly-compressible package cannot exhaust server memory: a
// per-entry ceiling (passed to zlib as maxOutputLength, so it fails before
// over-allocating) plus an aggregate ceiling across all entries. Both sit far
// above any real company package (inline JSON was historically capped at 64MB)
// yet far below what a bomb would need.
export const MAX_ZIP_ENTRY_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_TOTAL_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

export const binaryContentTypeByExtension: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function normalizeArchivePath(pathValue: string) {
  return pathValue
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function readUint16(source: Uint8Array, offset: number) {
  return source[offset]! | (source[offset + 1]! << 8);
}

function readUint32(source: Uint8Array, offset: number) {
  return (
    source[offset]! |
    (source[offset + 1]! << 8) |
    (source[offset + 2]! << 16) |
    (source[offset + 3]! << 24)
  ) >>> 0;
}

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

// Locate the end-of-central-directory record by scanning back from the tail.
// The record is 22 bytes plus an optional trailing comment (max 0xffff), so the
// signature lives within the last 22 + 0xffff bytes; returns -1 when absent
// (a truncated or non-zip upload), which the reader treats as fail-closed.
function findEndOfCentralDirectoryOffset(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - (22 + 0xffff));
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readUint32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

// Fully validate the central directory the EOCD advertises against the local
// entries actually read from the archive body. Trusting only the EOCD's entry
// count is not enough: a truncated archive with a forged 22-byte EOCD whose
// count matches the surviving local entries would otherwise be accepted, and the
// importer would silently process a partial company package (dropping agents,
// issues, and so on). This walks the real central directory and requires that:
//   • it is fully present and sits immediately before the EOCD (no gap, no
//     pointer past the buffer — a truncated tail fails here);
//   • every record carries the central-directory signature and its lengths sum
//     to exactly the declared directory size; and
//   • every record references a real local file header, and the record count
//     equals both the EOCD's declared count and the local entries parsed.
function validateCentralDirectory(bytes: Uint8Array, eocdOffset: number, localHeaderCount: number) {
  const declaredEntryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirectorySize = readUint32(bytes, eocdOffset + 12);
  const centralDirectoryStart = readUint32(bytes, eocdOffset + 16);
  if (centralDirectoryStart > eocdOffset || centralDirectoryStart + centralDirectorySize !== eocdOffset) {
    throw new Error(
      "Invalid zip archive: central directory location is inconsistent (truncated or forged).",
    );
  }

  const directoryEnd = centralDirectoryStart + centralDirectorySize;
  let cursor = centralDirectoryStart;
  let recordCount = 0;
  while (cursor < directoryEnd) {
    if (cursor + 46 > directoryEnd || readUint32(bytes, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid zip archive: malformed central directory record.");
    }
    const fileNameLength = readUint16(bytes, cursor + 28);
    const extraFieldLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localHeaderOffset = readUint32(bytes, cursor + 42);
    if (localHeaderOffset + 4 > bytes.length || readUint32(bytes, localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error("Invalid zip archive: central directory references a missing local entry.");
    }
    cursor += 46 + fileNameLength + extraFieldLength + commentLength;
    recordCount += 1;
  }

  if (cursor !== directoryEnd) {
    throw new Error("Invalid zip archive: central directory size does not match its records.");
  }
  if (recordCount !== declaredEntryCount || recordCount !== localHeaderCount) {
    throw new Error(
      `Invalid zip archive: central directory declares ${declaredEntryCount} entries but ${localHeaderCount} local entries were read (truncated or corrupt).`,
    );
  }
}

function sharedArchiveRoot(paths: string[]) {
  if (paths.length === 0) return null;
  const firstSegments = paths
    .map((entry) => normalizeArchivePath(entry).split("/").filter(Boolean))
    .filter((parts) => parts.length > 0);
  if (firstSegments.length === 0) return null;
  const candidate = firstSegments[0]![0]!;
  return firstSegments.every((parts) => parts.length > 1 && parts[0] === candidate)
    ? candidate
    : null;
}

export function isBlobStorePath(pathValue: string) {
  return /(^|\/)blobs\/[^/]+$/.test(normalizeArchivePath(pathValue));
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = strictTextDecoder.decode(bytes);
  } catch {
    return null;
  }
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : null;
}

export function bytesToPortableFileEntry(pathValue: string, bytes: Uint8Array): CompanyPortabilityFileEntry {
  // Content-addressed blob entries are opaque bytes regardless of extension.
  if (isBlobStorePath(pathValue)) {
    return { encoding: "base64", data: Buffer.from(bytes).toString("base64"), contentType: "application/octet-stream" };
  }
  const contentType = binaryContentTypeByExtension[path.extname(pathValue).toLowerCase()];
  if (contentType) {
    return { encoding: "base64", data: Buffer.from(bytes).toString("base64"), contentType };
  }
  const text = decodeStrictUtf8(bytes);
  if (text !== null) return text;
  // Bytes that are not valid UTF-8 must not be decoded lossily; fall back
  // to base64 so they round-trip exactly.
  return { encoding: "base64", data: Buffer.from(bytes).toString("base64"), contentType: "application/octet-stream" };
}

// Size caps applied while expanding an archive. Callers use the module defaults;
// the limits are parameterizable so the guard can be exercised in tests without
// allocating hundreds of megabytes.
export interface ReadZipArchiveLimits {
  maxEntryDecompressedBytes: number;
  maxTotalDecompressedBytes: number;
}

const DEFAULT_ZIP_LIMITS: ReadZipArchiveLimits = {
  maxEntryDecompressedBytes: MAX_ZIP_ENTRY_DECOMPRESSED_BYTES,
  maxTotalDecompressedBytes: MAX_ZIP_TOTAL_DECOMPRESSED_BYTES,
};

function inflateZipEntry(compressionMethod: number, bytes: Uint8Array, maxEntryDecompressedBytes: number) {
  if (compressionMethod === 0) {
    if (bytes.length > maxEntryDecompressedBytes) {
      throw new Error(
        `Unsupported zip archive: a stored entry exceeds the ${maxEntryDecompressedBytes}-byte per-entry limit.`,
      );
    }
    return bytes;
  }
  if (compressionMethod !== 8) {
    throw new Error("Unsupported zip archive: only STORE and DEFLATE entries are supported.");
  }
  try {
    // maxOutputLength makes zlib throw (ERR_BUFFER_TOO_LARGE) before it allocates
    // past the per-entry ceiling, so a bomb entry never materializes in memory.
    return new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxEntryDecompressedBytes }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `Unsupported zip archive: a compressed entry expands beyond the ${maxEntryDecompressedBytes}-byte per-entry limit.`,
      );
    }
    throw error;
  }
}

export async function readZipArchive(
  source: ArrayBuffer | Uint8Array,
  limits: ReadZipArchiveLimits = DEFAULT_ZIP_LIMITS,
): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const { maxEntryDecompressedBytes, maxTotalDecompressedBytes } = limits;
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const entries: Array<{ path: string; body: CompanyPortabilityFileEntry }> = [];
  let offset = 0;
  // Count every local file header (including directory entries) so the tally can
  // be reconciled against the central directory below; guard total expansion so
  // a bomb split across many entries is still bounded.
  let localHeaderCount = 0;
  let totalDecompressedBytes = 0;
  let reachedCentralDirectory = false;

  while (offset + 4 <= bytes.length) {
    const signature = readUint32(bytes, offset);
    if (signature === CENTRAL_DIRECTORY_SIGNATURE || signature === EOCD_SIGNATURE) {
      reachedCentralDirectory = true;
      break;
    }
    if (signature !== LOCAL_FILE_SIGNATURE) {
      throw new Error("Invalid zip archive: unsupported local file header.");
    }

    if (offset + 30 > bytes.length) {
      throw new Error("Invalid zip archive: truncated local file header.");
    }

    const generalPurposeFlag = readUint16(bytes, offset + 6);
    const compressionMethod = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const fileNameLength = readUint16(bytes, offset + 26);
    const extraFieldLength = readUint16(bytes, offset + 28);

    if ((generalPurposeFlag & 0x0008) !== 0) {
      throw new Error("Unsupported zip archive: data descriptors are not supported.");
    }

    const nameOffset = offset + 30;
    const bodyOffset = nameOffset + fileNameLength + extraFieldLength;
    const bodyEnd = bodyOffset + compressedSize;
    if (bodyEnd > bytes.length) {
      throw new Error("Invalid zip archive: truncated file contents.");
    }

    localHeaderCount += 1;
    const rawArchivePath = textDecoder.decode(bytes.slice(nameOffset, nameOffset + fileNameLength));
    const archivePath = normalizeArchivePath(rawArchivePath);
    const isDirectoryEntry = /\/$/.test(rawArchivePath.replace(/\\/g, "/"));
    if (archivePath && !isDirectoryEntry) {
      const entryBytes = inflateZipEntry(compressionMethod, bytes.slice(bodyOffset, bodyEnd), maxEntryDecompressedBytes);
      totalDecompressedBytes += entryBytes.length;
      if (totalDecompressedBytes > maxTotalDecompressedBytes) {
        throw new Error(
          `Unsupported zip archive: decompressed contents exceed the ${maxTotalDecompressedBytes}-byte limit.`,
        );
      }
      entries.push({
        path: archivePath,
        body: bytesToPortableFileEntry(archivePath, entryBytes),
      });
    }

    offset = bodyEnd;
  }

  // A complete archive always ends with a central directory after its local
  // entries. If the scan ran off the end of the buffer without reaching one, the
  // upload was truncated at a record boundary — fail closed rather than import a
  // leading fragment. Then fully validate the central directory the EOCD points
  // at so a truncated tail with a forged EOCD (whose count happens to match the
  // surviving entries) cannot smuggle in a partial import.
  if (!reachedCentralDirectory) {
    throw new Error("Invalid zip archive: truncated before the central directory.");
  }
  const eocdOffset = findEndOfCentralDirectoryOffset(bytes);
  if (eocdOffset === -1) {
    throw new Error("Invalid zip archive: missing end-of-central-directory record.");
  }
  validateCentralDirectory(bytes, eocdOffset, localHeaderCount);

  const rootPath = sharedArchiveRoot(entries.map((entry) => entry.path));
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  for (const entry of entries) {
    const normalizedPath =
      rootPath && entry.path.startsWith(`${rootPath}/`)
        ? entry.path.slice(rootPath.length + 1)
        : entry.path;
    if (!normalizedPath) continue;
    // Two entries that normalize to the same path (e.g. `a/b` and `a//b`) make
    // the package ambiguous; reject it rather than silently letting the later
    // entry's contents win over the earlier one.
    if (Object.prototype.hasOwnProperty.call(files, normalizedPath)) {
      throw new Error(`Invalid zip archive: duplicate entry path "${normalizedPath}".`);
    }
    files[normalizedPath] = entry.body;
  }

  return { rootPath, files };
}
