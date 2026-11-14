import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { DEFAULT_INCOMING_MODE } from "./constants.js";

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
  sessionSecretId: string;
  live: boolean;
};

export type TelegramConnectionPatch = {
  assignedAgentId?: string | null;
  incomingMode?: IncomingMode;
  paused?: boolean;
};

export type InboundAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  kind: "file" | "voice" | "photo" | "video";
  bytes: Uint8Array;
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
};

export type LoginQrPayload = {
  imageDataUrl: string;
};

export type LoginStatus =
  | { state: "idle" }
  | { state: "qr_pending"; loginId: string; qr: LoginQrPayload }
  | { state: "password_required"; loginId: string; hint: string | null }
  | { state: "connected"; loginId: string; account: PublicTelegramAccount }
  | { state: "error"; loginId: string; message: string };

export type LoginEvent =
  | { type: "start"; loginId: string }
  | { type: "qr"; loginId: string; qr: LoginQrPayload }
  | { type: "password_required"; loginId: string; hint: string | null }
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
  sendText(peerId: string, text: string): Promise<void>;
  disconnect(): Promise<void>;
};

export type TelegramClientFactory = {
  startQrLogin(input: {
    credentials: TelegramAppCredentials;
    onQr: (qr: LoginQrPayload) => void;
    onPasswordRequired: (hint: string | null) => void;
  }): Promise<QrLoginHandle>;
  connectFromSession(input: {
    companyId: string;
    credentials: TelegramAppCredentials;
    session: string;
    onInbound: (message: InboundDirectMessage) => Promise<void>;
  }): Promise<LiveTelegramAccount>;
};

export type PluginConfigShape = {
  apiId?: string | EnvSecretRefBinding;
  apiHash?: string | EnvSecretRefBinding;
};

export type ResolveAppCredentials = (
  companyId: string,
) => Promise<TelegramAppCredentials>;
