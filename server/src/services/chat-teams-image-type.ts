import type { Attachment } from "chat";
import sharp from "sharp";
import { GENERIC_ATTACHMENT_CONTENT_TYPES, normalizeContentType } from "../attachment-types.js";

const imageExtensions = /\.(png|jpe?g|gif|webp|heic|heif)$/i;

/** Only call for an already-admitted personal Teams attachment. */
export function teamsImageNeedsIdentification(attachment: Pick<Attachment, "mimeType" | "name">): boolean {
  const mimeType = normalizeContentType(attachment.mimeType);
  // Inline images can arrive as image/* without a filename. The wildcard is
  // not a stored content type: the downloaded bytes determine that type.
  return mimeType === "image/*" ||
    (GENERIC_ATTACHMENT_CONTENT_TYPES.includes(mimeType) && imageExtensions.test(attachment.name ?? ""));
}

export async function identifyTeamsImage(body: Buffer): Promise<string | null> {
  try {
    const metadata = await sharp(body, { limitInputPixels: 40_000_000, failOn: "warning" }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) return null;
    switch (metadata.format) {
      case "png": return "image/png";
      case "jpeg": return "image/jpeg";
      case "gif": return "image/gif";
      case "webp": return "image/webp";
      // Sharp reports both HEIC and AVIF as heif. Only HEVC is supported here.
      case "heif": return metadata.compression === "hevc" ? "image/heic" : null;
      default: return null;
    }
  } catch {
    return null;
  }
}
