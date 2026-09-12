import { PhotonRecoveryTransport } from "./recovery-transport.js";
import { createHash } from "node:crypto";
import {
  createGrpcClient,
  type GrpcAdvancedIMessage,
  type Message as PhotonMessage,
  type Chat as PhotonChat,
} from "@photon-ai/advanced-imessage";
import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FileUpload,
  type FormattedContent,
  type FetchOptions,
  type ThreadInfo,
  type Attachment,
} from "chat";
import {
  PhotonLineAuthentication,
  PhotonError,
  photonFailure,
} from "./cloud.js";
import { PhotonState } from "./state.js";
import {
  downloadPhotonAttachment,
  type PhotonAttachmentLocator,
} from "./attachments.js";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";

export interface PhotonThread {
  lineId: string;
  chatGuid: string;
  isGroup: boolean;
}
interface SendRecord {
  schema: 1;
  digest: string;
  phase: "prepared" | "uploading" | "uploaded" | "sending" | "sent";
  attachmentGuid?: string;
  messageGuid?: string;
}
export function photonThreadId(value: PhotonThread): string {
  return `imessage-photon:${value.lineId}:${value.isGroup ? "g" : "d"}:${Buffer.from(value.chatGuid).toString("base64url")}`;
}
export function parsePhotonThreadId(value: string): PhotonThread {
  const match =
    /^imessage-photon:([a-zA-Z0-9-]{1,63}):(d|g):([a-zA-Z0-9_-]{1,1024})$/.exec(
      value,
    );
  if (!match) throw new Error("Invalid Photon conversation identity");
  const chatGuid = Buffer.from(match[3], "base64url").toString("utf8");
  if (!chatGuid || Buffer.from(chatGuid).toString("base64url") !== match[3])
    throw new Error("Invalid Photon chat identity");
  return { lineId: match[1], chatGuid, isGroup: match[2] === "g" };
}
/** Closed quote context survives durable admission without retaining SDK objects. */
export function photonReplyReference(
  raw: unknown,
): { guid: string; part?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PhotonMessage>;
  const guid = value.replyTargetGuid ?? value.threadOriginatorGuid;
  if (typeof guid !== "string" || !guid || guid.length > 512) return null;
  return {
    guid,
    ...(typeof value.threadOriginatorPart === "string" &&
    value.threadOriginatorPart.length <= 64
      ? { part: value.threadOriginatorPart }
      : {}),
  };
}
export function splitPhotonText(text: string, maximum = 4000): string[] {
  const points = Array.from(text);
  const result: string[] = [];
  while (points.length > maximum) {
    const candidate = points.slice(0, maximum).join("");
    const paragraph = candidate.lastIndexOf("\n\n");
    const count =
      paragraph >= maximum / 2
        ? Array.from(candidate.slice(0, paragraph + 2)).length
        : maximum;
    result.push(points.splice(0, count).join(""));
  }
  if (points.length) result.push(points.join(""));
  return result;
}
function textOf(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message) return message.markdown;
  if ("raw" in message) return message.raw;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("fallbackText" in message) return message.fallbackText ?? "";
  throw new Error("Photon requires a reviewed text or poll publication");
}

export class PhotonChatAdapter implements Adapter<PhotonThread, PhotonMessage> {
  readonly name = "imessage-photon";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;
  readonly client: GrpcAdvancedIMessage;
  private closed = false;
  private recovery?: PhotonRecoveryTransport;
  private readonly typing = new Map<string, ReturnType<typeof setTimeout>>();
  typingGuard?: (activeThreadId?: string) => Promise<void>;
  recoveryStream(sequence?: number) {
    this.recovery ??= new PhotonRecoveryTransport(this.authentication);
    return this.recovery.catchUp(sequence);
  }
  constructor(
    readonly userName: string,
    readonly authentication: PhotonLineAuthentication,
    readonly state: PhotonState,
    client?: GrpcAdvancedIMessage,
  ) {
    this.botUserId = authentication.identity.phoneNumber;
    this.client =
      client ??
      createGrpcClient({
        address: authentication.address,
        token: () => authentication.token(),
        tls: true,
        retry: false,
        autoIdempotency: false,
        timeout: 25_000,
        channelOptions: {
          "grpc.max_receive_message_length": MAX_ATTACHMENT_BYTES + 1024 * 1024,
        },
      });
  }
  async initialize(_chat: ChatInstance): Promise<void> {
    await this.authentication.token();
  }
  async disconnect(): Promise<void> {
    this.closed = true;
    for (const timer of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
    this.authentication.retire();
    this.recovery?.close();
    await this.client.close();
  }
  encodeThreadId(value: PhotonThread): string {
    if (value.isGroup && this.authentication.identity.allocation === "shared")
      throw new PhotonError("rejected", "Photon shared channels support direct messages only");
    if (value.lineId !== this.authentication.identity.lineId)
      throw new Error("Wrong Photon line");
    return photonThreadId(value);
  }
  decodeThreadId(id: string): PhotonThread {
    const value = parsePhotonThreadId(id);
    if (value.isGroup && this.authentication.identity.allocation === "shared")
      throw new PhotonError("rejected", "Photon shared channels support direct messages only");
    if (value.lineId !== this.authentication.identity.lineId)
      throw new Error("Wrong Photon line");
    return value;
  }
  channelIdFromThreadId(id: string): string {
    this.decodeThreadId(id);
    return id;
  }
  isDM(id: string): boolean {
    return !this.decodeThreadId(id).isGroup;
  }
  async chatInfo(id: string): Promise<PhotonChat> {
    if (this.closed) throw new Error("Photon runtime retired");
    const identity = this.decodeThreadId(id);
    const chat = await this.client.chats
      .get(identity.chatGuid)
      .catch((error) => {
        throw photonFailure(error);
      });
    if (
      chat.guid !== identity.chatGuid ||
      chat.isGroup !== identity.isGroup ||
      chat.service !== "iMessage"
    )
      throw new Error("Photon conversation identity changed");
    return chat;
  }
  async fetchThread(id: string): Promise<ThreadInfo> {
    const chat = await this.chatInfo(id);
    return {
      id,
      channelId: id,
      channelName:
        chat.displayName || chat.participants.map((p) => p.address).join(", "),
      isDM: !chat.isGroup,
      metadata: {
        participants: chat.participants.map((p) => ({
          address: p.address,
          service: p.service,
        })),
        isArchived: chat.isArchived,
      },
    };
  }
  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return {
      id,
      name: info.channelName,
      isDM: info.isDM,
      metadata: info.metadata,
    };
  }
  parseMessage(raw: PhotonMessage): Message<PhotonMessage> {
    if (raw.chatGuids.length !== 1)
      throw new Error(
        "Photon message must have one authenticated conversation",
      );
    // The receiver supplies the authoritative chat shape; fetch paths set it too.
    const isGroup = (raw as PhotonMessage & { paperclipIsGroup?: boolean })
      .paperclipIsGroup;
    if (typeof isGroup !== "boolean")
      throw new Error("Photon message is missing its authenticated chat shape");
    const chatGuid = raw.chatGuids[0];
    const threadId = this.encodeThreadId({
      lineId: this.authentication.identity.lineId,
      chatGuid,
      isGroup,
    });
    const address = raw.sender?.address ?? (raw.isFromMe ? this.botUserId : "");
    const service = raw.sender?.service;
    const authorId = raw.isFromMe ? this.botUserId : `${service}:${address}`;
    const attachments: Attachment[] = raw.content.attachments
      .filter((a) => !a.isHidden && !a.isSticker)
      .map((a) => {
        const locator: PhotonAttachmentLocator = {
          kind: "photon_attachment",
          lineId: this.authentication.identity.lineId,
          chatGuid,
          messageGuid: raw.guid,
          attachmentGuid: a.guid,
        };
        return {
          type: a.mimeType.startsWith("image/")
            ? "image"
            : a.mimeType.startsWith("audio/")
              ? "audio"
              : a.mimeType.startsWith("video/")
                ? "video"
                : "file",
          name: a.fileName,
          mimeType: a.mimeType,
          size: a.totalBytes,
          fetchMetadata: {
            kind: locator.kind,
            lineId: locator.lineId,
            chatGuid: locator.chatGuid,
            messageGuid: locator.messageGuid,
            attachmentGuid: locator.attachmentGuid,
          },
          fetchData: () =>
            downloadPhotonAttachment(
              this.client,
              this.authentication.identity.lineId,
              locator,
              this.authentication.identity.allocation,
            ),
        };
      });
    const text = raw.content.text ?? "";
    return new Message({
      id: raw.guid,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      attachments,
      author: {
        userId: authorId,
        userName: address,
        fullName: address,
        isBot: false,
        isMe: raw.isFromMe,
        isSystem:
          raw.isSystemMessage ||
          raw.isServiceMessage ||
          !address ||
          (service !== "iMessage" && !raw.isFromMe),
      },
      metadata: {
        dateSent: new Date(raw.dateCreated),
        edited: !!raw.dateEdited,
        editedAt: raw.dateEdited ? new Date(raw.dateEdited) : undefined,
      },
    });
  }
  normalize(raw: PhotonMessage, chat: PhotonChat): Message<PhotonMessage> {
    if (!raw.chatGuids.includes(chat.guid))
      throw new Error("Photon message belongs to another chat");
    return this.parseMessage({
      ...raw,
      chatGuids: [chat.guid],
      paperclipIsGroup: chat.isGroup,
    } as PhotonMessage);
  }
  async fetchMessage(id: string, messageId: string) {
    const chat = await this.chatInfo(id);
    return this.normalize(
      await this.client.messages.get(messageId).catch((error) => {
        throw photonFailure(error);
      }),
      chat,
    );
  }
  async fetchMessages(id: string, options?: FetchOptions) {
    const chat = await this.chatInfo(id);
    const page = await this.client.messages
      .listInChat(chat.guid, {
        pageSize: Math.min(options?.limit ?? 50, 100),
        pageToken: options?.cursor,
      })
      .catch((error) => {
        throw photonFailure(error);
      });
    return {
      messages: page.messages
        .map((message) => this.normalize(message, chat))
        .sort(
          (a, b) =>
            a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime(),
        ),
      nextCursor: page.nextPageToken,
    };
  }
  async getUser(userId: string) {
    return {
      userId,
      fullName: userId.replace(/^iMessage:/, ""),
      userName: userId.replace(/^iMessage:/, ""),
      isBot: false,
    };
  }
  async handleWebhook(): Promise<Response> {
    return new Response("Photon uses authenticated streams", { status: 405 });
  }
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }
  async startTyping(id: string): Promise<void> {
    await this.refreshTyping(id, false);
  }
  private async refreshTyping(id: string, refresh: boolean): Promise<void> {
    if (this.closed) return;
    if (this.typing.has(id)) clearTimeout(this.typing.get(id));
    await this.typingGuard?.(refresh ? id : undefined);
    await this.client.chats
      .setTyping(this.decodeThreadId(id).chatGuid, true)
      .catch((error) => {
        throw photonFailure(error);
      });
    if (this.closed) return;
    // Refresh while work is running; final/prompt publication or runtime
    // retirement clears this timer. Every refresh checks endpoint ownership.
    const timer = setTimeout(() => {
      this.typing.delete(id);
      void this.refreshTyping(id, true).catch(() => {});
    }, 8_000);
    timer.unref();
    this.typing.set(id, timer);
  }
  async endTyping(id: string): Promise<void> {
    if (this.typing.has(id)) clearTimeout(this.typing.get(id));
    this.typing.delete(id);
    if (!this.closed)
      await this.client.chats
        .setTyping(this.decodeThreadId(id).chatGuid, false)
        .catch(() => {});
  }
  async postMessage(
    _id: string,
    _message: AdapterPostableMessage,
  ): Promise<never> {
    throw new Error(
      "Photon sends require an immutable Paperclip publication identity",
    );
  }
  async editMessage(
    _id: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<never> {
    throw new Error(
      "Photon edits require an immutable Paperclip publication identity",
    );
  }
  async deleteMessage(): Promise<never> {
    throw new Error("Photon message deletion is not supported");
  }
  async addReaction(): Promise<void> {
    /* Receipt reactions are intentionally not published. */
  }
  async removeReaction(): Promise<void> {
    /* Reactions never represent approvals. */
  }

  async publish(
    id: string,
    publicationId: string,
    message: AdapterPostableMessage,
    options: {
      replyTo?: string;
      replaceMessageId?: string;
      retryUnknown?: boolean;
      assertCurrent(): Promise<void>;
    },
  ): Promise<{ id: string; messageIds: string[] }> {
    const chat = await this.chatInfo(id);
    if (chat.isArchived) throw new Error("Photon conversation is unavailable");
    const text = textOf(message);
    const files =
      typeof message !== "string" && "files" in message
        ? (message.files ?? [])
        : [];
    const parts = splitPhotonText(text);
    if (options.replaceMessageId && (parts.length !== 1 || files.length))
      throw new Error("Photon cannot edit a multipart publication");
    let lastId: string | undefined;
    const messageIds: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      lastId = await this.sendPart(
        publicationId,
        `text-${index}`,
        {
          chatGuid: chat.guid,
          text: parts[index],
          replyTo: options.replyTo,
          replaceMessageId: options.replaceMessageId,
        },
        undefined,
        options,
      );
      messageIds.push(lastId);
    }
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const bytes =
        file.data instanceof Blob
          ? Buffer.from(await file.data.arrayBuffer())
          : Buffer.from(file.data as ArrayBuffer);
      if (bytes.length > MAX_ATTACHMENT_BYTES)
        throw new Error("Attachment exceeds the configured size limit");
      lastId = await this.sendPart(
        publicationId,
        `file-${index}`,
        {
          chatGuid: chat.guid,
          filename: file.filename,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          replyTo: options.replyTo,
        },
        { ...file, data: bytes },
        options,
      );
      messageIds.push(lastId);
    }
    if (!lastId) throw new Error("Photon publication is empty");
    await this.endTyping(id);
    return { id: lastId, messageIds };
  }
  private async sendPart(
    publicationId: string,
    part: string,
    payload: {
      chatGuid: string;
      text?: string;
      filename?: string;
      sha256?: string;
      replyTo?: string;
      replaceMessageId?: string;
    },
    file: FileUpload | undefined,
    options: { retryUnknown?: boolean; assertCurrent(): Promise<void> },
  ): Promise<string> {
    const key = `send:${publicationId}:${part}`;
    const digest = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    let record = await this.state.update<SendRecord>(key, (current) => {
      if (current && current.digest !== digest)
        throw new Error("Photon publication payload changed after preparation");
      return current ?? { schema: 1, digest, phase: "prepared" };
    });
    if (record.phase === "sent" && record.messageGuid)
      return record.messageGuid;
    if (
      (record.phase === "sending" || record.phase === "uploading") &&
      !options.retryUnknown
    )
      throw new PhotonError(
        "delivery_unknown",
        "Photon delivery is unknown; resolve this publication before retrying",
      );
    const save = async (patch: Partial<SendRecord>) => {
      record = await this.state.update<SendRecord>(key, (current) => {
        if (!current || current.digest !== digest)
          throw new Error("Photon send identity changed");
        return { ...current, ...patch };
      });
    };
    if (file && !record.attachmentGuid) {
      await options.assertCurrent();
      await save({ phase: "uploading" });
      try {
        const uploaded = await this.client.attachments.upload({
          fileName: file.filename,
          data: file.data as Buffer,
        });
        if (!uploaded.attachment.guid)
          throw new PhotonError(
            "delivery_unknown",
            "Photon upload receipt is missing",
          );
        await save({
          phase: "uploaded",
          attachmentGuid: uploaded.attachment.guid,
        });
      } catch (error) {
        const failure = photonFailure(error, true);
        if (failure.code !== "delivery_unknown")
          await save({ phase: "prepared" });
        throw failure;
      }
    }
    await options.assertCurrent();
    if (payload.replaceMessageId) {
      const original = await this.client.messages.get(payload.replaceMessageId);
      if (
        !original.isFromMe ||
        !original.chatGuids.includes(payload.chatGuid) ||
        Date.now() - new Date(original.dateCreated).getTime() >= 15 * 60_000
      )
        throw new PhotonError(
          "rejected",
          "The iMessage edit window expired; stage a correction as a new publication",
        );
    }
    await save({ phase: "sending" });
    const clientMessageId = createHash("sha256")
      .update(`${this.state.scope.endpointId}:${publicationId}:${part}`)
      .digest("hex");
    try {
      const result = record.attachmentGuid
        ? await this.client.messages.sendAttachment(
            payload.chatGuid,
            record.attachmentGuid,
            { clientMessageId, replyTo: payload.replyTo },
          )
        : payload.replaceMessageId
          ? await this.client.messages.edit(
              payload.chatGuid,
              payload.replaceMessageId,
              payload.text!,
              { clientMessageId },
            )
          : await this.client.messages.sendText(
              payload.chatGuid,
              payload.text!,
              { clientMessageId, replyTo: payload.replyTo },
            );
      if (!result.guid || !result.chatGuids.includes(payload.chatGuid))
        throw new Error("Photon returned an invalid send receipt");
      await save({ phase: "sent", messageGuid: result.guid });
      return result.guid;
    } catch (error) {
      const failure = photonFailure(error, true);
      if (failure.code !== "delivery_unknown")
        await save({ phase: record.attachmentGuid ? "uploaded" : "prepared" });
      throw failure;
    }
  }
}
