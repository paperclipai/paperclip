import { createHash } from "node:crypto";

export const TELEGRAM_OUTBOUND_NAMESPACE = "telegram-outbound";
export const TELEGRAM_OUTBOUND_STATE_KEY = "last";

const OPERATOR_REPORT = /ответил в telegram|закрыт[ао] до следующего|заявку не создавал|\/issues\/|\[[A-Za-z][A-Za-z0-9]{1,9}-\d+\]|\b[A-Z]{2,10}-\d+\b/i;

export function refuseOperatorReport(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || !OPERATOR_REPORT.test(normalized)) return null;
  return "This text is a Paperclip operator note. Send one short plain customer reply with telegram_send_text. Do not include task ids, task links, task status, or the phrase «Ответил в Telegram».";
}

export function normalizeTelegramOutbound(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function outboundTextHash(text: string): string {
  return createHash("sha256").update(normalizeTelegramOutbound(text), "utf8").digest("hex");
}

function isOutboundHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function readStoredOutbound(value: unknown): { hash: string; at: number; sentHashes: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { hash?: unknown; at?: unknown; sentHashes?: unknown };
  const sentHashes = Array.isArray(record.sentHashes) ? record.sentHashes.filter(isOutboundHash) : [];
  if (!isOutboundHash(record.hash)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  if (!sentHashes.includes(record.hash)) sentHashes.push(record.hash);
  return { hash: record.hash, at: record.at, sentHashes };
}

export function commentInstant(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

export function decideDialogFollowup(input: {
  comments: Array<{ id: string; createdAt?: unknown; authorAgentId?: string | null }>;
  assignedAgentId?: string | null;
  lastOutboundAt?: number | null;
  lastOutboundHash?: string | null;
  sentHashes?: string[] | null;
}): {
  relayText: null;
  pendingTexts: string[];
  wake: boolean;
  wakeCommentId: string | null;
  humanCommentId: string | null;
} {
  // A board comment is an operator note. It is never customer text, including
  // when assignedAgentId wrote it after the person.
  void input.assignedAgentId;
  void input.lastOutboundHash;
  void input.sentHashes;
  let human: { id: string; at: number } | null = null;
  for (const comment of input.comments) {
    const at = commentInstant(comment.createdAt);
    if (at == null || comment.authorAgentId != null) continue;
    if (!human || at >= human.at) human = { id: comment.id, at };
  }
  const wake = human != null && (input.lastOutboundAt == null || human.at > input.lastOutboundAt);
  return {
    relayText: null,
    pendingTexts: [],
    wake,
    wakeCommentId: wake && human ? human.id : null,
    humanCommentId: human?.id ?? null,
  };
}
