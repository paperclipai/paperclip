const UNKNOWN_FORWARD_NAME = "неизвестный отправитель";

export type PublicForward = {
  kind?: string | null;
  name?: string | null;
  author?: string | null;
};

export type TelegramNamedEntity = {
  id?: unknown;
  className?: string;
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  megagroup?: boolean;
};

export type TelegramForwardSource = {
  fromId?: unknown;
  fromName?: string | null;
  postAuthor?: string | null;
  sender?: TelegramNamedEntity | null;
  chat?: TelegramNamedEntity | null;
};

export type InboundForwardRecord = {
  kind: "user" | "hidden" | "channel" | "chat";
  fromId: string | null;
  fromName: string;
  authorName: string | null;
};

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, 128);
}

function cleanUsername(value: unknown): string | null {
  const text = cleanName(value);
  if (!text) return null;
  const username = text.replace(/^@/, "");
  return /^[A-Za-z0-9_]{3,32}$/.test(username) ? username : null;
}

function safePeerId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value).trim();
    return /^[0-9]+$/.test(text) ? text : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ("userId" in record) return safePeerId(record.userId);
  if ("channelId" in record) return safePeerId(record.channelId);
  if ("chatId" in record) return safePeerId(record.chatId);
  const text = String(value).trim();
  return /^[0-9]+$/.test(text) ? text : null;
}

function peerKind(value: unknown): "user" | "channel" | "chat" | null {
  if (!value || typeof value !== "object") return null;
  const record = value as TelegramNamedEntity & Record<string, unknown>;
  if ("userId" in record || record.className === "User" || record.className === "PeerUser") return "user";
  if ("channelId" in record || record.className === "Channel" || record.className === "PeerChannel") {
    return record.megagroup ? "chat" : "channel";
  }
  if ("chatId" in record || record.className === "Chat" || record.className === "PeerChat") return "chat";
  if (typeof record.title === "string") return record.megagroup ? "chat" : "channel";
  if (record.firstName || record.lastName || record.username) return "user";
  return null;
}

function personName(entity: TelegramNamedEntity | null | undefined): string | null {
  if (!entity) return null;
  const parts = [entity.firstName, entity.lastName].map(cleanName).filter((part): part is string => Boolean(part));
  const name = parts.join(" ");
  const username = cleanUsername(entity.username);
  if (name && username && username.toLowerCase() !== name.toLowerCase()) return `${name} (@${username})`;
  if (name) return name;
  if (username) return `@${username}`;
  return null;
}

function placeName(entity: TelegramNamedEntity | null | undefined): string | null {
  if (!entity) return null;
  const title = cleanName(entity.title);
  const username = cleanUsername(entity.username);
  if (title && username) return `${title} (@${username})`;
  if (title) return title;
  if (username) return `@${username}`;
  return null;
}

export function describeInboundForward(source: TelegramForwardSource): InboundForwardRecord | null {
  const fromName = cleanName(source.fromName);
  const postAuthor = cleanName(source.postAuthor);
  const senderKind = peerKind(source.sender);
  const chatKind = peerKind(source.chat);
  const idKind = peerKind(source.fromId);
  const fromId = safePeerId(source.sender?.id) ?? safePeerId(source.chat?.id) ?? safePeerId(source.fromId);
  if (senderKind === "user" || idKind === "user") {
    const name = personName(source.sender) ?? fromName ?? fromId;
    if (!name) return null;
    return { kind: "user", fromId, fromName: name, authorName: null };
  }
  if (chatKind === "channel" || chatKind === "chat" || idKind === "channel" || idKind === "chat") {
    const kind = chatKind === "chat" || idKind === "chat" ? "chat" : "channel";
    const name = placeName(source.chat) ?? fromName ?? fromId ?? (kind === "chat" ? "чат" : "канал");
    const authorName = postAuthor && postAuthor !== name ? postAuthor : null;
    return { kind, fromId, fromName: name, authorName };
  }
  if (fromName) return hidden(fromName);
  if (postAuthor) return hidden(postAuthor);
  if (fromId) return { kind: "user", fromId, fromName: fromId, authorName: null };
  return null;
}

function hidden(fromName: string): InboundForwardRecord {
  return { kind: "hidden", fromId: null, fromName, authorName: null };
}

export function visibleForwardName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text === UNKNOWN_FORWARD_NAME || /^\d+$/.test(text)) return null;
  return text.slice(0, 128);
}

export function publicForward(forward: { kind: string; fromName: string; authorName?: string | null }): PublicForward {
  return {
    kind: forward.kind,
    name: visibleForwardName(forward.fromName),
    author: visibleForwardName(forward.authorName),
  };
}

const STORED_FORWARD_LINE = /^Переслано (от|из) \*\*([^*]+)\*\*(?:, автор \*\*([^*]+)\*\*)?$/;

export function forwardFromStoredLine(line: string): PublicForward | null {
  const match = STORED_FORWARD_LINE.exec(line.trim());
  if (!match) return null;
  return {
    kind: match[1] === "из" ? "channel" : "user",
    name: visibleForwardName(match[2]),
    author: visibleForwardName(match[3]),
  };
}

export function formatForwardLine(forward: { kind: string; fromName: string; authorName?: string | null }): string {
  if (forward.kind === "channel" || forward.kind === "chat") {
    const author = forward.authorName ? `, автор **${forward.authorName}**` : "";
    return `Переслано из **${forward.fromName}**${author}`;
  }
  return `Переслано от **${forward.fromName}**`;
}

export const unknownForward = (): InboundForwardRecord => hidden(UNKNOWN_FORWARD_NAME);
