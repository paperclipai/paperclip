export type SupportedImageContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

const MIME_ALIASES: Record<string, SupportedImageContentType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

function hasPrefix(buffer: Buffer, values: number[]): boolean {
  if (buffer.length < values.length) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (buffer[index] !== values[index]) return false;
  }
  return true;
}

export function normalizeDeclaredImageContentType(value: string | undefined): SupportedImageContentType | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return MIME_ALIASES[normalized] ?? null;
}

export function detectImageContentTypeBySignature(buffer: Buffer): SupportedImageContentType | null {
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif";
  if (hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
