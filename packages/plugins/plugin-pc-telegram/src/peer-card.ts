export type PeerPresence = {
  code: "online" | "recently" | "last_week" | "last_month" | "offline";
  at?: string;
};

export type PeerSummary = {
  id: string;
  name: string;
  preview: string;
  unread: number;
  photo: string | null;
  presence: PeerPresence | null;
  activityAt?: string;
};

export type PeerProfile = {
  name: string;
  username: string | null;
  phone: string | null;
  about: string | null;
  photo: string | null;
  presence: PeerPresence | null;
  channel: string | null;
  sharedChats: number;
};

const PRESENCE_CODES = new Set<PeerPresence["code"]>([
  "online",
  "recently",
  "last_week",
  "last_month",
  "offline",
]);

export function presenceFromStatus(status: unknown, nowMs = Date.now()): PeerPresence | null {
  if (!status || typeof status !== "object") return null;
  const name = String((status as { className?: unknown }).className ?? "");
  if (name === "UserStatusOnline") return { code: "online" };
  if (name === "UserStatusRecently") return { code: "recently" };
  if (name === "UserStatusLastWeek") return { code: "last_week" };
  if (name === "UserStatusLastMonth") return { code: "last_month" };
  if (name !== "UserStatusOffline") return null;
  const raw = (status as { wasOnline?: unknown }).wasOnline;
  const unix = typeof raw === "number" ? raw : typeof raw === "bigint" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(unix) || unix <= 0) return { code: "offline" };
  const at = new Date(unix * 1000);
  if (Number.isNaN(at.getTime()) || at.getTime() > nowMs + 60_000) return { code: "offline" };
  return { code: "offline", at: at.toISOString() };
}

export function publicPresence(value: unknown): PeerPresence | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string" || !PRESENCE_CODES.has(code as PeerPresence["code"])) return null;
  const presence: PeerPresence = { code: code as PeerPresence["code"] };
  const at = (value as { at?: unknown }).at;
  if (presence.code === "offline" && typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) presence.at = new Date(parsed).toISOString();
  }
  return presence;
}

export function publicPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

export function publicUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^@+/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)) return null;
  return `@${name}`;
}

export function publicAbout(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, 140);
}

export function publicChannelTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || /^\d+$/.test(text)) return null;
  return text.slice(0, 80);
}

export function publicSharedChats(value: unknown): number {
  const count = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(500, Math.floor(count));
}

export function unreadCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(999, Math.floor(count));
}

export function previewFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as {
    message?: unknown;
    media?: { className?: unknown; document?: { attributes?: unknown } } | null;
  };
  const text = typeof record.message === "string" ? record.message.replace(/\s+/g, " ").trim() : "";
  if (text) return text.slice(0, 80);
  const mediaName = record.media && typeof record.media === "object" ? String(record.media.className ?? "") : "";
  if (mediaName === "MessageMediaPhoto") return "Photo";
  if (mediaName === "MessageMediaGeo" || mediaName === "MessageMediaGeoLive" || mediaName === "MessageMediaVenue") {
    return "Location";
  }
  if (mediaName !== "MessageMediaDocument") return "";
  const attributes = record.media?.document?.attributes;
  const list = Array.isArray(attributes) ? attributes : [];
  for (const attribute of list) {
    if (!attribute || typeof attribute !== "object") continue;
    const kind = String((attribute as { className?: unknown }).className ?? "");
    if (kind === "DocumentAttributeAudio" && (attribute as { voice?: unknown }).voice === true) return "Voice message";
    if (kind === "DocumentAttributeVideo") return "Video";
    if (kind === "DocumentAttributeSticker") return "Sticker";
  }
  return "File";
}

function imageKind(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function photoDataUrl(bytes: unknown, maxBytes: number): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > maxBytes) return null;
  const kind = imageKind(bytes);
  if (!kind) return null;
  const encoded = Buffer.from(bytes).toString("base64");
  return `data:${kind};base64,${encoded}`;
}

export function publicPhoto(value: unknown, maxLength = 480_000): string | null {
  if (typeof value !== "string" || !value.startsWith("data:image/") || value.length > maxLength) return null;
  if (/[\s"'()]/.test(value)) return null;
  return value;
}
