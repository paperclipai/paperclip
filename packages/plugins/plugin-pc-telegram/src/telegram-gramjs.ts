import { describeInboundForward, publicForward, unknownForward, visibleForwardName, type TelegramForwardSource } from "./forward.js";
import { directUserPeerId } from "./inbound.js";
import {
  hasProfilePhoto,
  inlineProfilePhoto,
  photoDataUrl,
  profilePhotoId,
  presenceFromStatus,
  previewFromMessage,
  publicAbout,
  publicChannelTitle,
  publicPhone,
  publicSharedChats,
  publicUsername,
  remainingPhotoBudget,
  rememberProfilePhoto,
  unreadCount,
  type PeerProfile,
  type PeerSummary,
  type ProfilePhotoMemory,
} from "./peer-card.js";
import { compareTelegramMessageOrder } from "./history-slice.js";
import { mapTelegramMessage, type ChatBubble, type TelegramHistoryMessage } from "./thread.js";
import { createLoginPasswordGate } from "./password-gate.js";
import { qrImageDataUrl, telegramQrUrl } from "./qr.js";
import type { TelegramMessageAction } from "./message-menu.js";
import type {
  InboundAttachment,
  InboundDirectMessage,
  InboundForward,
  InboxPeerUpdate,
  LiveTelegramAccount,
  PublicTelegramAccount,
  QrLoginHandle,
  TelegramClientFactory,
} from "./types.js";

type GramJsClient = {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  getMe(): Promise<{ id?: unknown; username?: string | null; firstName?: string | null; lastName?: string | null }>;
  sendMessage(peer: string, options: { message: string; replyTo?: number }): Promise<unknown>;
  pinMessage?(peer: unknown, messageId: number, params?: { notify?: boolean; pmOneSide?: boolean }): Promise<unknown>;
  unpinMessage?(peer: unknown, messageId: number): Promise<unknown>;
  deleteMessages?(peer: unknown, messageIds: number[], params?: { revoke?: boolean }): Promise<unknown>;
  forwardMessages?(peer: unknown, params: { messages: number[]; fromPeer: unknown }): Promise<unknown>;
  getInputEntity?(peer: string): Promise<unknown>;
  getEntity?(peer: unknown): Promise<unknown>;
  getDialogs?(options: { limit: number }): Promise<unknown[]>;
  invoke?(query: unknown): Promise<unknown>;
  downloadProfilePhoto?(entity: unknown, params?: { isBig?: boolean }): Promise<Uint8Array>;
  getMessages(peer: unknown, options: { limit: number; maxId?: number }): Promise<unknown[]>;
  addEventHandler(handler: (event: unknown) => unknown, event: unknown): void;
  session: { save(): string };
  signInUserWithQrCode(
    auth: { apiId: number; apiHash: string },
    callbacks: {
      qrCode?: (code: { token: Uint8Array }) => Promise<void> | void;
      password?: (hint?: string) => Promise<string> | string;
      onError?: (error: unknown) => boolean | Promise<boolean>;
    },
  ): Promise<unknown>;
};

type GramJsModule = {
  TelegramClient: new (
    session: unknown,
    apiId: number,
    apiHash: string,
    options?: Record<string, unknown>,
  ) => GramJsClient;
  Api?: {
    users?: {
      GetFullUser: new (args: { id: unknown }) => unknown;
    };
    ReactionEmoji?: new (args: { emoticon: string }) => unknown;
    messages?: {
      SendReaction: new (args: {
        peer: unknown;
        msgId: number;
        reaction?: unknown[];
        addToRecent?: boolean;
      }) => unknown;
    };
  };
};

type GramJsSessions = {
  StringSession: new (session?: string) => unknown;
};

type GramJsEvents = {
  NewMessage: new (options?: Record<string, unknown>) => unknown;
};

type GramEventCtor = new (options?: Record<string, unknown>) => unknown;

function entityLabel(entity: unknown): string {
  if (!entity || typeof entity !== "object") return "";
  const record = entity as {
    title?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    username?: unknown;
  };
  const named = displayNameFromUser({
    firstName: typeof record.firstName === "string" ? record.firstName : null,
    lastName: typeof record.lastName === "string" ? record.lastName : null,
    username: typeof record.username === "string" ? record.username : null,
  });
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const chosen = named && named !== "Telegram user" ? named : title;
  if (!chosen || /^\d{5,}$/.test(chosen)) return "";
  return chosen.slice(0, 80);
}

function peerIdOf(value: unknown): string {
  try {
    return telegramUserId(value);
  } catch {
    return "";
  }
}

function displayNameFromUser(user: { username?: string | null; firstName?: string | null; lastName?: string | null }): string {
  const parts = [user.firstName, user.lastName].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length > 0) return parts.join(" ");
  if (user.username) return user.username;
  return "Telegram user";
}

export function telegramUserId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value).trim();
    if (text.length > 0 && text !== "[object Object]") return text;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // PeerUser / PeerChat / PeerChannel keep the id on a field. A big-integer
    // object stringifies to the decimal id, while its `.value` is a digit array.
    if ("userId" in record) return telegramUserId(record.userId);
    if ("chatId" in record) return telegramUserId(record.chatId);
    if ("channelId" in record) return telegramUserId(record.channelId);
    const text = String(value).trim();
    if (/^[0-9]+$/.test(text)) return text;
    const inner = record.value;
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "bigint") {
      return telegramUserId(inner);
    }
  }
  throw new Error("Telegram user id is missing.");
}

function accountFromGramUser(user: unknown): PublicTelegramAccount {
  if (!user || typeof user !== "object") throw new Error("Telegram did not return the signed-in user.");
  const record = user as {
    id?: unknown;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  return {
    telegramUserId: telegramUserId(record.id),
    username: record.username ?? null,
    displayName: displayNameFromUser(record),
  };
}

function telegramErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("errorMessage" in error)) return "";
  const code = (error as { errorMessage?: unknown }).errorMessage;
  return typeof code === "string" ? code : "";
}

async function loadGramJs(): Promise<{
  client: GramJsModule;
  sessions: GramJsSessions;
  events: GramJsEvents;
  edited: GramEventCtor;
  deleted: GramEventCtor;
  raw: GramEventCtor;
}> {
  const [client, sessions, events, edited, deleted, raw] = await Promise.all([
    import("telegram") as Promise<unknown> as Promise<GramJsModule>,
    import("telegram/sessions/index.js") as Promise<unknown> as Promise<GramJsSessions>,
    import("telegram/events/index.js") as Promise<unknown> as Promise<GramJsEvents>,
    import("telegram/events/EditedMessage.js") as Promise<{ EditedMessage: GramEventCtor }>,
    import("telegram/events/DeletedMessage.js") as Promise<{ DeletedMessage: GramEventCtor }>,
    import("telegram/events/Raw.js") as Promise<{ Raw: GramEventCtor }>,
  ]);
  return {
    client,
    sessions,
    events,
    edited: edited.EditedMessage,
    deleted: deleted.DeletedMessage,
    raw: raw.Raw,
  };
}

type GramMessage = {
  out?: boolean;
  isPrivate?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  id?: unknown;
  message?: unknown;
  date?: unknown;
  peerId?: unknown;
  sender?: { username?: string | null; firstName?: string | null; lastName?: string | null; id?: unknown; bot?: boolean };
  media?: unknown;
  downloadMedia?: (progress?: (downloaded: number, total?: number) => void) => Promise<Buffer | Uint8Array | string | null>;
  fwdFrom?: {
    fromId?: unknown;
    fromName?: string | null;
    postAuthor?: string | null;
  } | null;
  forward?: {
    sender?: TelegramForwardSource["sender"];
    chat?: TelegramForwardSource["chat"];
    getSender?: () => Promise<unknown>;
    getChat?: () => Promise<unknown>;
  } | null;
};

function readEventMessage(event: unknown): GramMessage | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { message?: unknown; isPrivate?: boolean; isGroup?: boolean; isChannel?: boolean };
  // GramJS messages expose peerId, sender, and isPrivate as prototype getters.
  // Copying the instance drops those getters and every inbound DM then dies
  // with "Telegram user id is missing."
  if (record.message && typeof record.message === "object") {
    return record.message as NonNullable<ReturnType<typeof readEventMessage>>;
  }
  return record;
}

export function telegramUpdatePeerId(event: unknown): string {
  const message = readEventMessage(event);
  if (!message) throw new Error("Telegram user id is missing.");
  return telegramUserId(message.sender?.id ?? message.peerId);
}

function asNamedEntity(value: unknown): TelegramForwardSource["sender"] {
  if (!value || typeof value !== "object") return null;
  return value as NonNullable<TelegramForwardSource["sender"]>;
}

async function readHistoryForward(message: GramMessage): Promise<InboundForward | null> {
  if (!message.fwdFrom && !message.forward) return null;
  const inline = describeInboundForward({
    fromId: message.fwdFrom?.fromId,
    fromName: message.fwdFrom?.fromName,
    postAuthor: message.fwdFrom?.postAuthor,
    sender: message.forward?.sender ?? null,
    chat: message.forward?.chat ?? null,
  });
  if ((inline && visibleForwardName(inline.fromName)) || message.forward?.sender || message.forward?.chat) {
    return inline ?? unknownForward();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const looked = await Promise.race([
      readInboundForward(message),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 250);
      }),
    ]);
    return looked ?? inline ?? unknownForward();
  } catch {
    return inline ?? unknownForward();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readInboundForward(message: GramMessage): Promise<InboundForward | null> {
  if (!message.fwdFrom && !message.forward) return null;
  let sender = message.forward?.sender ?? null;
  let chat = message.forward?.chat ?? null;
  if (!sender && message.forward?.getSender) {
    try {
      sender = asNamedEntity(await message.forward.getSender()) ?? null;
    } catch {
      sender = null;
    }
  }
  if (!sender && !chat && message.forward?.getChat) {
    try {
      chat = asNamedEntity(await message.forward.getChat()) ?? null;
    } catch {
      chat = null;
    }
  }
  return describeInboundForward({
    fromId: message.fwdFrom?.fromId,
    fromName: message.fwdFrom?.fromName,
    postAuthor: message.fwdFrom?.postAuthor,
    sender,
    chat,
  }) ?? unknownForward();
}

const MAX_INBOUND_MEDIA_BYTES = 4 * 1024 * 1024;
const MEDIA_CONCURRENCY = 2;
let mediaInFlight = 0;
const mediaQueue: Array<() => void> = [];

function takeMediaSlot(): Promise<void> {
  if (mediaInFlight < MEDIA_CONCURRENCY) {
    mediaInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    mediaQueue.push(() => {
      mediaInFlight += 1;
      resolve();
    });
  });
}

function freeMediaSlot(): void {
  mediaInFlight = Math.max(0, mediaInFlight - 1);
  const next = mediaQueue.shift();
  if (next) next();
}

function asByteCount(value: unknown): number {
  const count = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number.NaN;
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function declaredMediaBytes(media: unknown): number {
  if (!media || typeof media !== "object") return 0;
  const record = media as {
    size?: unknown;
    document?: { size?: unknown };
    photo?: { sizes?: Array<{ size?: unknown }> };
  };
  let photo = 0;
  for (const size of record.photo?.sizes ?? []) photo = Math.max(photo, asByteCount(size?.size));
  return Math.max(asByteCount(record.size), asByteCount(record.document?.size), photo);
}

export async function assembleInboundMessage(
  event: unknown,
  input: {
    companyId: string;
    accountId: string;
    allowMedia?: (request: { accountId: string; peerId: string; declaredBytes: number }) => Promise<boolean> | boolean;
  },
): Promise<InboundDirectMessage | null> {
  const message = readEventMessage(event);
  if (!message) return null;
  if (message.out || message.isGroup || message.isChannel || message.isPrivate === false) return null;
  const sender = message.sender;
  const senderId = sender?.id == null ? "" : telegramUserId(sender.id);
  const dialogPeerId = message.peerId == null ? "" : peerIdOf(message.peerId);
  const peerId = senderId || dialogPeerId;
  if (!peerId) throw new Error("Telegram user id is missing.");
  if (sender?.bot === true || !directUserPeerId(peerId) || (senderId !== "" && dialogPeerId !== "" && senderId !== dialogPeerId)) {
    return null;
  }
  const text = typeof message.message === "string" ? message.message : "";
  const hasMedia = Boolean(message.media) && typeof message.downloadMedia === "function";
  let attachments: InboundAttachment[] = [];
  let mediaSkipped = false;
  if (hasMedia) {
    const declaredBytes = declaredMediaBytes(message.media);
    let allowed = true;
    if (input.allowMedia) {
      try {
        allowed = Boolean(await input.allowMedia({
          accountId: input.accountId,
          peerId,
          declaredBytes,
        }));
      } catch {
        allowed = false;
      }
    }
    if (allowed) attachments = await collectAttachments(message);
    else mediaSkipped = true;
    if (!allowed && text.trim().length === 0) return null;
  }
  const forward = await readInboundForward(message);
  return {
    companyId: input.companyId,
    accountId: input.accountId,
    peerId,
    peerName: sender ? displayNameFromUser(sender) : peerId,
    messageId: String(message.id ?? ""),
    text,
    isPrivate: true,
    isGroup: false,
    isOutgoing: false,
    attachments,
    senderId: senderId || undefined,
    mediaSkipped,
    forward,
  };
}

async function collectAttachments(message: NonNullable<ReturnType<typeof readEventMessage>>): Promise<InboundAttachment[]> {
  try {
    if (!message.media || typeof message.downloadMedia !== "function") return [];
    if (declaredMediaBytes(message.media) > MAX_INBOUND_MEDIA_BYTES) return [];
    await takeMediaSlot();
    try {
      const downloaded = await message.downloadMedia((loaded) => {
        if (loaded > MAX_INBOUND_MEDIA_BYTES) {
          throw new Error(`Attachment exceeds ${MAX_INBOUND_MEDIA_BYTES} bytes`);
        }
      });
      if (!downloaded) return [];
      const bytes = typeof downloaded === "string" ? Buffer.from(downloaded) : Buffer.from(downloaded);
      if (bytes.byteLength > MAX_INBOUND_MEDIA_BYTES) return [];
      const media = message.media as { className?: string; mimeType?: string; fileName?: string };
      const className = media.className ?? "";
      const kind = className.includes("Document") && (media.mimeType ?? "").startsWith("audio/")
        ? "voice"
        : className.includes("Photo")
          ? "photo"
          : className.includes("Document") && (media.mimeType ?? "").startsWith("video/")
            ? "video"
            : "file";
      return [{
        id: `${String(message.id ?? "media")}-${bytes.byteLength}`,
        filename: media.fileName ?? (kind === "voice" ? "voice.ogg" : kind === "photo" ? "photo.jpg" : "attachment.bin"),
        mimeType: media.mimeType ?? "application/octet-stream",
        byteLength: bytes.byteLength,
        kind,
        bytes,
      }];
    } finally {
      freeMediaSlot();
    }
  } catch {
    return [];
  }
}

function synchronousForward(message: GramMessage): InboundForward | null {
  if (!message.fwdFrom && !message.forward) return null;
  const inline = describeInboundForward({
    fromId: message.fwdFrom?.fromId,
    fromName: message.fwdFrom?.fromName,
    postAuthor: message.fwdFrom?.postAuthor,
    sender: message.forward?.sender ?? null,
    chat: message.forward?.chat ?? null,
  });
  if (!inline) return null;
  if (visibleForwardName(inline.fromName) || message.forward?.sender || message.forward?.chat) return inline;
  return null;
}

function bubbleFromGram(message: GramMessage): ChatBubble | null {
  const bubble = mapTelegramMessage(message as TelegramHistoryMessage);
  if (!bubble) return null;
  const inline = synchronousForward(message);
  if (inline) bubble.forward = publicForward(inline);
  return bubble;
}

type InboxNotifyPayload = {
  [K in InboxPeerUpdate["type"]]: Omit<Extract<InboxPeerUpdate, { type: K }>, "companyId" | "accountId">;
}[InboxPeerUpdate["type"]];

type InboxNotify = (update: InboxNotifyPayload) => void;

function scheduleForward(message: GramMessage, peerId: string, bubble: ChatBubble, notify: InboxNotify) {
  if (bubble.forward || (!message.fwdFrom && !message.forward)) return;
  void readHistoryForward(message).then((forward) => {
    if (!forward) return;
    notify({
      type: "upsert",
      peerId,
      inserted: false,
      bubble: { ...bubble, forward: publicForward(forward) },
    });
  }).catch(() => undefined);
}

function bindInboxUpdates(
  client: GramJsClient,
  gram: Awaited<ReturnType<typeof loadGramJs>>,
  notify: InboxNotify,
) {
  const onMessage = (event: unknown, inserted: boolean) => {
    try {
      const message = readEventMessage(event);
      if (!message || message.isGroup || message.isChannel || message.isPrivate === false) return;
      const peerId = telegramUserId(message.peerId);
      const bubble = bubbleFromGram(message);
      if (!bubble) return;
      notify({ type: "upsert", peerId, bubble, inserted });
      scheduleForward(message, peerId, bubble, notify);
    } catch {
      // A profile or id miss must not drop the live update loop.
    }
  };
  client.addEventHandler((event) => onMessage(event, true), new gram.events.NewMessage({}));
  client.addEventHandler((event) => onMessage(event, false), new gram.edited({}));
  client.addEventHandler((event) => {
    const record = event as { deletedIds?: unknown[]; peer?: unknown };
    const messageIds = Array.isArray(record.deletedIds)
      ? record.deletedIds.map((id) => String(id)).filter((id) => /^\d{1,16}$/.test(id))
      : [];
    if (messageIds.length === 0) return;
    let peerId: string | null = null;
    try {
      if (record.peer != null) peerId = telegramUserId(record.peer);
    } catch {
      peerId = null;
    }
    notify({ type: "delete", peerId, messageIds });
  }, new gram.deleted({}));
  let broken = false;
  client.addEventHandler((update) => {
    const record = update as { className?: unknown; state?: unknown };
    if (record.className === "UpdatesTooLong") {
      notify({ type: "gap" });
      return;
    }
    if (typeof record.state !== "number") return;
    if (record.state !== 1) {
      broken = true;
      return;
    }
    if (!broken) return;
    broken = false;
    notify({ type: "gap" });
  }, new gram.raw({}));
}

const SESSION_DEVICE_MODEL_MAX = 64;

export function telegramSessionDeviceModel(companyName: string | null | undefined): string {
  const cleaned = (companyName ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "Paperclip").slice(0, SESSION_DEVICE_MODEL_MAX);
}

function gramClientOptions(deviceModel: string) {
  return {
    connectionRetries: 5,
    deviceModel: telegramSessionDeviceModel(deviceModel),
  };
}

export function createGramJsClientFactory(): TelegramClientFactory {
  return {
    async startQrLogin(input) {
      const gram = await loadGramJs();
      const client = new gram.client.TelegramClient(
        new gram.sessions.StringSession(""),
        input.credentials.apiId,
        input.credentials.apiHash,
        gramClientOptions(input.deviceModel),
      );
      await client.connect();
      const passwords = createLoginPasswordGate();
      let settled = false;
      const signedIn = client.signInUserWithQrCode(
        { apiId: input.credentials.apiId, apiHash: input.credentials.apiHash },
        {
          qrCode: async (code) => {
            const url = telegramQrUrl(code.token);
            input.onQr(qrImageDataUrl(url));
          },
          password: async (hint) => passwords.ask((message) => {
            input.onPasswordRequired(hint ?? null, message);
          }),
          onError: (error) => {
            if (passwords.wasCancelled()) return true;
            const code = telegramErrorCode(error);
            if (code === "PASSWORD_HASH_INVALID") {
              passwords.noteFailure("Cloud password was not accepted.");
              return false;
            }
            if (code === "SRP_ID_INVALID") return false;
            passwords.noteStop(code ? `Telegram login failed (${code}).` : "Telegram login failed.");
            return true;
          },
        },
      ).then(async (user) => {
        settled = true;
        const session = client.session.save();
        const account = accountFromGramUser(user);
        await client.disconnect().catch(() => undefined);
        if (!session) throw new Error("Telegram session was empty after login.");
        return { session, account };
      });
      const finished = signedIn.then(
        (value) => value,
        (error: unknown) => {
          const reason = passwords.stopMessage();
          throw new Error(reason ?? (error instanceof Error ? error.message : "Telegram login failed."));
        },
      );

      const handle: QrLoginHandle = {
        async submitPassword(value) {
          passwords.submit(value);
        },
        async waitUntilSignedIn() {
          return finished;
        },
        async abort() {
          if (!settled) passwords.cancel();
          await client.disconnect().catch(() => undefined);
        },
      };
      return handle;
    },

    async connectFromSession(input) {
      const gram = await loadGramJs();
      const client = new gram.client.TelegramClient(
        new gram.sessions.StringSession(input.session),
        input.credentials.apiId,
        input.credentials.apiHash,
        gramClientOptions(input.deviceModel),
      );
      await client.connect();
      const me = await client.getMe();
      const account: PublicTelegramAccount = {
        telegramUserId: telegramUserId(me.id),
        username: me.username ?? null,
        displayName: displayNameFromUser(me),
      };
      client.addEventHandler(async (event) => {
        try {
          const inbound = await assembleInboundMessage(event, {
            companyId: input.companyId,
            accountId: account.telegramUserId,
            allowMedia: input.allowInboundMedia,
          });
          if (!inbound) return;
          await input.onInbound(inbound);
        } catch (error) {
          console.error(error instanceof Error ? error.message : "Telegram inbound failed.");
        }
      }, new gram.events.NewMessage({ incoming: true }));

      const notifyInbox: InboxNotify = (update) => {
        input.onInboxUpdate?.({
          ...update,
          companyId: input.companyId,
          accountId: account.telegramUserId,
        } as InboxPeerUpdate);
      };
      bindInboxUpdates(client, gram, notifyInbox);

      const photos = new Map<string, { small?: ProfilePhotoMemory; big?: ProfilePhotoMemory; photoId?: string }>();
      const UsersApi = gram.client.Api?.users;
      const listPhotoBytes = 160_000;

      function photoChanged(slot: { photoId?: string }, entity: unknown): boolean {
        const photoId = profilePhotoId(entity);
        return Boolean(photoId) && Boolean(slot.photoId) && slot.photoId !== photoId;
      }

      function notePhotoId(slot: { photoId?: string }, entity: unknown): void {
        const photoId = profilePhotoId(entity);
        if (photoId) slot.photoId = photoId;
      }

      function seededListPhoto(entity: unknown, peerId: string): string | null {
        const slot = photos.get(peerId) ?? {};
        const changed = photoChanged(slot, entity);
        if (changed) {
          slot.small = undefined;
          slot.big = undefined;
        }
        notePhotoId(slot, entity);
        photos.set(peerId, slot);
        if (!changed && slot.small?.value) return slot.small.value;
        const inline = inlineProfilePhoto(entity);
        if (!inline) return null;
        const noted = rememberProfilePhoto(slot.small, { downloaded: null, fallback: inline, knownEmpty: false });
        slot.small = noted.memory;
        photos.set(peerId, slot);
        return noted.photo;
      }

      async function cachedPhoto(entity: unknown, peerId: string, big: boolean): Promise<string | null> {
        const slot = photos.get(peerId) ?? {};
        const changed = photoChanged(slot, entity);
        if (changed) {
          const previous = slot.small?.value ?? slot.big?.value ?? null;
          slot.small = previous ? { value: previous, ready: false } : undefined;
          slot.big = undefined;
        }
        notePhotoId(slot, entity);
        photos.set(peerId, slot);
        const key = big ? "big" : "small";
        const current = slot[key];
        if (current?.ready && !changed) return current.value;
        const download = client.downloadProfilePhoto;
        const canDownload = Boolean(download) && hasProfilePhoto(entity);
        let downloaded: string | null = null;
        if (download && canDownload) {
          try {
            const bytes = await download(entity, { isBig: big });
            downloaded = photoDataUrl(bytes, big ? 280_000 : listPhotoBytes);
          } catch {
            downloaded = null;
          }
        }
        const noted = rememberProfilePhoto(current, {
          downloaded,
          fallback: big ? null : inlineProfilePhoto(entity),
          knownEmpty: !canDownload,
        });
        slot[key] = noted.memory;
        return noted.photo;
      }

      const live: LiveTelegramAccount = {
        account,
        companyId: input.companyId,
        async sendText(peerId, text, replyTo) {
          const reply = typeof replyTo === "string" && /^\d{1,16}$/.test(replyTo) ? Number(replyTo) : 0;
          await client.sendMessage(peerId, reply > 0 ? { message: text, replyTo: reply } : { message: text });
        },
        async messageAction(peerId, action: TelegramMessageAction) {
          const peer = client.getInputEntity ? await client.getInputEntity(peerId) : peerId;
          if (action.op === "react") {
            const Reaction = gram.client.Api?.ReactionEmoji;
            const SendReaction = gram.client.Api?.messages?.SendReaction;
            if (!client.invoke || !Reaction || !SendReaction) throw new Error("Telegram reactions are unavailable.");
            await client.invoke(new SendReaction({
              peer,
              msgId: Number(action.messageId),
              reaction: action.emoji ? [new Reaction({ emoticon: action.emoji })] : [],
              addToRecent: Boolean(action.emoji),
            }));
            return;
          }
          if (action.op === "pin") {
            if (action.unpin) {
              if (!client.unpinMessage) throw new Error("Telegram pin is unavailable.");
              await client.unpinMessage(peer, Number(action.messageId));
              return;
            }
            if (!client.pinMessage) throw new Error("Telegram pin is unavailable.");
            await client.pinMessage(peer, Number(action.messageId), { notify: false, pmOneSide: false });
            return;
          }
          if (action.op === "delete") {
            if (!client.deleteMessages) throw new Error("Telegram delete is unavailable.");
            await client.deleteMessages(peer, action.messageIds.map((id) => Number(id)), { revoke: action.revoke });
            return;
          }
          if (!client.forwardMessages) throw new Error("Telegram forward is unavailable.");
          const target = client.getInputEntity ? await client.getInputEntity(action.targetPeerId) : action.targetPeerId;
          await client.forwardMessages(target, {
            messages: action.messageIds.map((id) => Number(id)),
            fromPeer: peer,
          });
        },
        async readHistory(peerId, limit, beforeId) {
          const bounded = Math.max(1, Math.min(40, Math.floor(limit) || 40));
          const peer = client.getInputEntity ? await client.getInputEntity(peerId) : peerId;
          let cursor = typeof beforeId === "string" && /^\d{1,16}$/.test(beforeId) ? Number(beforeId) : 0;
          const bubbles: ChatBubble[] = [];
          const seen = new Set<string>();
          for (let pass = 0; pass < 8 && bubbles.length < bounded; pass += 1) {
            const raw = await client.getMessages(peer, cursor > 0 ? { limit: bounded, maxId: cursor } : { limit: bounded });
            const page = Array.isArray(raw) ? raw : [];
            if (page.length === 0) break;
            let oldest = 0;
            for (const message of page) {
              if (!message || typeof message !== "object") continue;
              const gramMessage = message as GramMessage;
              const idNum = Number(gramMessage.id);
              if (Number.isFinite(idNum) && idNum > 0 && (oldest === 0 || idNum < oldest)) oldest = idNum;
              const bubble = bubbleFromGram(gramMessage);
              if (!bubble || seen.has(bubble.id)) continue;
              seen.add(bubble.id);
              bubbles.push(bubble);
              scheduleForward(gramMessage, peerId, bubble, notifyInbox);
            }
            if (bubbles.length >= bounded || page.length < bounded || oldest === 0 || oldest === cursor) break;
            cursor = oldest;
          }
          bubbles.sort(compareTelegramMessageOrder);
          return bubbles.slice(-bounded);
        },
        async peerNames() {
          if (!client.getDialogs) return [];
          const dialogs = await client.getDialogs({ limit: 50 });
          const rows: Array<{ id: string; name: string }> = [];
          for (const dialog of dialogs) {
            if (!dialog || typeof dialog !== "object") continue;
            const record = dialog as { id?: unknown; name?: unknown; entity?: unknown; isUser?: boolean };
            if (record.isUser === false) continue;
            let id = "";
            try {
              id = telegramUserId(record.id);
            } catch {
              continue;
            }
            const fromEntity = entityLabel(record.entity);
            const fromTitle = typeof record.name === "string" ? record.name.trim() : "";
            const name = fromEntity || (!/^\d{5,}$/.test(fromTitle) ? fromTitle : "");
            if (!id || !name) continue;
            rows.push({ id, name: name.slice(0, 80) });
          }
          return rows;
        },
        async peerName(peerId) {
          if (!client.getEntity) return null;
          try {
            const name = entityLabel(await client.getEntity(peerId));
            return name || null;
          } catch {
            return null;
          }
        },
        async peerSummaries() {
          if (!client.getDialogs) return [];
          const dialogs = await client.getDialogs({ limit: 50 });
          const rows: PeerSummary[] = [];
          const photoQueue: Array<{ id: string; entity: unknown }> = [];
          for (const dialog of dialogs) {
            if (!dialog || typeof dialog !== "object") continue;
            const record = dialog as {
              id?: unknown;
              name?: unknown;
              title?: unknown;
              entity?: unknown;
              isUser?: boolean;
              message?: unknown;
              unreadCount?: unknown;
            };
            if (record.isUser === false) continue;
            const id = peerIdOf(record.id);
            const fromEntity = entityLabel(record.entity);
            const fromTitle = typeof record.name === "string"
              ? record.name.trim()
              : typeof record.title === "string"
                ? record.title.trim()
                : "";
            const name = fromEntity || (!/^\d{5,}$/.test(fromTitle) ? fromTitle : "");
            if (!id || !name) continue;
            const photo = seededListPhoto(record.entity, id);
            const known = photos.get(id);
            const stalePhoto = Boolean(known?.photoId) && known?.photoId !== profilePhotoId(record.entity);
            if (hasProfilePhoto(record.entity) && (!known?.small?.ready || stalePhoto)) {
              photoQueue.push({ id, entity: record.entity });
            }
            const entity = record.entity && typeof record.entity === "object"
              ? record.entity as { status?: unknown }
              : null;
            const mapped = record.message && typeof record.message === "object"
              ? mapTelegramMessage(record.message as TelegramHistoryMessage)
              : null;
            rows.push({
              id,
              name: name.slice(0, 80),
              preview: previewFromMessage(record.message),
              unread: unreadCount(record.unreadCount),
              photo,
              photoId: profilePhotoId(record.entity),
              presence: presenceFromStatus(entity?.status),
              activityAt: mapped?.at ?? "",
            });
          }
          if (photoQueue.length > 0) {
            void (async () => {
              let photosLeft = 24;
              for (const job of photoQueue) {
                if (photosLeft <= 0) break;
                const before = photos.get(job.id)?.small?.value ?? null;
                const photo = await cachedPhoto(job.entity, job.id, false);
                const ready = photos.get(job.id)?.small?.ready === true;
                photosLeft = remainingPhotoBudget(photosLeft, photo, ready);
                if (photo && photo !== before) {
                  notifyInbox({ type: "photo", peerId: job.id, photo, photoId: profilePhotoId(job.entity) });
                }
              }
            })();
          }
          return rows;
        },
        async peerProfile(peerId) {
          if (!client.getEntity) throw new Error("Telegram profile is unavailable");
          let entity: unknown;
          try {
            entity = await client.getEntity(peerId);
          } catch {
            throw new Error("Telegram profile is unavailable");
          }
          let fullUser: Record<string, unknown> | null = null;
          let fullUsers: unknown[] = [];
          let fullChats: unknown[] = [];
          if (client.invoke && UsersApi) {
            try {
              const result = await client.invoke(new UsersApi.GetFullUser({ id: entity }));
              if (result && typeof result === "object") {
                const packed = result as { fullUser?: unknown; users?: unknown; chats?: unknown };
                if (packed.fullUser && typeof packed.fullUser === "object") {
                  fullUser = packed.fullUser as Record<string, unknown>;
                }
                if (Array.isArray(packed.users)) fullUsers = packed.users;
                if (Array.isArray(packed.chats)) fullChats = packed.chats;
              }
            } catch {
              fullUser = null;
            }
          }
          const user = fullUsers.find((item) => item && typeof item === "object") ?? entity;
          const record = user && typeof user === "object" ? user as Record<string, unknown> : {};
          const name = entityLabel(user) || entityLabel(entity) || "Telegram";
          let channel: string | null = null;
          const wanted = peerIdOf(fullUser?.personalChannelId);
          if (wanted) {
            for (const chat of fullChats) {
              if (peerIdOf((chat as { id?: unknown }).id) !== wanted) continue;
              channel = publicChannelTitle(entityLabel(chat));
              break;
            }
          }
          const profile: PeerProfile = {
            name,
            username: publicUsername(record.username),
            phone: publicPhone(record.phone),
            about: publicAbout(fullUser?.about),
            photo: await cachedPhoto(record.photo ? user : entity, peerIdOf(record.id) || peerId, true),
            presence: presenceFromStatus(record.status ?? (entity as { status?: unknown }).status),
            channel,
            sharedChats: publicSharedChats(fullUser?.commonChatsCount),
          };
          return profile;
        },
        async disconnect() {
          await client.disconnect();
        },
      };
      return live;
    },
  };
}
