import { qrImageDataUrl, telegramQrUrl } from "./qr.js";
import type {
  InboundAttachment,
  InboundDirectMessage,
  LiveTelegramAccount,
  PublicTelegramAccount,
  QrLoginHandle,
  TelegramClientFactory,
} from "./types.js";

type GramJsClient = {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  getMe(): Promise<{ id?: unknown; username?: string | null; firstName?: string | null; lastName?: string | null }>;
  sendMessage(peer: string, options: { message: string }): Promise<unknown>;
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
};

type GramJsSessions = {
  StringSession: new (session?: string) => unknown;
};

type GramJsEvents = {
  NewMessage: new (options?: Record<string, unknown>) => unknown;
};

function displayNameFromUser(user: { username?: string | null; firstName?: string | null; lastName?: string | null }): string {
  const parts = [user.firstName, user.lastName].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length > 0) return parts.join(" ");
  if (user.username) return user.username;
  return "Telegram user";
}

function asUserId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  if (value && typeof value === "object" && "value" in value) return asUserId((value as { value: unknown }).value);
  throw new Error("Telegram user id is missing.");
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadGramJs(): Promise<{ client: GramJsModule; sessions: GramJsSessions; events: GramJsEvents }> {
  const [client, sessions, events] = await Promise.all([
    import("telegram") as Promise<unknown> as Promise<GramJsModule>,
    import("telegram/sessions/index.js") as Promise<unknown> as Promise<GramJsSessions>,
    import("telegram/events/index.js") as Promise<unknown> as Promise<GramJsEvents>,
  ]);
  return { client, sessions, events };
}

function readEventMessage(event: unknown): {
  out?: boolean;
  isPrivate?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  id?: unknown;
  message?: unknown;
  peerId?: unknown;
  sender?: { username?: string | null; firstName?: string | null; lastName?: string | null; id?: unknown };
  media?: unknown;
  downloadMedia?: () => Promise<Buffer | Uint8Array | string | null>;
} | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { message?: unknown; isPrivate?: boolean; isGroup?: boolean; isChannel?: boolean };
  if (record.message && typeof record.message === "object") {
    return { ...record, ...(record.message as object) };
  }
  return record;
}

async function collectAttachments(message: NonNullable<ReturnType<typeof readEventMessage>>): Promise<InboundAttachment[]> {
  if (!message.media || typeof message.downloadMedia !== "function") return [];
  const downloaded = await message.downloadMedia();
  if (!downloaded) return [];
  const bytes = typeof downloaded === "string" ? Buffer.from(downloaded) : Buffer.from(downloaded);
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
}

export function createGramJsClientFactory(): TelegramClientFactory {
  return {
    async startQrLogin(input) {
      const gram = await loadGramJs();
      const client = new gram.client.TelegramClient(
        new gram.sessions.StringSession(""),
        input.credentials.apiId,
        input.credentials.apiHash,
        { connectionRetries: 5 },
      );
      await client.connect();
      const password = createDeferred<string>();
      let settled = false;
      const signedIn = client.signInUserWithQrCode(
        { apiId: input.credentials.apiId, apiHash: input.credentials.apiHash },
        {
          qrCode: async (code) => {
            const url = telegramQrUrl(code.token);
            input.onQr(qrImageDataUrl(url));
          },
          password: async (hint) => {
            input.onPasswordRequired(hint ?? null);
            return password.promise;
          },
          onError: () => false,
        },
      ).then(async () => {
        settled = true;
        const me = await client.getMe();
        return {
          session: client.session.save(),
          account: {
            telegramUserId: asUserId(me.id),
            username: me.username ?? null,
            displayName: displayNameFromUser(me),
          } satisfies PublicTelegramAccount,
        };
      });

      const handle: QrLoginHandle = {
        async submitPassword(value) {
          password.resolve(value);
        },
        async waitUntilSignedIn() {
          return signedIn;
        },
        async abort() {
          if (!settled) password.reject(new Error("Telegram login cancelled."));
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
        { connectionRetries: 5 },
      );
      await client.connect();
      const me = await client.getMe();
      const account: PublicTelegramAccount = {
        telegramUserId: asUserId(me.id),
        username: me.username ?? null,
        displayName: displayNameFromUser(me),
      };
      client.addEventHandler(async (event) => {
        const message = readEventMessage(event);
        if (!message) return;
        if (message.out || message.isGroup || message.isChannel || message.isPrivate === false) return;
        const sender = message.sender;
        const peerId = asUserId(sender?.id ?? message.peerId);
        const attachments = await collectAttachments(message);
        const inbound: InboundDirectMessage = {
          companyId: input.companyId,
          accountId: account.telegramUserId,
          peerId,
          peerName: sender ? displayNameFromUser(sender) : peerId,
          messageId: String(message.id ?? ""),
          text: typeof message.message === "string" ? message.message : "",
          isPrivate: true,
          isGroup: false,
          isOutgoing: false,
          attachments,
        };
        await input.onInbound(inbound);
      }, new gram.events.NewMessage({ incoming: true }));

      const live: LiveTelegramAccount = {
        account,
        companyId: input.companyId,
        async sendText(peerId, text) {
          await client.sendMessage(peerId, { message: text });
        },
        async disconnect() {
          await client.disconnect();
        },
      };
      return live;
    },
  };
}
