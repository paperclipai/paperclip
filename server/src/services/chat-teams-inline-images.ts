import { crc32 } from "node:zlib";
import type { FileUpload } from "chat";
import { normalizeContentType } from "../attachment-types.js";

// Teams picture-message contract, distinct from personal OneDrive file consent:
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability#use-picture-messages
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4#fetch-inline-images-from-message
// Decimal MB is conservative; animated GIFs are explicitly unsupported.
export const TEAMS_INLINE_IMAGE_MAX_BYTES = 1_000_000;
export const TEAMS_INLINE_IMAGE_MAX_DIMENSION = 1024;
const MAX_PARTS = 4096;
const MAX_JPEG_HEADER_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface TeamsInlineImage {
  data: Buffer;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif";
}

export function isTeamsInlineImageContentType(value: string): boolean {
  return ["image/png", "image/jpeg", "image/gif"].includes(
    normalizeContentType(value),
  );
}

function dimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= TEAMS_INLINE_IMAGE_MAX_DIMENSION &&
    height <= TEAMS_INLINE_IMAGE_MAX_DIMENSION
  );
}

function png(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let color = -1;
  let depth = 0;
  let palette = false;
  let dataBytes = 0;
  let dataSeen = false;
  let dataEnded = false;
  for (
    let parts = 0;
    parts < MAX_PARTS && offset + 12 <= bytes.length;
    parts++
  ) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return false;
    const data = offset + 8;
    if (offset === 8) {
      if (
        type !== "IHDR" ||
        size !== 13 ||
        !dimensions(bytes.readUInt32BE(data), bytes.readUInt32BE(data + 4))
      )
        return false;
      depth = bytes[data + 8]!;
      color = bytes[data + 9]!;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        bytes[data + 10] !== 0 ||
        bytes[data + 11] !== 0 ||
        ![0, 1].includes(bytes[data + 12]!)
      )
        return false;
    } else if (type === "IHDR" || ["acTL", "fcTL", "fdAT"].includes(type))
      return false;
    else if (type === "PLTE") {
      if (
        palette ||
        dataSeen ||
        [0, 4].includes(color) ||
        size === 0 ||
        size > 768 ||
        size % 3 !== 0 ||
        (color === 3 && size / 3 > 2 ** depth)
      )
        return false;
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) return false;
      dataSeen = true;
      dataBytes += size;
    } else if (type === "IEND")
      return size === 0 && dataBytes > 0 && end === bytes.length;
    else if (type[0] === type[0]!.toUpperCase()) return false;
    else if (dataSeen) dataEnded = true;
    offset = end;
  }
  return false;
}

function jpeg(bytes: Buffer): boolean {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    return false;
  let offset = 2;
  let frameSeen = false;
  const frame = new Set<number>();
  for (
    let parts = 0;
    parts < MAX_PARTS && offset + 4 <= bytes.length;
    parts++
  ) {
    if (offset >= MAX_JPEG_HEADER_BYTES || bytes[offset++] !== 0xff)
      return false;
    while (bytes[offset] === 0xff && offset < MAX_JPEG_HEADER_BYTES) offset++;
    if (offset >= MAX_JPEG_HEADER_BYTES || offset + 3 > bytes.length)
      return false;
    const marker = bytes[offset++]!;
    const size = bytes.readUInt16BE(offset);
    const end = offset + size;
    if (size < 2 || end > bytes.length || end > MAX_JPEG_HEADER_BYTES)
      return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frameSeen || size < 8 || bytes[offset + 2] !== 8) return false;
      const count = bytes[offset + 7]!;
      if (
        ![1, 3, 4].includes(count) ||
        size !== 8 + 3 * count ||
        !dimensions(
          bytes.readUInt16BE(offset + 5),
          bytes.readUInt16BE(offset + 3),
        )
      )
        return false;
      for (let index = 0; index < count; index++) {
        const component = offset + 8 + 3 * index;
        const id = bytes[component]!;
        const sampling = bytes[component + 1]!;
        if (
          frame.has(id) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          bytes[component + 2]! > 3
        )
          return false;
        frame.add(id);
      }
      frameSeen = true;
    } else if (marker === 0xda) {
      const count = bytes[offset + 2];
      if (
        !frameSeen ||
        count === undefined ||
        count === 0 ||
        count > frame.size ||
        size !== 6 + 2 * count ||
        end >= bytes.length - 2
      )
        return false;
      const scan = new Set<number>();
      for (let index = 0; index < count; index++) {
        const component = offset + 3 + 2 * index;
        const id = bytes[component]!;
        const tables = bytes[component + 1]!;
        if (
          !frame.has(id) ||
          scan.has(id) ||
          tables >> 4 > 3 ||
          (tables & 15) > 3
        )
          return false;
        scan.add(id);
      }
      // Compressed pixels remain opaque. This is header/container validation,
      // not a decoder or a guarantee that Microsoft accepts every pixel stream.
      return true;
    } else if (
      ![0xc4, 0xdb, 0xdd, 0xfe].includes(marker) &&
      !(marker >= 0xe0 && marker <= 0xef)
    )
      return false;
    offset = end;
  }
  return false;
}

function gif(bytes: Buffer): boolean {
  if (
    bytes.length < 14 ||
    !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))
  )
    return false;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (!dimensions(width, height)) return false;
  const globalColors = bytes[10]! & 0x80 ? 2 ** ((bytes[10]! & 7) + 1) : 0;
  if (globalColors && bytes[11]! >= globalColors) return false;
  let offset = 13 + globalColors * 3;
  let parts = 0;
  let frames = 0;
  let controlPending = false;
  let transparent: number | null = null;
  const subBlocks = (): number | null => {
    let total = 0;
    while (offset < bytes.length && ++parts <= MAX_PARTS) {
      const size = bytes[offset++]!;
      if (size === 0) return total;
      if (offset + size > bytes.length) return null;
      total += size;
      offset += size;
    }
    return null;
  };
  while (offset < bytes.length && ++parts <= MAX_PARTS) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b)
      return frames === 1 && !controlPending && offset === bytes.length;
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xfe) {
        if (subBlocks() === null) return false;
      } else if (label === 0xf9) {
        if (
          controlPending ||
          frames ||
          offset + 6 > bytes.length ||
          bytes[offset] !== 4 ||
          bytes[offset + 5] !== 0 ||
          bytes[offset + 1]! & 0xe0 ||
          ((bytes[offset + 1]! >> 2) & 7) > 3
        )
          return false;
        transparent = bytes[offset + 1]! & 1 ? bytes[offset + 4]! : null;
        controlPending = true;
        offset += 6;
      } else return false; // Application/looping and plain-text extensions are not static pictures.
    } else if (marker === 0x2c) {
      if (frames++ || offset + 9 > bytes.length) return false;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const frameWidth = bytes.readUInt16LE(offset + 4);
      const frameHeight = bytes.readUInt16LE(offset + 6);
      const packed = bytes[offset + 8]!;
      if (
        !dimensions(frameWidth, frameHeight) ||
        left + frameWidth > width ||
        top + frameHeight > height ||
        packed & 0x18
      )
        return false;
      const localColors = packed & 0x80 ? 2 ** ((packed & 7) + 1) : 0;
      const colors = localColors || globalColors;
      if (!colors || (transparent !== null && transparent >= colors))
        return false;
      offset += 9 + localColors * 3;
      if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8)
        return false;
      offset++;
      const length = subBlocks();
      if (length === null || length === 0) return false;
      controlPending = false;
    } else return false;
  }
  return false;
}

/** No authorization or transport is performed here. Callers retain current
 * source/destination checks and the ordinary durable publication I/O boundary.
 * Null means keep consent/fallback, never try an inline send then another lane.
 * Successful output contains only original bytes/name and canonical image MIME.
 */
export async function prepareTeamsInlineImage(
  file: FileUpload,
): Promise<TeamsInlineImage | null> {
  const name = file.filename;
  const mime = normalizeContentType(file.mimeType ?? "");
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 255 ||
    name !== name.trim() ||
    /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
    name.endsWith(".") ||
    !isTeamsInlineImageContentType(mime)
  )
    return null;
  const data = file.data;
  const size =
    data instanceof Blob
      ? data.size
      : Buffer.isBuffer(data) || data instanceof ArrayBuffer
        ? data.byteLength
        : 0;
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > TEAMS_INLINE_IMAGE_MAX_BYTES
  )
    return null;
  try {
    const bytes =
      data instanceof Blob
        ? Buffer.from(await data.arrayBuffer())
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : Buffer.from(data as Buffer);
    if (bytes.length !== size) return null;
    const valid =
      mime === "image/png"
        ? png(bytes)
        : mime === "image/jpeg"
          ? jpeg(bytes)
          : gif(bytes);
    return valid
      ? {
          data: bytes,
          filename: name,
          mimeType: mime as TeamsInlineImage["mimeType"],
        }
      : null;
  } catch {
    return null; // Malformed/detached inputs never expose payloads in an error.
  }
}
