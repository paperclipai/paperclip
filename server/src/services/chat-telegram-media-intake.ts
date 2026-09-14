import { createHash } from "node:crypto";
import type { Attachment } from "chat";

type MediaKind =
  | "voice"
  | "audio"
  | "video"
  | "animation"
  | "live_photo_video"
  | "live_photo_image"
  | "rich_document"
  | "rich_photo";
export interface TelegramMediaScope {
  companyId: string;
  endpointId: string;
  runtimeGeneration: number;
  credentialFingerprint: string;
  threadId: string;
  messageId: string;
  principalExternalId: string;
}
export interface TelegramMediaLocator extends TelegramMediaScope {
  kind: "telegram_media";
  media: MediaKind;
  fileId: string;
  fileUniqueId: string;
  metadataSha256: string;
  sourceSha256: string;
  richPath?: string;
}
type Origin = Pick<
  TelegramMediaLocator,
  | "media"
  | "fileId"
  | "fileUniqueId"
  | "threadId"
  | "messageId"
  | "principalExternalId"
  | "metadataSha256"
  | "richPath"
>;
const origins = new WeakMap<Attachment, Origin>();
const KINDS = new Set<MediaKind>([
  "voice",
  "audio",
  "video",
  "animation",
  "live_photo_video",
  "live_photo_image",
  "rich_document",
  "rich_photo",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2048 &&
  !/[\s\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function validRichPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  try {
    const path: unknown = JSON.parse(value);
    return (
      Array.isArray(path) &&
      path.length >= 2 &&
      path.length <= 64 &&
      path.length % 2 === 0 &&
      path[0] === "blocks" &&
      path.every((part, index) =>
        index % 2 === 0 ? part === "blocks" || part === "items" : integer(part),
      )
    );
  } catch {
    return false;
  }
}
function metadataHash(attachment: Attachment): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        attachment.type,
        attachment.mimeType ?? null,
        attachment.name ?? null,
        attachment.size ?? null,
        attachment.width ?? null,
        attachment.height ?? null,
      ]),
    )
    .digest("hex");
}
function sourceHash(value: Origin & TelegramMediaScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.media,
        value.fileId,
        value.fileUniqueId,
        value.metadataSha256,
        value.companyId,
        value.endpointId,
        value.runtimeGeneration,
        value.credentialFingerprint,
        value.threadId,
        value.messageId,
        value.principalExternalId,
        ...(value.richPath === undefined ? [] : [value.richPath]),
      ]),
    )
    .digest("hex");
}

/** Runtime-owned provenance, never inferred from arbitrary attachment metadata. */
export function hasTelegramMediaProvenance(attachment: Attachment): boolean {
  return origins.has(attachment);
}

export function telegramMediaNeedsIdentification(
  attachment: Attachment,
): boolean {
  const media = origins.get(attachment)?.media;
  return Boolean(
    media &&
    !["rich_document", "rich_photo", "live_photo_image"].includes(media),
  );
}

/** Bind a parsed rich file to its exact original provider block, not a copied subtype hint. */
export function bindTelegramRichAttachment(
  attachment: Attachment,
  raw: unknown,
  path: readonly (string | number)[],
): boolean {
  if (
    !record(raw) ||
    !record(raw.chat) ||
    !record(raw.from) ||
    !integer(raw.chat.id, Number.MIN_SAFE_INTEGER) ||
    !raw.chat.id ||
    !integer(raw.from.id, 1) ||
    !integer(raw.message_id, 1) ||
    !integer(raw.date) ||
    raw.receiver_user !== undefined ||
    raw.ephemeral_message_id !== undefined ||
    (raw.message_thread_id !== undefined &&
      !integer(raw.message_thread_id, 1)) ||
    !path.length ||
    path.length > 64 ||
    path.some((part) =>
      typeof part === "number"
        ? !integer(part)
        : !["blocks", "items"].includes(part),
    )
  )
    return false;
  let block: unknown = raw.rich_message;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(block)) return false;
      block = block[part];
    } else {
      if (!record(block)) return false;
      block = block[part];
    }
  }
  if (
    !record(block) ||
    ![
      "document",
      "photo",
      "video",
      "animation",
      "voice_note",
      "audio",
    ].includes(String(block.type))
  )
    return false;
  const kind = String(block.type);
  const file =
    kind === "photo" && Array.isArray(block.photo)
      ? block.photo.at(-1)
      : block[kind];
  if (
    !record(file) ||
    !id(file.file_id) ||
    !id(file.file_unique_id) ||
    (file.file_size !== undefined && !integer(file.file_size)) ||
    (file.file_name !== undefined &&
      (typeof file.file_name !== "string" || file.file_name.length > 255)) ||
    (file.mime_type !== undefined &&
      (typeof file.mime_type !== "string" || file.mime_type.length > 255)) ||
    (!["document", "photo"].includes(kind) && !integer(file.duration)) ||
    (["photo", "video", "animation"].includes(kind) &&
      (!integer(file.width, 1) || !integer(file.height, 1)))
  )
    return false;
  const type =
    kind === "photo"
      ? "image"
      : kind === "document"
        ? "file"
        : ["audio", "voice_note"].includes(kind)
          ? "audio"
          : "video";
  const expected: Attachment = {
    type,
    size: file.file_size as number | undefined,
    name: file.file_name as string | undefined,
    mimeType:
      kind === "photo" ? "image/jpeg" : (file.mime_type as string | undefined),
    ...(["image", "video"].includes(type)
      ? { width: file.width as number, height: file.height as number }
      : {}),
  };
  if (
    metadataHash(attachment) !== metadataHash(expected) ||
    attachment.fetchMetadata?.fileId !== file.file_id ||
    attachment.fetchMetadata?.fileUniqueId !== file.file_unique_id
  )
    return false;
  origins.set(attachment, {
    media:
      kind === "document"
        ? "rich_document"
        : kind === "photo"
          ? "rich_photo"
          : kind === "voice_note"
            ? "voice"
            : (kind as MediaKind),
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    richPath: JSON.stringify(path),
    threadId: `telegram:${raw.chat.id}${raw.message_thread_id === undefined ? "" : `:${raw.message_thread_id}`}`,
    messageId: `${raw.chat.id}:${raw.message_id}`,
    principalExternalId: String(raw.from.id),
    metadataSha256: metadataHash(attachment),
  });
  return true;
}

export function normalizeTelegramMediaAttachments(
  raw: unknown,
  attachments: Attachment[],
  create: (
    type: Attachment["type"],
    fileId: string,
    metadata: Record<string, unknown>,
  ) => Attachment,
): Attachment[] {
  if (
    !record(raw) ||
    !record(raw.chat) ||
    !record(raw.from) ||
    !integer(raw.chat.id, Number.MIN_SAFE_INTEGER) ||
    raw.chat.id === 0 ||
    !integer(raw.from.id) ||
    !integer(raw.message_id) ||
    !integer(raw.date) ||
    (raw.message_thread_id !== undefined && !integer(raw.message_thread_id, 1))
  )
    return attachments;
  const primary = [
    "photo",
    "document",
    "voice",
    "audio",
    "video",
    "animation",
    "video_note",
    "sticker",
    "live_photo",
    "rich_message",
  ].filter((key) => raw[key] !== undefined && raw[key] !== null);
  // Telegram repeats an animation in document for backward compatibility.
  const kinds = primary.filter(
    (key) => !(key === "document" && primary.includes("animation")),
  );
  if (kinds.length !== 1) return attachments;
  const kind = kinds[0]!;
  const media = raw[kind];
  if (!record(media)) return attachments;
  const validFile = (file: Record<string, unknown>) =>
    id(file.file_id) &&
    id(file.file_unique_id) &&
    (file.file_size === undefined || integer(file.file_size));
  const valid =
    validFile(media) &&
    integer(media.duration) &&
    (!["video", "animation", "live_photo"].includes(kind) ||
      (integer(media.width, 1) && integer(media.height, 1)));
  if (!["voice", "audio", "video", "animation", "live_photo"].includes(kind))
    return attachments;
  if (!valid)
    return kind === "live_photo" && attachments.length === 0
      ? [{ type: "file" }]
      : attachments;
  const chat = raw.chat;
  const author = raw.from;
  const remember = (
    attachment: Attachment,
    file: Record<string, unknown>,
    mediaKind: MediaKind,
  ) => {
    origins.set(attachment, {
      media: mediaKind,
      fileId: file.file_id as string,
      fileUniqueId: file.file_unique_id as string,
      threadId: `telegram:${chat.id}${raw.message_thread_id === undefined ? "" : `:${raw.message_thread_id}`}`,
      messageId: `${chat.id}:${raw.message_id}`,
      principalExternalId: String(author.id),
      metadataSha256: metadataHash(attachment),
    });
    return attachment;
  };
  if (kind === "live_photo") {
    if (attachments.length) return attachments;
    const result: Attachment[] = [];
    const photo = Array.isArray(media.photo) ? media.photo.at(-1) : undefined;
    if (
      record(photo) &&
      validFile(photo) &&
      integer(photo.width, 1) &&
      integer(photo.height, 1)
    ) {
      result.push(
        remember(
          create("image", photo.file_id as string, {
            fileUniqueId: photo.file_unique_id,
            size: photo.file_size,
            width: photo.width,
            height: photo.height,
            mimeType: "image/jpeg",
          }),
          photo,
          "live_photo_image",
        ),
      );
    }
    result.push(
      remember(
        create("video", media.file_id as string, {
          fileUniqueId: media.file_unique_id,
          size: media.file_size,
          width: media.width,
          height: media.height,
          ...(typeof media.mime_type === "string"
            ? { mimeType: media.mime_type }
            : {}),
        }),
        media,
        "live_photo_video",
      ),
    );
    return result;
  }
  if (media.mime_type !== undefined || attachments.length !== 1)
    return attachments;
  const attachment = attachments[0]!;
  if (
    attachment.mimeType !== undefined ||
    attachment.fetchMetadata?.fileId !== media.file_id ||
    attachment.fetchMetadata?.fileUniqueId !== media.file_unique_id ||
    attachment.size !== media.file_size ||
    attachment.type !==
      (["voice", "audio"].includes(kind) ? "audio" : "video") ||
    (["video", "animation"].includes(kind) &&
      (attachment.width !== media.width || attachment.height !== media.height))
  )
    return attachments;
  remember(attachment, media, kind as MediaKind);
  return attachments;
}

export function telegramMediaLocator(
  attachment: Attachment,
  scope: TelegramMediaScope,
): TelegramMediaLocator | null {
  const origin = origins.get(attachment);
  if (
    !origin ||
    origin.metadataSha256 !== metadataHash(attachment) ||
    !integer(scope.runtimeGeneration, 1) ||
    !id(scope.credentialFingerprint) ||
    !id(scope.companyId) ||
    !id(scope.endpointId) ||
    origin.threadId !== scope.threadId ||
    origin.messageId !== scope.messageId ||
    origin.principalExternalId !== scope.principalExternalId
  )
    return null;
  return {
    kind: "telegram_media",
    ...origin,
    ...scope,
    sourceSha256: sourceHash({ ...origin, ...scope }),
  };
}

export function validateTelegramMediaLocator(
  value: unknown,
  attachment: Attachment,
  scope: TelegramMediaScope,
): TelegramMediaLocator | null {
  if (
    !record(value) ||
    value.kind !== "telegram_media" ||
    !KINDS.has(value.media as MediaKind) ||
    !id(value.fileId) ||
    !id(value.fileUniqueId) ||
    value.metadataSha256 !== metadataHash(attachment) ||
    !integer(value.runtimeGeneration, 1) ||
    !id(value.credentialFingerprint) ||
    (value.richPath !== undefined && !validRichPath(value.richPath)) ||
    (["rich_document", "rich_photo"].includes(String(value.media)) &&
      value.richPath === undefined) ||
    (Object.keys(scope) as (keyof TelegramMediaScope)[]).some(
      (key) => value[key] !== scope[key],
    )
  )
    return null;
  const locator = {
    kind: "telegram_media" as const,
    media: value.media as MediaKind,
    fileId: value.fileId,
    fileUniqueId: value.fileUniqueId,
    metadataSha256: value.metadataSha256 as string,
    ...(typeof value.richPath === "string" ? { richPath: value.richPath } : {}),
    ...scope,
  };
  const sourceSha256 = sourceHash(locator);
  return value.sourceSha256 === sourceSha256
    ? { ...locator, sourceSha256 }
    : null;
}

export function retainTelegramMediaProvenance(
  attachment: Attachment,
  locator: TelegramMediaLocator,
): Attachment {
  origins.set(attachment, locator);
  return attachment;
}

function mp4Kind(bytes: Buffer): "audio/mp4" | "video/mp4" | null {
  let parts = 0;
  let metadataBytes = 0;
  let ftyp = false;
  let mdat = false;
  let audio = false;
  let video = false;
  const scan = (start: number, end: number, depth: number): boolean => {
    if (depth > 4) return false;
    for (let offset = start; offset < end;) {
      if (++parts > 512 || offset + 8 > end) return false;
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString("latin1", offset + 4, offset + 8);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(large);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return false;
      metadataBytes += header;
      if (metadataBytes > 256 * 1024) return false;
      const payload = offset + header;
      if (depth === 0 && type === "ftyp") {
        if (
          offset !== 0 ||
          size < header + 8 ||
          (size - header) % 4 !== 0 ||
          size > 1024
        )
          return false;
        const brands = [bytes.toString("latin1", payload, payload + 4)];
        for (let at = payload + 8; at < offset + size; at += 4)
          brands.push(bytes.toString("latin1", at, at + 4));
        ftyp = brands.some((brand) =>
          /^(?:isom|iso[2-9]|mp4[12]|M4A |M4V |avc1|dash)$/.test(brand),
        );
      } else if (depth === 0 && type === "mdat") mdat ||= size > header;
      else if (
        (depth === 0 && type === "moov") ||
        (depth === 1 && type === "trak") ||
        (depth === 2 && type === "mdia")
      ) {
        if (!scan(payload, offset + size, depth + 1)) return false;
      } else if (depth === 3 && type === "hdlr") {
        if (size < header + 24) return false;
        const handler = bytes.toString("latin1", payload + 8, payload + 12);
        audio ||= handler === "soun";
        video ||= handler === "vide";
      }
      offset += size;
    }
    return true;
  };
  return scan(0, bytes.length, 0) && ftyp && mdat
    ? video
      ? "video/mp4"
      : audio
        ? "audio/mp4"
        : null
    : null;
}

const OGG_CRC = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});
function oggOpus(bytes: Buffer): boolean {
  let offset = 0;
  let page = 0;
  let serial: number | undefined;
  let audio = false;
  while (offset < bytes.length && page < 4096) {
    if (
      offset + 27 > bytes.length ||
      bytes.toString("latin1", offset, offset + 4) !== "OggS" ||
      bytes[offset + 4] !== 0
    )
      return false;
    const flags = bytes[offset + 5]!;
    const segments = bytes[offset + 26]!;
    if (
      flags > 7 ||
      !segments ||
      offset + 27 + segments > bytes.length ||
      bytes.readUInt32LE(offset + 18) !== page
    )
      return false;
    const currentSerial = bytes.readUInt32LE(offset + 14);
    if (page === 0) serial = currentSerial;
    else if (serial !== currentSerial) return false;
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[offset + 27 + i]!;
    const payload = offset + 27 + segments;
    const end = payload + size;
    if (end > bytes.length) return false;
    let crc = 0;
    for (let at = offset; at < end; at++) {
      const byte = at >= offset + 22 && at < offset + 26 ? 0 : bytes[at]!;
      crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 255]!) >>> 0;
    }
    if (crc !== bytes.readUInt32LE(offset + 22)) return false;
    if (page === 0) {
      if (
        flags !== 2 ||
        size < 19 ||
        bytes.toString("latin1", payload, payload + 8) !== "OpusHead" ||
        bytes[payload + 8] !== 1 ||
        ![1, 2].includes(bytes[payload + 9]!) ||
        bytes[payload + 18] !== 0
      )
        return false;
    } else if (page > 1 && size > 0) audio = true;
    if ((flags & 4) !== 0) return end === bytes.length && audio;
    offset = end;
    page++;
  }
  return false;
}

function mp3(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.toString("latin1", 0, 3) === "ID3") {
    if (
      bytes.length < 10 ||
      ![2, 3, 4].includes(bytes[3]!) ||
      bytes.subarray(6, 10).some((byte) => byte >= 128)
    )
      return false;
    offset =
      10 +
      ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
    if (offset > 256 * 1024) return false;
  }
  for (let count = 0; count < 2; count++) {
    if (
      offset + 4 > bytes.length ||
      bytes[offset] !== 255 ||
      (bytes[offset + 1]! & 0xe0) !== 0xe0
    )
      return false;
    const version = (bytes[offset + 1]! >> 3) & 3;
    const layer = (bytes[offset + 1]! >> 1) & 3;
    const rate = (bytes[offset + 2]! >> 4) & 15;
    const sample = (bytes[offset + 2]! >> 2) & 3;
    if (
      version === 1 ||
      layer !== 1 ||
      rate === 0 ||
      rate === 15 ||
      sample === 3
    )
      return false;
    const bitrate =
      (version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[
        rate
      ]! * 1000;
    const frequency =
      [44100, 48000, 32000][sample]! /
      (version === 3 ? 1 : version === 2 ? 2 : 4);
    offset +=
      Math.floor(((version === 3 ? 144 : 72) * bitrate) / frequency) +
      ((bytes[offset + 2]! >> 1) & 1);
    if (offset > bytes.length) return false;
  }
  return true;
}

function gif(bytes: Buffer): boolean {
  if (
    bytes.length < 14 ||
    !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)) ||
    !bytes.readUInt16LE(6) ||
    !bytes.readUInt16LE(8)
  )
    return false;
  let offset = 13 + (bytes[10]! & 128 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
  let parts = 0;
  let images = 0;
  const subBlocks = () => {
    while (offset < bytes.length && ++parts <= 4096) {
      const size = bytes[offset++]!;
      if (!size) return true;
      offset += size;
      if (offset > bytes.length) return false;
    }
    return false;
  };
  while (offset < bytes.length && ++parts <= 4096) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) return images > 0 && offset === bytes.length;
    if (marker === 0x21) {
      if (![0x01, 0xf9, 0xfe, 0xff].includes(bytes[offset++]!) || !subBlocks())
        return false;
    } else if (marker === 0x2c) {
      if (
        offset + 9 > bytes.length ||
        !bytes.readUInt16LE(offset + 4) ||
        !bytes.readUInt16LE(offset + 6)
      )
        return false;
      const packed = bytes[offset + 8]!;
      offset += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8)
        return false;
      offset++;
      if (!subBlocks()) return false;
      images++;
    } else return false;
  }
  return false;
}

/** Bounded container/header identification, not a decoder or codec validation. */
export function identifyTelegramMedia(
  attachment: Attachment,
  bytes: Buffer,
): string | null {
  const origin = origins.get(attachment);
  if (
    !origin ||
    origin.metadataSha256 !== metadataHash(attachment) ||
    !bytes.length
  )
    return null;
  const type = mp4Kind(bytes);
  if (
    ["video", "animation", "live_photo_video"].includes(origin.media) &&
    type === "video/mp4"
  )
    return type;
  if (origin.media === "animation" && gif(bytes)) return "image/gif";
  if (["voice", "audio"].includes(origin.media)) {
    if (type === "audio/mp4") return type;
    if (oggOpus(bytes)) return "audio/ogg";
    if (mp3(bytes)) return "audio/mpeg";
  }
  // Unknown containers remain unavailable; no arbitrary octet-stream allowance.
  return null;
}
