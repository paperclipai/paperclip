import { createHash } from "node:crypto";

export const TELEGRAM_EPHEMERAL_WINDOW_MS = 15_000;
export const TELEGRAM_PRIVATE_ACTION_UNAVAILABLE =
  "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.";

export interface TelegramCallbackReceipt {
  version: 1;
  kind: "telegram_callback";
  companyId: string;
  endpointId: string;
  botUserId: string;
  updateId: number;
  callbackId: string;
  receiverUserId: string;
  chatId: string;
  chatType: "group" | "supergroup" | "private";
  messageThreadId: number | null;
  sourceMessageId: number;
  dataSha256: string;
  receivedAtMs: number;
  deadlineAtMs: number;
  sourceSha256: string;
}

declare const provenance: unique symbol;
export type TelegramCallbackProvenance = Readonly<{ [provenance]: true }>;
const proofs = new WeakMap<object, Readonly<TelegramCallbackReceipt>>();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const identifier = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u0020\u007f]/u.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  Number.isSafeInteger(Number(value));
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hash = (value: Omit<TelegramCallbackReceipt, "sourceSha256">) =>
  sha256(
    JSON.stringify([
      value.version,
      value.kind,
      value.companyId,
      value.endpointId,
      value.botUserId,
      value.updateId,
      value.callbackId,
      value.receiverUserId,
      value.chatId,
      value.chatType,
      value.messageThreadId,
      value.sourceMessageId,
      value.dataSha256,
      value.receivedAtMs,
      value.deadlineAtMs,
    ]),
  );

export function telegramCallbackThreadId(
  value: TelegramCallbackReceipt,
): string {
  return `telegram:${value.chatId}${value.messageThreadId === null ? "" : `:${value.messageThreadId}`}`;
}

/** Pure stored-data validation; this does not confer credential or send authority. */
export function parseTelegramCallbackReceipt(
  value: unknown,
): TelegramCallbackReceipt | null {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "botUserId,callbackId,chatId,chatType,companyId,dataSha256,deadlineAtMs,endpointId,kind,messageThreadId,receivedAtMs,receiverUserId,sourceMessageId,sourceSha256,updateId,version" ||
    value.version !== 1 ||
    value.kind !== "telegram_callback" ||
    !identifier(value.companyId) ||
    !identifier(value.endpointId) ||
    !decimal(value.botUserId) ||
    !decimal(value.receiverUserId) ||
    !identifier(value.callbackId, 256) ||
    !integer(value.updateId) ||
    typeof value.chatId !== "string" ||
    !/^-?[1-9][0-9]{0,15}$/.test(value.chatId) ||
    !Number.isSafeInteger(Number(value.chatId)) ||
    !["group", "supergroup", "private"].includes(String(value.chatType)) ||
    (value.chatType === "private"
      ? value.chatId !== value.receiverUserId
      : Number(value.chatId) >= 0) ||
    (value.messageThreadId !== null && !integer(value.messageThreadId, 1)) ||
    !integer(value.sourceMessageId, 1) ||
    !integer(value.receivedAtMs, 1) ||
    !integer(value.deadlineAtMs, 1) ||
    value.deadlineAtMs - value.receivedAtMs !== TELEGRAM_EPHEMERAL_WINDOW_MS ||
    typeof value.dataSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.dataSha256) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256)
  )
    return null;
  const parsed = value as unknown as TelegramCallbackReceipt;
  return hash(parsed) === parsed.sourceSha256 ? { ...parsed } : null;
}

/** Called only by the runtime's post-verification adapter dispatch wrapper. */
export function captureTelegramCallbackProvenance(
  scope: { companyId: string; endpointId: string; botUserId: string },
  update: unknown,
  receivedAtMs: number,
): { raw: object; proof: TelegramCallbackProvenance } | null {
  if (
    !record(update) ||
    !integer(update.update_id) ||
    !record(update.callback_query)
  )
    return null;
  const callback = update.callback_query;
  const message = callback.message;
  const actor = callback.from;
  if (
    !record(message) ||
    !record(message.chat) ||
    !record(message.from) ||
    !record(actor) ||
    !integer(message.message_id, 1) ||
    !integer(message.date, 1) ||
    message.receiver_user !== undefined ||
    message.ephemeral_message_id !== undefined ||
    message.from.is_bot !== true ||
    String(message.from.id) !== scope.botUserId ||
    !integer(actor.id, 1) ||
    actor.is_bot !== false ||
    !identifier(callback.id, 256) ||
    typeof callback.data !== "string" ||
    Buffer.byteLength(callback.data, "utf8") > 64 ||
    !integer(message.chat.id, Number.MIN_SAFE_INTEGER) ||
    !["group", "supergroup", "private"].includes(String(message.chat.type)) ||
    (message.chat.type === "private"
      ? message.chat.id !== actor.id
      : message.chat.id >= 0) ||
    (message.message_thread_id !== undefined &&
      !integer(message.message_thread_id, 1))
  )
    return null;
  const receipt: TelegramCallbackReceipt = {
    version: 1,
    kind: "telegram_callback",
    ...scope,
    updateId: update.update_id,
    callbackId: callback.id,
    receiverUserId: String(actor.id),
    chatId: String(message.chat.id),
    chatType: message.chat.type as TelegramCallbackReceipt["chatType"],
    messageThreadId: message.message_thread_id ?? null,
    sourceMessageId: message.message_id,
    dataSha256: sha256(callback.data),
    receivedAtMs,
    deadlineAtMs: receivedAtMs + TELEGRAM_EPHEMERAL_WINDOW_MS,
    sourceSha256: "",
  };
  receipt.sourceSha256 = hash(receipt);
  if (!parseTelegramCallbackReceipt(receipt)) return null;
  const proof = Object.freeze({}) as TelegramCallbackProvenance;
  proofs.set(proof, Object.freeze(receipt));
  return { raw: callback, proof };
}

export function readTelegramCallbackProvenance(
  proof: unknown,
  expected: {
    companyId: string;
    endpointId: string;
    botUserId: string;
    threadId: string;
    messageId: string;
    userId: string;
  },
): TelegramCallbackReceipt | null {
  const value = record(proof) ? proofs.get(proof) : undefined;
  return value &&
    value.companyId === expected.companyId &&
    value.endpointId === expected.endpointId &&
    value.botUserId === expected.botUserId &&
    telegramCallbackThreadId(value) === expected.threadId &&
    `${value.chatId}:${value.sourceMessageId}` === expected.messageId &&
    value.receiverUserId === expected.userId
    ? { ...value }
    : null;
}

/** Unsupported ephemeral input must never be admitted under the reusable chat:0 ID. */
export function hasTelegramEphemeralInput(update: unknown): boolean {
  if (!record(update)) return false;
  for (const key of [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
  ]) {
    const message = update[key];
    if (
      record(message) &&
      (message.message_id === 0 ||
        message.receiver_user !== undefined ||
        message.ephemeral_message_id !== undefined)
    )
      return true;
  }
  const callback = update.callback_query;
  const message = record(callback) ? callback.message : null;
  if (
    record(message) &&
    (message.message_id === 0 ||
      message.receiver_user !== undefined ||
      message.ephemeral_message_id !== undefined)
  )
    return true;
  return false;
}

function reject() {
  return Object.assign(
    new Error("Telegram private response is no longer eligible"),
    { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
  );
}
function unknown() {
  return Object.assign(
    new Error("Telegram private response acceptance could not be confirmed"),
    { name: "NetworkError", adapter: "telegram" },
  );
}

/** No retries/fallback. Caller retains its credential lease through local I/O settlement. */
export async function sendTelegramCallbackNotice(
  input: { receipt: TelegramCallbackReceipt; text: string; botToken: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ id: string; threadId: string }> {
  const receipt = parseTelegramCallbackReceipt(input.receipt);
  if (
    !receipt ||
    input.text !== TELEGRAM_PRIVATE_ACTION_UNAVAILABLE ||
    !/^[0-9]+:[A-Za-z0-9_-]+$/.test(input.botToken) ||
    input.botToken.split(":")[0] !== receipt.botUserId ||
    Date.now() < receipt.receivedAtMs ||
    Date.now() >= receipt.deadlineAtMs
  )
    throw reject();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(2_000, receipt.deadlineAtMs - Date.now()),
  );
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${encodeURIComponent(input.botToken)}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: receipt.chatId,
          ...(receipt.messageThreadId === null
            ? {}
            : { message_thread_id: receipt.messageThreadId }),
          text: input.text,
          ...(receipt.chatType === "private"
            ? {}
            : {
                ephemeral_message_parameters: {
                  receiver_user_id: Number(receipt.receiverUserId),
                  callback_query_id: receipt.callbackId,
                },
              }),
        }),
      },
    );
    if (!response.body) throw unknown();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16_384) {
          controller.abort();
          await reader.cancel();
          throw unknown();
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw unknown();
  } finally {
    clearTimeout(timer);
  }
  if (!record(body)) throw unknown();
  if (!response.ok || body.ok !== true) {
    if (body.ok !== false || !integer(body.error_code, 100)) throw unknown();
    const status = response.status;
    if (status === 429 && body.error_code === 429) {
      const retryAfter =
        record(body.parameters) && integer(body.parameters.retry_after, 1)
          ? Math.min(body.parameters.retry_after, 3600)
          : 1;
      throw Object.assign(new Error("Telegram private response rate limited"), {
        name: "RateLimitError",
        adapter: "telegram",
        status: 429,
        retryAfter,
      });
    }
    if (status === 401)
      throw Object.assign(new Error("Telegram authentication rejected"), {
        name: "AuthenticationError",
        adapter: "telegram",
        status: 401,
      });
    if (status === 403)
      throw Object.assign(new Error("Telegram destination rejected"), {
        name: "PermissionError",
        code: "PERMISSION_DENIED",
        adapter: "telegram",
        status: 403,
      });
    if (status >= 400 && status < 500) throw reject();
    throw unknown();
  }
  const result = body.result;
  if (
    !record(result) ||
    !record(result.chat) ||
    String(result.chat.id) !== receipt.chatId ||
    (result.message_thread_id ?? null) !== receipt.messageThreadId ||
    !record(result.from) ||
    String(result.from.id) !== receipt.botUserId ||
    result.from.is_bot !== true
  )
    throw unknown();
  if (receipt.chatType === "private") {
    if (
      !integer(result.message_id, 1) ||
      result.chat.type !== "private" ||
      result.receiver_user !== undefined ||
      result.ephemeral_message_id !== undefined
    )
      throw unknown();
    return {
      id: `${receipt.chatId}:${result.message_id}`,
      threadId: telegramCallbackThreadId(receipt),
    };
  }
  if (
    result.message_id !== 0 ||
    !integer(result.ephemeral_message_id, 1) ||
    !record(result.receiver_user) ||
    String(result.receiver_user.id) !== receipt.receiverUserId
  )
    throw unknown();
  // API acceptance is not proof that an online client displayed the message.
  return {
    id: `telegram-ephemeral:${receipt.chatId}:${receipt.receiverUserId}:${receipt.updateId}:${result.ephemeral_message_id}`,
    threadId: telegramCallbackThreadId(receipt),
  };
}
