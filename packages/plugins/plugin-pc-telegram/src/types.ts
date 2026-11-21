import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { DEFAULT_INCOMING_MODE } from "./constants.js";
import type { TelegramMessageAction } from "./message-menu.js";
import type { PeerProfile, PeerSummary } from "./peer-card.js";
import type { ChatBubble } from "./thread.js";

export type IncomingMode = typeof DEFAULT_INCOMING_MODE;

export type TelegramAppCredentials = {
  apiId: number;
  apiHash: string;
};

export type PublicTelegramAccount = {
  telegramUserId: string;
  username: string | null;
  displayName: string;
};

export type TelegramConnection = {
  companyId: string;
  telegramUserId: string;
  username: string | null;
  displayName: string;
  assignedAgentId: string | null;
  incomingMode: IncomingMode;
  paused: boolean;
  /** Board opt-in. Absent stored values stay closed. */
  acceptUnlistedSenders: boolean;
  allowedPeerIds: string[];
  sessionSecretId: string;
  sessionConfigPath?: string;
  live: boolean;
};

export type TelegramConnectionPatch = {
  assignedAgentId?: string | null;
  incomingMode?: IncomingMode;
  paused?: boolean;
  acceptUnlistedSenders?: boolean;
  allowedPeerIds?: string[];
};

export type InboundAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  kind: "file" | "voice" | "photo" | "video";
  bytes: Uint8Array;
};

export type InboundForward = {
  kind: "user" | "hidden" | "channel" | "chat";
  fromId: string | null;
  fromName: string;
  authorName: string | null;
};

export type InboundDirectMessage = {
  companyId: string;
  accountId: string;
  peerId: string;
  peerName: string;
  messageId: string;
  text: string;
  isPrivate: boolean;
  isGroup: boolean;
  isOutgoing: boolean;
  attachments: InboundAttachment[];
  /** Present when the Telegram update names a sender. It must be the dialog peer. */
  senderId?: string;
  senderBot?: boolean;
  forward?: InboundForward | null;
  /** Set when media was refused before download so the caption can keep the reason. */
  mediaSkipped?: boolean;
};

export type LoginQrPayload = {
  imageDataUrl: string;
};

export type LoginStatus =
  | { state: "idle" }
  | { state: "qr_pending"; loginId: string; qr: LoginQrPayload }
  | { state: "password_required"; loginId: string; hint: string | null; message: string | null }
  | { state: "connected"; loginId: string; account: PublicTelegramAccount }
  | { state: "error"; loginId: string; message: string };

export type LoginEvent =
  | { type: "start"; loginId: string }
  | { type: "qr"; loginId: string; qr: LoginQrPayload }
  | { type: "password_required"; loginId: string; hint: string | null; message: string | null }
  | { type: "connected"; loginId: string; account: PublicTelegramAccount }
  | { type: "error"; loginId: string; message: string }
  | { type: "cancel"; loginId: string };

export type SignedInSession = {
  session: string;
  account: PublicTelegramAccount;
};

export type QrLoginHandle = {
  submitPassword(password: string): Promise<void>;
  waitUntilSignedIn(): Promise<SignedInSession>;
  abort(): Promise<void>;
};

export type LiveTelegramAccount = {
  account: PublicTelegramAccount;
  companyId: string;
  sendText(peerId: string, text: string, replyTo?: string): Promise<void>;
  messageAction(peerId: string, action: TelegramMessageAction): Promise<void>;
  readHistory(peerId: string, limit: number, beforeId?: string): Promise<import("./thread.js").ChatBubble[]>;
  peerNames(): Promise<Array<{ id: string; name: string }>>;
  peerName(peerId: string): Promise<string | null>;
  peerSummaries(): Promise<PeerSummary[]>;
  peerProfile(peerId: string): Promise<PeerProfile>;
  disconnect(): Promise<void>;
};

export type InboxPeerUpdate =
  | {
    type: "upsert";
    companyId: string;
    accountId: string;
    peerId: string;
    bubble: ChatBubble;
    inserted: boolean;
  }
  | {
    type: "delete";
    companyId: string;
    accountId: string;
    peerId: string | null;
    messageIds: string[];
  }
  | {
    type: "photo";
    companyId: string;
    accountId: string;
    peerId: string;
    photo: string;
    photoId?: string;
  }
  | {
    type: "gap";
    companyId: string;
    accountId: string;
  };

export type TelegramClientFactory = {
  startQrLogin(input: {
    credentials: TelegramAppCredentials;
    deviceModel: string;
    onQr: (qr: LoginQrPayload) => void;
    onPasswordRequired: (hint: string | null, message: string | null) => void;
  }): Promise<QrLoginHandle>;
  connectFromSession(input: {
    companyId: string;
    credentials: TelegramAppCredentials;
    session: string;
    deviceModel: string;
    onInbound: (message: InboundDirectMessage) => Promise<void>;
    onInboxUpdate?: (update: InboxPeerUpdate) => void;
    allowInboundMedia?: (input: { accountId: string; peerId: string; declaredBytes: number }) => Promise<boolean> | boolean;
  }): Promise<LiveTelegramAccount>;
};

export type PluginConfigShape = {
  apiId?: string | EnvSecretRefBinding;
  apiHash?: string | EnvSecretRefBinding;
};

export type ResolveAppCredentials = (
  companyId: string,
) => Promise<TelegramAppCredentials>;
