/**
 * Pairing state read/write helpers.
 *
 * One Telegram chat is paired *per company* in the Paperclip instance. The
 * handshake follows the OpenClaw-style pattern: the operator initiates pairing
 * for a target company in Paperclip, sends any message to the bot in
 * Telegram, the bot replies with a one-time code, and the operator pastes the
 * code back into Paperclip to confirm. This proves the operator controls
 * both ends — receiving the bot is not enough, and starting pairing in
 * Paperclip is not enough.
 *
 * Only one handshake is in flight at a time across the instance. Starting a
 * new pairing while another is in flight cancels the previous one.
 *
 * State is namespaced under `instance` scope so the same paired-chats map
 * applies across all companies in this Paperclip instance.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PAIRING_WINDOW_TTL_MS, STATE_KEY } from "./constants.js";
import type {
  ApprovalConfig,
  PairedChat,
  PairingHandshake,
  PairingState,
  TelegramChat,
} from "./types.js";

const SCOPE = { scopeKind: "instance" as const, stateKey: STATE_KEY };

export async function readPairing(ctx: PluginContext): Promise<PairingState> {
  const raw = await ctx.state.get(SCOPE);
  if (!raw || typeof raw !== "object") return {};
  return raw as PairingState;
}

export async function writePairing(
  ctx: PluginContext,
  next: PairingState,
): Promise<void> {
  await ctx.state.set(SCOPE, next);
}

export async function patchPairing(
  ctx: PluginContext,
  patch: Partial<PairingState>,
): Promise<PairingState> {
  const current = await readPairing(ctx);
  const next = { ...current, ...patch };
  await writePairing(ctx, next);
  return next;
}

export async function clearHandshake(ctx: PluginContext): Promise<void> {
  const current = await readPairing(ctx);
  delete current.pairing;
  await writePairing(ctx, current);
}

// ---------------------------------------------------------------------------
// Per-company pairing helpers
// ---------------------------------------------------------------------------

export function isPairedFor(
  state: PairingState,
  companyId: string,
): boolean {
  return !!state.pairedByCompany?.[companyId];
}

export function getPaired(
  state: PairingState,
  companyId: string,
): PairedChat | undefined {
  return state.pairedByCompany?.[companyId];
}

export function listPairedCompanies(
  state: PairingState,
): Array<{ companyId: string; chat: PairedChat }> {
  const map = state.pairedByCompany ?? {};
  return Object.entries(map).map(([companyId, chat]) => ({ companyId, chat }));
}

/**
 * Whether `chatId` is the chat currently paired to `companyId`. Guards
 * callbacks fired from old inline messages: if a chat was unpaired (or
 * re-paired to a different company) after a message was sent, its stale
 * buttons must not act on the original company.
 */
export function isChatPairedToCompany(
  state: PairingState,
  chatId: string,
  companyId: string,
): boolean {
  const paired = state.pairedByCompany?.[companyId];
  return !!paired && paired.chatId === chatId;
}

/**
 * Reverse lookup: given a Telegram chat ID, find which company (if any)
 * currently has that chat paired.
 */
export function findCompanyForChat(
  state: PairingState,
  chatId: string,
): { companyId: string; chat: PairedChat } | undefined {
  const map = state.pairedByCompany ?? {};
  for (const [companyId, chat] of Object.entries(map)) {
    if (chat.chatId === chatId) return { companyId, chat };
  }
  return undefined;
}

export async function setPairedChat(
  ctx: PluginContext,
  companyId: string,
  chat: PairedChat,
): Promise<void> {
  const current = await readPairing(ctx);
  const next: PairingState = {
    ...current,
    pairedByCompany: {
      ...(current.pairedByCompany ?? {}),
      [companyId]: chat,
    },
  };
  await writePairing(ctx, next);
}

export async function patchPairedChat(
  ctx: PluginContext,
  companyId: string,
  patch: Partial<PairedChat>,
): Promise<PairedChat | undefined> {
  const current = await readPairing(ctx);
  const existing = current.pairedByCompany?.[companyId];
  if (!existing) return undefined;
  const next: PairedChat = { ...existing, ...patch };
  await writePairing(ctx, {
    ...current,
    pairedByCompany: {
      ...(current.pairedByCompany ?? {}),
      [companyId]: next,
    },
  });
  return next;
}

export async function removePairedChat(
  ctx: PluginContext,
  companyId: string,
): Promise<PairedChat | undefined> {
  const current = await readPairing(ctx);
  const existing = current.pairedByCompany?.[companyId];
  if (!existing) return undefined;
  const nextMap = { ...(current.pairedByCompany ?? {}) };
  delete nextMap[companyId];
  await writePairing(ctx, {
    ...current,
    pairedByCompany: nextMap,
  });
  return existing;
}

// ---------------------------------------------------------------------------
// Handshake helpers
// ---------------------------------------------------------------------------

export function isHandshakeExpired(
  handshake: PairingHandshake,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(handshake.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt <= now : true;
}

export function newHandshakeExpiry(now = Date.now()): string {
  return new Date(now + PAIRING_WINDOW_TTL_MS).toISOString();
}

/**
 * Generate a 6-character uppercase verification code.
 *
 * Charset excludes ambiguous characters (0/O, 1/I/L) so reading the code off
 * a Telegram message and typing it into a Paperclip form remains painless.
 *
 * Uses `crypto.getRandomValues` for cryptographic randomness — `Math.random`
 * is not a CSPRNG and its output can be predicted given enough observed
 * draws, which would weaken a security-sensitive handshake. Bias from the
 * 32-character charset (256 mod 32 = 0, so unbiased) keeps each character
 * uniformly distributed without rejection sampling.
 */
export function generateVerificationCode(): string {
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // length 31
  // 31 doesn't divide 256 evenly, so to keep the distribution uniform we
  // discard bytes that fall into the truncated tail and re-draw.
  const max = Math.floor(256 / charset.length) * charset.length; // 248
  const out: string[] = [];
  while (out.length < 6) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < 6; i++) {
      const b = buf[i]!;
      if (b < max) out.push(charset[b % charset.length]!);
    }
  }
  return out.join("");
}

export function chatLabel(chat: TelegramChat): string {
  if (chat.username) return `@${chat.username}`;
  if (chat.title) return chat.title;
  const first = chat.first_name ?? "";
  const last = chat.last_name ?? "";
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : `chat:${chat.id}`;
}

// ---------------------------------------------------------------------------
// Message context store (for inline-keyboard callbacks)
// ---------------------------------------------------------------------------

/** Cap on stored message contexts; oldest are evicted past this limit. */
const MAX_MESSAGE_CONTEXTS = 200;

/**
 * Storage key for a message context. The Telegram message_id is only unique
 * within a chat, so two paired chats can independently land on the same
 * numeric id; scoping the key with the chat id prevents a callback in one
 * chat from resolving a context created for another.
 */
function messageContextKey(
  chatId: number | string,
  messageId: number | string,
): string {
  return `${String(chatId)}:${String(messageId)}`;
}

export async function saveMessageContext(
  ctx: PluginContext,
  chatId: number | string,
  messageId: number | string,
  value: import("./types.js").MessageContext,
): Promise<void> {
  const current = await readPairing(ctx);
  const map = { ...(current.messageContexts ?? {}) };
  map[messageContextKey(chatId, messageId)] = value;
  // Evict oldest entries by createdAt if over the cap.
  const entries = Object.entries(map);
  if (entries.length > MAX_MESSAGE_CONTEXTS) {
    entries.sort(
      (a, b) => Date.parse(a[1].createdAt) - Date.parse(b[1].createdAt),
    );
    const trimmed = entries.slice(entries.length - MAX_MESSAGE_CONTEXTS);
    const next: Record<string, import("./types.js").MessageContext> = {};
    for (const [k, v] of trimmed) next[k] = v;
    await writePairing(ctx, { ...current, messageContexts: next });
    return;
  }
  await writePairing(ctx, { ...current, messageContexts: map });
}

export async function getMessageContext(
  ctx: PluginContext,
  chatId: number | string,
  messageId: number | string,
): Promise<import("./types.js").MessageContext | undefined> {
  const current = await readPairing(ctx);
  return current.messageContexts?.[messageContextKey(chatId, messageId)];
}

// ---------------------------------------------------------------------------
// Approval config helpers
// ---------------------------------------------------------------------------

export function getApprovalConfig(
  state: PairingState,
  companyId: string,
): ApprovalConfig | undefined {
  return state.approvalByCompany?.[companyId];
}

export async function setApprovalConfig(
  ctx: PluginContext,
  companyId: string,
  next: ApprovalConfig,
): Promise<void> {
  const current = await readPairing(ctx);
  await writePairing(ctx, {
    ...current,
    approvalByCompany: {
      ...(current.approvalByCompany ?? {}),
      [companyId]: next,
    },
  });
}

/**
 * Whether a Telegram user is allowed to resolve (approve/decline) plan
 * confirmations for a company.
 *
 * Precedence:
 *   1. Explicit `ApprovalConfig.approverTelegramUserId` — only that user.
 *   2. Otherwise the operator who completed pairing
 *      (`PairedChat.pairedByTelegramUserId`).
 *   3. Legacy chats with neither recorded fall back to the chat-membership
 *      boundary (allow) so an upgrade doesn't lock out already-paired
 *      operators. New pairings always capture the operator id, so the hole
 *      ("anyone in a group chat can approve") closes for them.
 */
export function isAuthorizedApprover(
  approval: ApprovalConfig | undefined,
  chat: PairedChat | undefined,
  fromUserId: number | undefined,
): boolean {
  if (approval?.approverTelegramUserId != null) {
    return fromUserId === approval.approverTelegramUserId;
  }
  if (chat?.pairedByTelegramUserId != null) {
    return fromUserId === chat.pairedByTelegramUserId;
  }
  return true;
}

/**
 * Whether a Telegram user may run destructive connection-management commands
 * (currently `/unpair`) for a paired chat. Only the operator who completed the
 * handshake qualifies; chats paired before that id was captured fall back to
 * allow so the command keeps working after an upgrade. Note this is the
 * pairing operator specifically — not the plan-approval approver, which is a
 * separate role configured per company.
 */
export function isPairingOperator(
  chat: PairedChat | undefined,
  fromUserId: number | undefined,
): boolean {
  if (chat?.pairedByTelegramUserId != null) {
    return fromUserId === chat.pairedByTelegramUserId;
  }
  return true;
}

/** Constant-time-ish equality for short verification codes. */
export function codesMatch(a: string, b: string): boolean {
  const aa = a.trim().toUpperCase();
  const bb = b.trim().toUpperCase();
  if (aa.length !== bb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < aa.length; i++) {
    mismatch |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }
  return mismatch === 0;
}
