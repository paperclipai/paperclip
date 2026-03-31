import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crcTable[i] = crc >>> 0;
}

function normalizeArchivePath(pathValue: string) {
  return pathValue
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
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

function getDosDateTime(date: Date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function concatChunks(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
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

const binaryContentTypeByExtension: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function inferBinaryContentType(pathValue: string) {
  const normalized = normalizeArchivePath(pathValue);
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex === -1) return null;
  return binaryContentTypeByExtension[normalized.slice(extensionIndex).toLowerCase()] ?? null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToPortableFileEntry(pathValue: string, bytes: Uint8Array): CompanyPortabilityFileEntry {
  const contentType = inferBinaryContentType(pathValue);
  if (!contentType) return textDecoder.decode(bytes);
  return {
    encoding: "base64",
    data: bytesToBase64(bytes),
    contentType,
  };
}

function portableFileEntryToBytes(entry: CompanyPortabilityFileEntry): Uint8Array {
  if (typeof entry === "string") return textEncoder.encode(entry);
  return base64ToBytes(entry.data);
}

async function inflateZipEntry(compressionMethod: number, bytes: Uint8Array) {
  if (compressionMethod === 0) return bytes;
  if (compressionMethod !== 8) {
    throw new Error("Unsupported zip archive: only STORE and DEFLATE entries are supported.");
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error("Unsupported zip archive: this browser cannot read compressed zip entries.");
  }
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipArchive(source: ArrayBuffer | Uint8Array): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const entries: Array<{ path: string; body: CompanyPortabilityFileEntry }> = [];
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = readUint32(bytes, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
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

    const rawArchivePath = textDecoder.decode(bytes.slice(nameOffset, nameOffset + fileNameLength));
    const archivePath = normalizeArchivePath(rawArchivePath);
    const isDirectoryEntry = /\/$/.test(rawArchivePath.replace(/\\/g, "/"));
    if (archivePath && !isDirectoryEntry) {
      const entryBytes = await inflateZipEntry(compressionMethod, bytes.slice(bodyOffset, bodyEnd));
      entries.push({
        path: archivePath,
        body: bytesToPortableFileEntry(archivePath, entryBytes),
      });
    }

    offset = bodyEnd;
  }

  const rootPath = sharedArchiveRoot(entries.map((entry) => entry.path));
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  for (const entry of entries) {
    const normalizedPath =
      rootPath && entry.path.startsWith(`${rootPath}/`)
        ? entry.path.slice(rootPath.length + 1)
        : entry.path;
    if (!normalizedPath) continue;
    files[normalizedPath] = entry.body;
  }

  return { rootPath, files };
}

export function createZipArchive(files: Record<string, CompanyPortabilityFileEntry>, rootPath: string): Uint8Array {
  const normalizedRoot = normalizeArchivePath(rootPath);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  const archiveDate = getDosDateTime(new Date());
  let localOffset = 0;
  let entryCount = 0;

  for (const [relativePath, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const archivePath = normalizeArchivePath(`${normalizedRoot}/${relativePath}`);
    const fileName = textEncoder.encode(archivePath);
    const body = portableFileEntryToBytes(contents);
    const checksum = crc32(body);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, archiveDate.time);
    writeUint16(localHeader, 12, archiveDate.date);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, body.length);
    writeUint32(localHeader, 22, body.length);
    writeUint16(localHeader, 26, fileName.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, archiveDate.time);
    writeUint16(centralHeader, 14, archiveDate.date);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, body.length);
    writeUint32(centralHeader, 24, body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
    entryCount += 1;
  }

  const centralDirectory = concatChunks(centralChunks);
  const endOfCentralDirectory = new Uint8Array(22);
  writeUint32(endOfCentralDirectory, 0, 0x06054b50);
  writeUint16(endOfCentralDirectory, 4, 0);
  writeUint16(endOfCentralDirectory, 6, 0);
  writeUint16(endOfCentralDirectory, 8, entryCount);
  writeUint16(endOfCentralDirectory, 10, entryCount);
  writeUint32(endOfCentralDirectory, 12, centralDirectory.length);
  writeUint32(endOfCentralDirectory, 16, localOffset);
  writeUint16(endOfCentralDirectory, 20, 0);

  return concatChunks([...localChunks, centralDirectory, endOfCentralDirectory]);
}
