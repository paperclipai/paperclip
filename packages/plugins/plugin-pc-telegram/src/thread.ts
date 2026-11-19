import { forwardFromStoredLine, type PublicForward } from "./forward.js";

const TEXT_LIMIT = 4000;

export type ChatBubble = {
  id: string;
  direction: "in" | "out";
  text: string;
  at: string;
  forward?: PublicForward | null;
  placeholder?: boolean;
};

export type TelegramHistoryMessage = {
  action?: unknown;
  message?: unknown;
  media?: { className?: string } | null;
  id?: unknown;
  out?: boolean;
  date?: unknown;
};

function historyTime(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function mediaLabel(className: string | undefined): string {
  if (!className) return "";
  if (className === "MessageMediaPhoto") return "Photo";
  if (className === "MessageMediaDocument") return "File";
  return "";
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TEXT_LIMIT ? trimmed.slice(0, TEXT_LIMIT) : trimmed;
}

export function mapTelegramMessage(message: TelegramHistoryMessage | null | undefined): ChatBubble | null {
  if (!message || message.action) return null;
  const text = typeof message.message === "string" ? message.message : "";
  const label = mediaLabel(message.media?.className);
  const body = clip(text || label);
  if (!body) return null;
  const id = message.id == null ? "" : String(message.id);
  if (!id || id.length > 32) return null;
  return {
    id,
    direction: message.out ? "out" : "in",
    text: body,
    at: historyTime(message.date),
    placeholder: !text.trim() && Boolean(label),
  };
}

const SPEAKER_LINE = /^\*\*[^*]+\*\*$/;
const ATTACHMENT_LINE = /^(Voice message|Photo|Video|Attachment):\s+\S+/;

export function customerTextFromStoredBody(body: string): string {
  const parts = body.split(/\n\n/).map((part) => part.trim()).filter(Boolean);
  const content = SPEAKER_LINE.test(parts[0] ?? "") ? parts.slice(1) : parts;
  const lines = content.map((part) => {
    if (part.startsWith("Voice message:")) return "Voice message";
    if (part.startsWith("Photo:")) return "Photo";
    if (part.startsWith("Video:")) return "Video";
    if (part.startsWith("Attachment:")) return "File";
    if (ATTACHMENT_LINE.test(part)) return "";
    return part;
  }).filter(Boolean);
  return clip(lines.join("\n\n"));
}

export function bubbleFromStoredBody(body: string): { text: string; forward: PublicForward | null; placeholder: boolean } {
  const parts = body.split(/\n\n/).map((part) => part.trim()).filter(Boolean);
  const content = SPEAKER_LINE.test(parts[0] ?? "") ? parts.slice(1) : parts;
  let forward: PublicForward | null = null;
  const kept: string[] = [];
  for (const part of content) {
    const parsed = forwardFromStoredLine(part);
    if (parsed && !forward) {
      forward = parsed;
      continue;
    }
    kept.push(part);
  }
  const authored = kept.some((part) => !ATTACHMENT_LINE.test(part) && !part.startsWith("attachment:"));
  const media = kept.some((part) => ATTACHMENT_LINE.test(part));
  return {
    text: customerTextFromStoredBody(kept.join("\n\n")),
    forward,
    placeholder: !authored && media,
  };
}
