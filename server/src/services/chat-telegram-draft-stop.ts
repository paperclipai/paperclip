import { createHash } from "node:crypto";
import { z } from "zod";

export const TELEGRAM_DRAFT_ACTION_KIND = "telegram_publication_draft";
export const TELEGRAM_DRAFT_STOPPED_REASON =
  "Telegram draft presentation was stopped. The saved answer and task are unchanged.";

const positiveId = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const draftId = z.number().int().min(1).max(2_147_483_647);
const topicId = z.number().int().positive().safe().nullable();
const bindingSchema = z
  .object({
    version: z.literal(1),
    publicationId: z.string().uuid(),
    publicationAttempt: z.number().int().positive(),
    conversationId: z.string().uuid(),
    sessionGeneration: z.number().int().nonnegative(),
    runtimeGeneration: z.number().int().nonnegative(),
    credentialFingerprint: z.string().min(1).max(256),
    botUserId: positiveId,
    chatId: positiveId,
    messageThreadId: topicId,
    draftId,
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type TelegramDraftBinding = z.infer<typeof bindingSchema>;
export function parseTelegramDraftBinding(
  value: unknown,
): TelegramDraftBinding | null {
  const parsed = bindingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export const telegramDraftTextSha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export interface TelegramDraftControl {
  version: 1;
  draftId: number;
  beforeDraft(): Promise<boolean>;
  beforeFinal(): Promise<boolean>;
}
export interface TelegramDraftStopped {
  paperclipDraftStopped: true;
}
export function isTelegramDraftStopped(
  value: unknown,
): value is TelegramDraftStopped {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as TelegramDraftStopped).paperclipDraftStopped === true
  );
}

export function telegramPrivateDraftDestination(threadId: string): {
  chatId: string;
  messageThreadId: number | null;
} | null {
  const match = /^telegram:([1-9][0-9]{0,15})(?::([1-9][0-9]{0,15}))?$/.exec(
    threadId,
  );
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    (match[2] && !Number.isSafeInteger(Number(match[2])))
  )
    return null;
  return {
    chatId: match[1]!,
    messageThreadId: match[2] ? Number(match[2]) : null,
  };
}

export interface TelegramGenerationStoppedReceipt {
  botUserId: string;
  updateId: number;
  chatId: string;
  messageThreadId: number | null;
  draftId: number;
}
declare const provenance: unique symbol;
export type TelegramGenerationStoppedProof = Readonly<{ [provenance]: true }>;
const proofs = new WeakMap<
  object,
  Readonly<TelegramGenerationStoppedReceipt>
>();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Called only inside the installed adapter's authenticated dispatch boundary.
 * The actorless provider event confers presentation-stop authority, never task authority. */
export function captureTelegramGenerationStopped(
  botUserId: string,
  update: unknown,
): TelegramGenerationStoppedProof | null {
  if (
    !positiveId.safeParse(botUserId).success ||
    !record(update) ||
    !Number.isSafeInteger(update.update_id) ||
    Number(update.update_id) < 0 ||
    !record(update.stopped_message_generation)
  )
    return null;
  const stop = update.stopped_message_generation;
  if (
    !record(stop.chat) ||
    stop.chat.type !== "private" ||
    typeof stop.chat.id !== "number" ||
    !Number.isSafeInteger(stop.chat.id) ||
    stop.chat.id <= 0 ||
    !draftId.safeParse(stop.draft_id).success ||
    !topicId.safeParse(stop.message_thread_id ?? null).success
  )
    return null;
  const proof = Object.freeze({}) as TelegramGenerationStoppedProof;
  proofs.set(
    proof,
    Object.freeze({
      botUserId,
      updateId: Number(update.update_id),
      chatId: String(stop.chat.id),
      messageThreadId:
        stop.message_thread_id == null ? null : Number(stop.message_thread_id),
      draftId: Number(stop.draft_id),
    }),
  );
  return proof;
}
export function telegramGenerationStoppedReceipt(
  proof: TelegramGenerationStoppedProof,
): Readonly<TelegramGenerationStoppedReceipt> | null {
  return typeof proof === "object" && proof !== null
    ? (proofs.get(proof) ?? null)
    : null;
}
