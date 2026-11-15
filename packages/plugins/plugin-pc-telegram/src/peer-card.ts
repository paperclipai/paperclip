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
  photoId?: string;
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

// Telegram stripped thumbs omit the JPEG tables. The header is the one GramJS uses.
const STRIPPED_JPEG_HEADER = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb004300281c1e231e19282321232d2b28303c64413c37373c7b585d4964918099968f808c8aa0b4e6c3a0aadaad8a8cc8ffcbdaeef5ffffff9bc1fffffffaffe6fdfff8ffdb0043012b2d2d3c353c76414176f8a58ca5f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8ffc00011080000000003012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00", "hex");
const STRIPPED_JPEG_FOOTER = Buffer.from([0xff, 0xd9]);

export type ProfilePhotoMemory = {
  value: string | null;
  ready: boolean;
};

function photoRecord(entity: unknown): { className: string; photoId: unknown; id: unknown; strippedThumb: unknown } | null {
  if (!entity || typeof entity !== "object") return null;
  const photo = (entity as { photo?: unknown }).photo;
  if (!photo || typeof photo !== "object") return null;
  const record = photo as { className?: unknown; photoId?: unknown; id?: unknown; strippedThumb?: unknown };
  return {
    className: String(record.className ?? ""),
    photoId: record.photoId,
    id: record.id,
    strippedThumb: record.strippedThumb,
  };
}

function photoIdPresent(value: unknown): boolean {
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") return value.length > 0 && value !== "0";
  return false;
}

export function hasProfilePhoto(entity: unknown): boolean {
  const photo = photoRecord(entity);
  if (!photo) return false;
  if (/empty$/i.test(photo.className)) return false;
  if (
    photo.className === "UserProfilePhoto"
    || photo.className === "ChatPhoto"
    || photo.className === "Photo"
    || photo.className.endsWith(".UserProfilePhoto")
    || photo.className.endsWith(".ChatPhoto")
    || photo.className.endsWith(".Photo")
  ) {
    return true;
  }
  const thumb = photo.strippedThumb;
  if (thumb instanceof Uint8Array && thumb.length >= 3 && thumb[0] === 1) return true;
  return photoIdPresent(photo.photoId) || photoIdPresent(photo.id);
}

export function profilePhotoId(entity: unknown): string {
  const photo = photoRecord(entity);
  if (!photo) return "";
  const raw = photoIdPresent(photo.photoId) ? photo.photoId : photoIdPresent(photo.id) ? photo.id : null;
  if (typeof raw === "bigint") return raw > 0n ? raw.toString() : "";
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return String(Math.trunc(raw));
  if (typeof raw === "string" && /^[0-9]{1,24}$/.test(raw)) return raw;
  return "";
}

export function expandStrippedThumb(stripped: Uint8Array): Uint8Array | null {
  if (stripped.length < 3 || stripped[0] !== 1 || STRIPPED_JPEG_HEADER.length < 167) return null;
  const header = Buffer.from(STRIPPED_JPEG_HEADER);
  header[164] = stripped[1] ?? 0;
  header[166] = stripped[2] ?? 0;
  return Buffer.concat([header, stripped.subarray(3), STRIPPED_JPEG_FOOTER]);
}

export function inlineProfilePhoto(entity: unknown): string | null {
  const photo = photoRecord(entity);
  if (!photo || /empty$/i.test(photo.className)) return null;
  const thumb = photo.strippedThumb;
  if (!(thumb instanceof Uint8Array)) return null;
  const bytes = expandStrippedThumb(thumb);
  if (!bytes) return null;
  return photoDataUrl(bytes, 80_000);
}

export function rememberProfilePhoto(
  current: ProfilePhotoMemory | undefined,
  input: { downloaded: string | null; fallback: string | null; knownEmpty: boolean },
): { memory: ProfilePhotoMemory; photo: string | null } {
  if (current?.ready) return { memory: current, photo: current.value };
  if (input.downloaded) {
    const memory = { value: input.downloaded, ready: true };
    return { memory, photo: input.downloaded };
  }
  const fallback = current?.value || input.fallback || null;
  if (input.knownEmpty) {
    const memory = { value: fallback, ready: true };
    return { memory, photo: fallback };
  }
  if (fallback) {
    const memory = { value: fallback, ready: false };
    return { memory, photo: fallback };
  }
  return { memory: { value: null, ready: false }, photo: null };
}

export function remainingPhotoBudget(left: number, photo: string | null, ready: boolean): number {
  if (left <= 0) return 0;
  if (ready && photo) return left - 1;
  return left;
}
