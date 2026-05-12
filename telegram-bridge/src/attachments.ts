/**
 * Telegram photo/document attachment handling for the Paperclip bridge.
 *
 * Downloads photos and documents from Telegram's CDN, saves them
 * locally, and returns file metadata for inclusion in issue descriptions.
 *
 * Ported from v2/channels/telegram-attachment.ts, but simplified:
 * - No calendar photo routing (that was v2-specific)
 * - Downloads to /tmp/ with predictable naming
 * - Returns local path + metadata for the bridge to include in issue body
 */

import type { Api } from "grammy";

export type DownloadedAttachment = {
  localPath: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  type: "photo" | "document";
};

/**
 * Download a photo from Telegram. Gets the largest available resolution.
 */
export async function downloadPhoto(
  api: Api,
  token: string,
  fileId: string,
): Promise<DownloadedAttachment | { error: string }> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      return { error: "Telegram returned no file_path for photo" };
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const ext = file.file_path.split(".").pop() ?? "jpg";
    const localPath = `/tmp/tg-photo-${fileId.slice(0, 12)}.${ext}`;

    const res = await fetch(url);
    if (!res.ok) {
      return { error: `Failed to download photo: ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    const { writeFileSync } = await import("fs");
    writeFileSync(localPath, Buffer.from(buf));

    return {
      localPath,
      fileName: `photo.${ext}`,
      mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
      fileSize: buf.byteLength,
      type: "photo",
    };
  } catch (err: any) {
    return { error: `Photo download failed: ${err?.message ?? err}` };
  }
}

/**
 * Download a document/file from Telegram.
 */
export async function downloadDocument(
  api: Api,
  token: string,
  fileId: string,
  fileName?: string,
  mimeType?: string,
): Promise<DownloadedAttachment | { error: string }> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      return { error: "Telegram returned no file_path for document" };
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const safeName = fileName?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "document";
    const localPath = `/tmp/tg-doc-${fileId.slice(0, 12)}-${safeName}`;

    const res = await fetch(url);
    if (!res.ok) {
      return { error: `Failed to download document: ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    const { writeFileSync } = await import("fs");
    writeFileSync(localPath, Buffer.from(buf));

    return {
      localPath,
      fileName: safeName,
      mimeType: mimeType ?? "application/octet-stream",
      fileSize: buf.byteLength,
      type: "document",
    };
  } catch (err: any) {
    return { error: `Document download failed: ${err?.message ?? err}` };
  }
}

/**
 * Format attachment info for inclusion in an issue description.
 */
export function formatAttachmentsForIssue(attachments: DownloadedAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const sizeStr = a.fileSize ? ` (${(a.fileSize / 1024).toFixed(1)}KB)` : "";
    return `[${a.type}: ${a.fileName}${sizeStr}](${a.localPath})`;
  });
  return "\n\n📎 Attachments:\n" + lines.join("\n");
}
