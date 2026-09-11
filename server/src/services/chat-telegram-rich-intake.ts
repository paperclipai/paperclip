import { createHash } from "node:crypto";
import type { Attachment } from "chat";
import { bindTelegramRichAttachment } from "./chat-telegram-media-intake.js";

const MAX_TEXT = 100_000;
const MAX_NODES = 4096;
const MAX_DEPTH = 32;
const OMITTED =
  "[Paperclip could not import an unsupported or malformed Telegram rich content block.]";
const LIMIT =
  "[Telegram rich content exceeded the supported import limit. Please resend the omitted content as text or a supported file.]";
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const wrappers = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "date_time",
  "text_mention",
  "subscript",
  "superscript",
  "marked",
  "code",
  "bank_card_number",
  "mention",
  "hashtag",
  "cashtag",
  "bot_command",
  "anchor_link",
  "reference",
  "reference_link",
]);
type Path = Array<string | number>;
type CreateAttachment = (
  type: Attachment["type"],
  fileId: string,
  metadata: Record<string, unknown>,
) => Attachment;
export interface TelegramRichIntake {
  text: string;
  attachments: Attachment[];
  mediaDigest: string;
}

/** Inbound-only readable projection. It never renders draft thinking or acts on buttons/URLs. */
export function normalizeTelegramRichMessage(
  raw: unknown,
  create?: CreateAttachment,
): TelegramRichIntake | null {
  if (!record(raw) || raw.rich_message === undefined) return null;
  let nodes = 0;
  let characters = 0;
  let limited = false;
  const visiting = new WeakSet<object>();
  const attachments: Attachment[] = [];
  const mediaFacts: unknown[] = [];
  const limitError = new Error("Rich content limit");
  const enter = (value: unknown, depth: number) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw limitError;
    if (value && typeof value === "object") {
      if (visiting.has(value)) throw limitError;
      visiting.add(value);
    }
  };
  const leave = (value: unknown) => {
    if (value && typeof value === "object") visiting.delete(value);
  };
  const literal = (value: unknown): string => {
    if (typeof value !== "string") return OMITTED;
    characters += value.length;
    if (characters > MAX_TEXT) throw limitError;
    return value;
  };
  const joined = (parts: string[], separator = "\n\n") =>
    parts.filter((part) => part.length > 0).join(separator);
  const labelWithTarget = (label: string, target: unknown) => {
    if (typeof target !== "string") return joined([label, OMITTED], " ");
    const value = literal(target);
    return value === label ? label : `${label} (${value})`;
  };
  const button = (value: unknown, depth: number): string => {
    if (!record(value)) return OMITTED;
    const label = text(value.text, depth + 1);
    // Never retain callback data, web app payloads, switch-inline queries, or
    // payment/auth controls as text or a new executable capability.
    return typeof value.url === "string"
      ? labelWithTarget(label, value.url)
      : `${label} [Interactive button; no action was performed.]`;
  };
  const text = (value: unknown, depth: number): string => {
    enter(value, depth);
    try {
      if (typeof value === "string") return literal(value);
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const child of value) parts.push(text(child, depth + 1));
        return parts.join("");
      }
      if (!record(value)) return OMITTED;
      if (wrappers.has(String(value.type))) return text(value.text, depth + 1);
      switch (value.type) {
        case "custom_emoji":
          return literal(value.alternative_text);
        case "mathematical_expression":
          return literal(value.expression);
        case "url":
          return labelWithTarget(text(value.text, depth + 1), value.url);
        case "email_address":
          return labelWithTarget(
            text(value.text, depth + 1),
            value.email_address,
          );
        case "phone_number":
          return labelWithTarget(
            text(value.text, depth + 1),
            value.phone_number,
          );
        case "button":
          return button(value.button, depth + 1);
        case "anchor":
          return ""; // A non-visible navigation target, not omitted user text.
        default:
          return OMITTED;
      }
    } finally {
      leave(value);
    }
  };
  const caption = (value: unknown, depth: number): string => {
    if (value === undefined) return "";
    if (!record(value)) return OMITTED;
    return joined([
      text(value.text, depth + 1),
      value.credit === undefined ? "" : text(value.credit, depth + 1),
    ]);
  };
  const blocks = (value: unknown, path: Path, depth: number): string => {
    if (!Array.isArray(value)) return OMITTED;
    enter(value, depth);
    try {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index++)
        parts.push(block(value[index], [...path, index], depth + 1));
      return joined(parts);
    } finally {
      leave(value);
    }
  };
  const media = (value: Record<string, unknown>, path: Path): string => {
    if (attachments.length >= 20 || mediaFacts.length >= 20) return LIMIT;
    const subtype = String(value.type);
    const file =
      subtype === "photo" && Array.isArray(value.photo)
        ? value.photo.at(-1)
        : value[subtype];
    if (
      !record(file) ||
      typeof file.file_id !== "string" ||
      !file.file_id.length ||
      file.file_id.length > 2048 ||
      typeof file.file_unique_id !== "string" ||
      !file.file_unique_id.length ||
      file.file_unique_id.length > 2048 ||
      (file.file_name !== undefined &&
        (typeof file.file_name !== "string" || file.file_name.length > 255)) ||
      (file.mime_type !== undefined &&
        (typeof file.mime_type !== "string" || file.mime_type.length > 255)) ||
      [file.file_size, file.width, file.height].some(
        (part) =>
          part !== undefined &&
          (typeof part !== "number" || !Number.isSafeInteger(part) || part < 0),
      )
    ) {
      if (create) attachments.push({ type: "file" });
      return OMITTED;
    }
    const type: Attachment["type"] =
      subtype === "photo"
        ? "image"
        : ["audio", "voice_note"].includes(subtype)
          ? "audio"
          : subtype === "document"
            ? "file"
            : "video";
    const metadata = {
      fileUniqueId: file.file_unique_id,
      name: file.file_name,
      size: file.file_size,
      ...(type === "image" || type === "video"
        ? { width: file.width, height: file.height }
        : {}),
      mimeType: subtype === "photo" ? "image/jpeg" : file.mime_type,
    };
    // The digest contains only consumed file identity/metadata, never URLs,
    // button capabilities or private provider envelopes.
    mediaFacts.push([
      path,
      subtype,
      file.file_id,
      file.file_unique_id,
      metadata.name ?? null,
      metadata.size ?? null,
      metadata.mimeType ?? null,
      metadata.width ?? null,
      metadata.height ?? null,
    ]);
    if (!create) return "";
    const attachment = create(type, file.file_id, metadata);
    if (!bindTelegramRichAttachment(attachment, raw, path)) {
      attachments.push({ type: "file" });
      return OMITTED;
    }
    attachments.push(attachment);
    return "";
  };
  const block = (value: unknown, path: Path, depth: number): string => {
    enter(value, depth);
    try {
      if (!record(value)) return OMITTED;
      const credit = () =>
        value.credit === undefined ? "" : text(value.credit, depth + 1);
      switch (value.type) {
        case "paragraph":
        case "heading":
        case "pre":
        case "footer":
          return text(value.text, depth + 1);
        case "divider":
          return "---";
        case "anchor":
          return "";
        case "mathematical_expression":
          return literal(value.expression);
        case "expandable_blockquote":
        case "pullquote":
          return joined([text(value.text, depth + 1), credit()]);
        case "blockquote":
          return joined([
            blocks(value.blocks, [...path, "blocks"], depth + 1),
            credit(),
          ]);
        case "details":
          return joined([
            text(value.summary, depth + 1),
            blocks(value.blocks, [...path, "blocks"], depth + 1),
          ]);
        case "collage":
        case "slideshow":
          return joined([
            blocks(value.blocks, [...path, "blocks"], depth + 1),
            caption(value.caption, depth + 1),
          ]);
        case "list": {
          if (!Array.isArray(value.items)) return OMITTED;
          const result: string[] = [];
          for (let index = 0; index < value.items.length; index++) {
            enter(value.items[index], depth + 1);
            const item = value.items[index];
            try {
              result.push(
                record(item)
                  ? `${literal(item.label)} ${item.has_checkbox === true ? (item.is_checked === true ? "[x] " : "[ ] ") : ""}${blocks(item.blocks, [...path, "items", index, "blocks"], depth + 2)}`
                  : OMITTED,
              );
            } finally {
              leave(item);
            }
          }
          return joined(result, "\n");
        }
        case "table": {
          if (!Array.isArray(value.cells)) return OMITTED;
          const rows: string[] = [];
          for (const row of value.cells) {
            enter(row, depth + 1);
            try {
              if (!Array.isArray(row)) {
                rows.push(OMITTED);
                continue;
              }
              const cells: string[] = [];
              for (const cell of row) {
                enter(cell, depth + 2);
                try {
                  cells.push(
                    record(cell) && cell.text === undefined
                      ? ""
                      : record(cell)
                        ? text(cell.text, depth + 3)
                        : OMITTED,
                  );
                } finally {
                  leave(cell);
                }
              }
              rows.push(cells.join("\t"));
            } finally {
              leave(row);
            }
          }
          return joined([
            value.caption === undefined ? "" : text(value.caption, depth + 1),
            rows.join("\n"),
          ]);
        }
        case "buttons": {
          if (!Array.isArray(value.buttons)) return OMITTED;
          const labels: string[] = [];
          for (const item of value.buttons) {
            enter(item, depth + 1);
            try {
              labels.push(button(item, depth + 2));
            } finally {
              leave(item);
            }
          }
          return joined(labels, " | ");
        }
        case "map": {
          const location = value.location;
          const coordinates =
            record(location) &&
            typeof location.latitude === "number" &&
            Number.isFinite(location.latitude) &&
            Math.abs(location.latitude) <= 90 &&
            typeof location.longitude === "number" &&
            Number.isFinite(location.longitude) &&
            Math.abs(location.longitude) <= 180
              ? `Location: ${location.latitude}, ${location.longitude}`
              : OMITTED;
          return joined([coordinates, caption(value.caption, depth + 1)]);
        }
        case "animation":
        case "audio":
        case "document":
        case "photo":
        case "video":
        case "voice_note":
          return joined([
            media(value, path),
            caption(value.caption, depth + 1),
          ]);
        // Officially draft-only, never received as ordinary user content.
        case "thinking":
          return "[A Telegram draft-only placeholder was not imported.]";
        default:
          return OMITTED;
      }
    } finally {
      leave(value);
    }
  };
  let result = "";
  try {
    result = record(raw.rich_message)
      ? blocks(raw.rich_message.blocks, ["blocks"], 0)
      : OMITTED;
  } catch (error) {
    if (error !== limitError) throw error;
    limited = true;
  }
  if (limited || result.length > MAX_TEXT) {
    // Refuse an oversized tree visibly; never pretend its prefix is complete.
    result = LIMIT;
    attachments.length = 0;
  }
  return {
    text: result,
    attachments,
    mediaDigest: createHash("sha256")
      .update(JSON.stringify(mediaFacts))
      .digest("hex"),
  };
}
