import { crc32 } from "node:zlib";
import type { Attachment, FileUpload } from "chat";
import { normalizeContentType } from "../attachment-types.js";

// Telegram documents a 10 MB photo limit. Use decimal MB conservatively,
// independently of Paperclip's configurable task-attachment byte ceiling.
export const TELEGRAM_PHOTO_MAX_BYTES = 10_000_000;
const MAX_CONTAINER_PARTS = 4_096;
const MAX_JPEG_HEADER_BYTES = 256 * 1_024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function supportedDimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width + height <= 10_000 &&
    Math.max(width, height) <= 20 * Math.min(width, height)
  );
}

function supportedPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let colorType = -1;
  let bitDepth = 0;
  let palette = false;
  let imageData = 0;
  let imageDataSeen = false;
  let imageDataEnded = false;
  for (
    let parts = 0;
    parts < MAX_CONTAINER_PARTS && offset + 12 <= bytes.length;
    parts += 1
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
        !supportedDimensions(
          bytes.readUInt32BE(data),
          bytes.readUInt32BE(data + 4),
        )
      )
        return false;
      bitDepth = bytes[data + 8]!;
      colorType = bytes[data + 9]!;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[colorType]?.includes(bitDepth) ||
        bytes[data + 10] !== 0 ||
        bytes[data + 11] !== 0 ||
        ![0, 1].includes(bytes[data + 12]!)
      )
        return false;
    } else if (type === "IHDR" || ["acTL", "fcTL", "fdAT"].includes(type)) {
      // Animated PNGs are preserved as documents, not flattened into photos.
      return false;
    } else if (type === "PLTE") {
      if (
        palette ||
        imageDataSeen ||
        [0, 4].includes(colorType) ||
        size === 0 ||
        size > 768 ||
        size % 3 !== 0 ||
        (colorType === 3 && size / 3 > 2 ** bitDepth)
      )
        return false;
      palette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (colorType === 3 && !palette)) return false;
      imageDataSeen = true;
      imageData += size;
    } else if (type === "IEND") {
      return size === 0 && imageData > 0 && end === bytes.length;
    } else if (type[0] === type[0]!.toUpperCase()) {
      // An unknown critical chunk is not a supported PNG container.
      return false;
    } else if (imageDataSeen) {
      imageDataEnded = true;
    }
    offset = end;
  }
  return false;
}

function supportedJpeg(bytes: Buffer): boolean {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    return false;
  let offset = 2;
  let frameSeen = false;
  const frameComponents = new Set<number>();
  for (
    let parts = 0;
    parts < MAX_CONTAINER_PARTS && offset + 4 <= bytes.length;
    parts += 1
  ) {
    if (offset >= MAX_JPEG_HEADER_BYTES || bytes[offset++] !== 0xff)
      return false;
    while (bytes[offset] === 0xff && offset < MAX_JPEG_HEADER_BYTES)
      offset += 1;
    if (offset >= MAX_JPEG_HEADER_BYTES || offset + 3 > bytes.length)
      return false;
    const marker = bytes[offset++]!;
    const size = bytes.readUInt16BE(offset);
    const end = offset + size;
    if (size < 2 || end > bytes.length || end > MAX_JPEG_HEADER_BYTES)
      return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frameSeen || size < 8 || bytes[offset + 2] !== 8) return false;
      const components = bytes[offset + 7]!;
      if (
        ![1, 3, 4].includes(components) ||
        size !== 8 + 3 * components ||
        !supportedDimensions(
          bytes.readUInt16BE(offset + 5),
          bytes.readUInt16BE(offset + 3),
        )
      )
        return false;
      for (let index = 0; index < components; index += 1) {
        const component = offset + 8 + 3 * index;
        const id = bytes[component]!;
        const sampling = bytes[component + 1]!;
        const horizontal = sampling >> 4;
        const vertical = sampling & 0x0f;
        if (
          frameComponents.has(id) ||
          horizontal < 1 ||
          horizontal > 4 ||
          vertical < 1 ||
          vertical > 4 ||
          bytes[component + 2]! > 3
        )
          return false;
        frameComponents.add(id);
      }
      frameSeen = true;
    } else if (marker === 0xda) {
      // The entropy-coded image stays opaque. Never decode attacker pixels.
      const components = bytes[offset + 2];
      if (
        !frameSeen ||
        components === undefined ||
        components === 0 ||
        components > frameComponents.size ||
        size !== 6 + 2 * components ||
        end >= bytes.length - 2
      )
        return false;
      const scanComponents = new Set<number>();
      for (let index = 0; index < components; index += 1) {
        const component = offset + 3 + 2 * index;
        const id = bytes[component]!;
        const tables = bytes[component + 1]!;
        if (
          !frameComponents.has(id) ||
          scanComponents.has(id) ||
          tables >> 4 > 3 ||
          (tables & 0x0f) > 3
        )
          return false;
        scanComponents.add(id);
      }
      return true;
    } else if (
      marker !== 0xc4 &&
      marker !== 0xdb &&
      marker !== 0xdd &&
      marker !== 0xfe &&
      !(marker >= 0xe0 && marker <= 0xef)
    ) {
      return false;
    }
    offset = end;
  }
  return false;
}

/**
 * Bounded metadata/container probe, not a full image decoder. Telegram still
 * validates compressed image data. Unknown formats, malformed containers and
 * unsupported photo geometry stay unchanged in the document lane before I/O.
 * No decompression, pixel allocation, metadata expansion, or network access.
 */
export function isTelegramPhoto(bytes: Buffer, contentType: string): boolean {
  if (bytes.length === 0 || bytes.length > TELEGRAM_PHOTO_MAX_BYTES)
    return false;
  if (contentType === "image/png") return supportedPng(bytes);
  if (contentType === "image/jpeg" || contentType === "image/jpg")
    return supportedJpeg(bytes);
  return false;
}

export async function telegramAttachmentForUpload(
  file: FileUpload,
): Promise<Attachment> {
  const mimeType = file.mimeType?.toLowerCase() ?? "application/octet-stream";
  const contentType = normalizeContentType(mimeType);
  const data =
    file.data instanceof ArrayBuffer ? Buffer.from(file.data) : file.data;
  const size = data instanceof Blob ? data.size : data.byteLength;
  // Unsupported photo metadata stays in the exact-original document lane.
  // Do not allocate even a Blob probe beyond the photo-specific byte budget.
  const photo =
    contentType.startsWith("image/") &&
    size <= TELEGRAM_PHOTO_MAX_BYTES &&
    isTelegramPhoto(
      data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data,
      contentType,
    );
  // Telegram's audio player accepts MP3/M4A and its video method MPEG4.
  // Other allowed media remain lossless documents, chosen before provider I/O.
  const type: Attachment["type"] = photo
    ? "image"
    : contentType === "audio/mpeg" || contentType === "audio/mp4"
      ? "audio"
      : contentType === "video/mp4"
        ? "video"
        : "file";
  return { data, mimeType, name: file.filename, size, type };
}
