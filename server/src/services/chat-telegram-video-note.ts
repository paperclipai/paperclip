import type { Attachment } from "chat";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fileIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}

function integer(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

/**
 * Telegram VideoNote has no MIME/name fields; its provider-defined format is
 * MPEG4 (https://core.telegram.org/bots/api#sendvideonote). Apply that contract
 * only inside the pinned Telegram parser, to its exact raw-source attachment.
 * This does not authenticate a callback or grant source access: the normal
 * verified-webhook and current service admission gates still do that work.
 */
export function normalizeTelegramVideoNoteAttachments(
  raw: unknown,
  attachments: Attachment[],
): Attachment[] {
  if (
    !record(raw) ||
    !record(raw.video_note) ||
    !record(raw.chat) ||
    !integer(raw.message_id, 0) ||
    !integer(raw.date, 0) ||
    !integer(raw.chat.id, Number.MIN_SAFE_INTEGER) ||
    raw.chat.id === 0 ||
    attachments.length !== 1
  )
    return attachments;
  // A document with a claimed video type is not a VideoNote. Conflicting
  // primary media fields cannot establish this narrow provider contract.
  if (
    [
      "document",
      "photo",
      "video",
      "voice",
      "audio",
      "animation",
      "sticker",
      "live_photo",
      "rich_message",
    ].some((key) => raw[key] !== undefined && raw[key] !== null)
  )
    return attachments;
  const note = raw.video_note;
  const attachment = attachments[0]!;
  if (
    !fileIdentity(note.file_id) ||
    !fileIdentity(note.file_unique_id) ||
    !integer(note.length, 1) ||
    !integer(note.duration, 0) ||
    (note.file_size !== undefined && !integer(note.file_size, 0)) ||
    attachment.type !== "video" ||
    attachment.mimeType !== undefined ||
    attachment.fetchMetadata?.fileId !== note.file_id ||
    attachment.fetchMetadata?.fileUniqueId !== note.file_unique_id ||
    attachment.width !== note.length ||
    attachment.height !== note.length ||
    attachment.size !== note.file_size
  )
    return attachments;
  return [{ ...attachment, mimeType: "video/mp4" }];
}
