// Telegram Web paints dialogs and avatars from persistent storage, then refreshes
// them in the background. A failed download must not replace a stored image.
// The dialog index stays; the oldest avatars and history pages are evicted at the cap.
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { publicPhoto, publicPresence, unreadCount, type PeerPresence } from "./peer-card.js";

const CACHE_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LIMITS = [16, 64, 256].map((mb) => mb * 1024 * 1024);
const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^[0-9]{1,24}$/;

export type DialogCacheRow = {
  id: string;
  name: string;
  preview: string;
  unread: number;
  photoId: string;
  presence: PeerPresence | null;
  activityAt: string;
  previewPlaceholder?: boolean;
};

export type CachedAvatar = {
  photoId: string;
  dataUrl: string;
};

export type CachedHistoryMessage = {
  id: string;
  direction: "in" | "out";
  text: string;
  at: string;
  forward: { kind: string | null; name: string | null; author: string | null } | null;
  placeholder?: boolean;
};

export type CacheSettings = {
  enabled: boolean;
  maxBytes: number;
};

export type CacheStatus = {
  enabled: boolean;
  bytes: number;
  dialogs: number;
  avatars: number;
  maxBytes: number;
  updatedAt: string | null;
};

export type CacheScope = "all" | "avatars" | "dialogs";

type CacheOptions = {
  root?: string;
  allowedMaxBytes?: readonly number[];
};

type ListedFile = {
  path: string;
  size: number;
  mtimeMs: number;
  kind: "avatar" | "history" | "dialogs" | "settings" | "other";
};

function defaultRoot(): string {
  const home = process.env.PAPERCLIP_HOME?.trim() || join(homedir(), ".paperclip");
  return join(home, "plugin-cache", "andhash.plugin-pc-telegram");
}

function nearestLimit(value: number, allowed: readonly number[]): number {
  let best = allowed[0] ?? DEFAULT_MAX_BYTES;
  let distance = Infinity;
  for (const option of allowed) {
    const gap = Math.abs(option - value);
    if (gap < distance) {
      distance = gap;
      best = option;
    }
  }
  return best;
}

function clipText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function messageText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

function numericId(value: unknown): string {
  return typeof value === "string" && NUMERIC_ID.test(value) ? value : "";
}

function activityAt(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString();
}

function dialogName(value: unknown): string {
  const name = clipText(value, 80);
  if (!name || /^\d{5,}$/.test(name)) return "";
  return name;
}

export function preferCachedPhoto(
  current: string | null,
  incoming: string | null,
  currentId = "",
  incomingId = "",
): string | null {
  const prev = publicPhoto(current);
  const next = publicPhoto(incoming);
  if (!next) return prev;
  if (!prev) return next;
  if (currentId && incomingId && incomingId !== currentId) return next;
  return next.length >= prev.length ? next : prev;
}

function sanitizeDialog(value: unknown): DialogCacheRow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = numericId(record.id);
  const name = dialogName(record.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    preview: clipText(record.preview, 80),
    unread: unreadCount(record.unread),
    photoId: numericId(record.photoId),
    presence: publicPresence(record.presence),
    activityAt: activityAt(record.activityAt),
    previewPlaceholder: record.previewPlaceholder === true,
  };
}

function sanitizeForward(value: unknown): CachedHistoryMessage["forward"] {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = clipText(record.kind, 16) || null;
  const name = clipText(record.name, 128) || null;
  const author = clipText(record.author, 128) || null;
  if (!kind && !name && !author) return null;
  return { kind, name, author };
}

export function sanitizeHistoryMessage(value: unknown): CachedHistoryMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && /^[0-9A-Za-z_-]{1,80}$/.test(record.id) ? record.id : "";
  const direction = record.direction === "out" ? "out" : record.direction === "in" ? "in" : "";
  if (!id || !direction) return null;
  return {
    id,
    direction,
    text: messageText(record.text, 4000),
    at: activityAt(record.at),
    forward: sanitizeForward(record.forward),
    placeholder: record.placeholder === true,
  };
}

export function createDialogCache(options: CacheOptions = {}) {
  const root = options.root ?? defaultRoot();
  const allowed = options.allowedMaxBytes?.length ? [...options.allowedMaxBytes] : DEFAULT_LIMITS;
  const chains = new Map<string, Promise<void>>();
  const settingsMemory = new Map<string, CacheSettings>();

  function companyDir(companyId: string): string | null {
    if (!COMPANY_ID.test(companyId)) return null;
    return join(root, companyId.toLowerCase());
  }

  function accountDir(companyId: string, accountId: string): string | null {
    const company = companyDir(companyId);
    if (!company || !numericId(accountId)) return null;
    return join(company, accountId);
  }

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    const parent = join(dir, "..");
    if (parent.startsWith(root)) await chmod(parent, 0o700).catch(() => undefined);
    await chmod(root, 0o700).catch(() => undefined);
  }

  function enqueue(companyId: string, job: () => Promise<void>): Promise<void> {
    const previous = chains.get(companyId) ?? Promise.resolve();
    const run = previous.then(job, job);
    chains.set(companyId, run.then(() => undefined, () => undefined));
    return run;
  }

  async function readJson(file: string): Promise<unknown> {
    try {
      const info = await lstat(file);
      if (!info.isFile()) return null;
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  async function writeJson(file: string, value: unknown): Promise<void> {
    await ensureDir(join(file, ".."));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  async function readSettings(companyId: string): Promise<CacheSettings> {
    const dir = companyDir(companyId);
    const fallback = { enabled: true, maxBytes: nearestLimit(DEFAULT_MAX_BYTES, allowed) };
    if (!dir) return fallback;
    const cached = settingsMemory.get(dir);
    if (cached) return cached;
    const parsed = await readJson(join(dir, "settings.json"));
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
    const maxBytes = typeof record.maxBytes === "number"
      ? nearestLimit(record.maxBytes, allowed)
      : fallback.maxBytes;
    const settings = { enabled, maxBytes };
    settingsMemory.set(dir, settings);
    return settings;
  }

  async function listFiles(companyId: string): Promise<ListedFile[]> {
    const dir = companyDir(companyId);
    if (!dir) return [];
    const files: ListedFile[] = [];
    async function walk(current: string, depth: number): Promise<void> {
      if (depth > 4) return;
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }> = [];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await lstat(full);
          if (!info.isFile()) continue;
          const kind = entry.name === "settings.json"
            ? "settings"
            : entry.name === "dialogs.json"
              ? "dialogs"
              : full.includes(`${join("avatars", "")}`) || current.endsWith(`${join("", "avatars")}`) || current.endsWith("/avatars")
                ? "avatar"
                : current.endsWith("/history")
                  ? "history"
                  : "other";
          files.push({ path: full, size: info.size, mtimeMs: info.mtimeMs, kind });
        } catch {
          continue;
        }
      }
    }
    await walk(dir, 0);
    return files;
  }

  function fileKind(file: string): ListedFile["kind"] {
    if (file.endsWith(`${join("avatars", "")}`) || file.includes("/avatars/")) return "avatar";
    if (file.includes("/history/")) return "history";
    if (file.endsWith("/dialogs.json") || file.endsWith(`${join("", "dialogs.json")}`)) return "dialogs";
    if (file.endsWith("/settings.json")) return "settings";
    return "other";
  }

  async function enforceCap(companyId: string, protect: string): Promise<void> {
    const settings = await readSettings(companyId);
    const files = await listFiles(companyId);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const victims = files
      .filter((file) => file.path !== protect && (file.kind === "avatar" || file.kind === "history"))
      .sort((left, right) => left.mtimeMs - right.mtimeMs || (left.kind === "history" ? -1 : 1));
    for (const file of victims) {
      if (total <= settings.maxBytes) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }

  async function writeAvatarFile(companyId: string, accountId: string, peerId: string, avatar: CachedAvatar): Promise<void> {
    const settings = await readSettings(companyId);
    if (!settings.enabled) return;
    const dir = accountDir(companyId, accountId);
    const id = numericId(peerId);
    const dataUrl = publicPhoto(avatar.dataUrl);
    if (!dir || !id || !dataUrl) return;
    const photoId = numericId(avatar.photoId);
    const existing = await readAvatar(companyId, accountId, id);
    if (existing && dataUrl.length < existing.dataUrl.length && (!photoId || photoId === existing.photoId)) return;
    if (dataUrl.length > settings.maxBytes) return;
    const file = join(dir, "avatars", `${id}.json`);
    await writeJson(file, { v: CACHE_VERSION, photoId, dataUrl });
    await enforceCap(companyId, file);
  }

  async function readAvatar(companyId: string, accountId: string, peerId: string): Promise<CachedAvatar | null> {
    const settings = await readSettings(companyId);
    if (!settings.enabled) return null;
    const dir = accountDir(companyId, accountId);
    const id = numericId(peerId);
    if (!dir || !id) return null;
    const parsed = await readJson(join(dir, "avatars", `${id}.json`));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const dataUrl = publicPhoto(record.dataUrl);
    if (!dataUrl) return null;
    return { photoId: numericId(record.photoId), dataUrl };
  }

  return {
    async settings(companyId: string): Promise<CacheSettings> {
      return readSettings(companyId);
    },

    async saveSettings(companyId: string, patch: { enabled?: boolean; maxBytes?: number }): Promise<CacheSettings> {
      const dir = companyDir(companyId);
      const current = await readSettings(companyId);
      if (!dir) return current;
      const next = {
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        maxBytes: typeof patch.maxBytes === "number" ? nearestLimit(patch.maxBytes, allowed) : current.maxBytes,
      };
      await enqueue(companyId, async () => {
        settingsMemory.set(dir, next);
        await writeJson(join(dir, "settings.json"), { v: CACHE_VERSION, ...next });
        await enforceCap(companyId, "");
      });
      return next;
    },

    async status(companyId: string): Promise<CacheStatus> {
      const settings = await readSettings(companyId);
      const empty = {
        enabled: settings.enabled,
        bytes: 0,
        dialogs: 0,
        avatars: 0,
        maxBytes: settings.maxBytes,
        updatedAt: null as string | null,
      };
      if (!companyDir(companyId)) return empty;
      const files = await listFiles(companyId);
      let bytes = 0;
      let dialogs = 0;
      let avatars = 0;
      let updated = 0;
      for (const file of files) {
        bytes += file.size;
        if (file.kind === "avatar") avatars += 1;
        if (file.kind === "dialogs") {
          if (file.mtimeMs > updated) updated = file.mtimeMs;
          const parsed = await readJson(file.path);
          const rows = parsed && typeof parsed === "object" ? (parsed as { dialogs?: unknown }).dialogs : null;
          if (Array.isArray(rows)) dialogs += rows.length;
        }
      }
      return {
        enabled: settings.enabled,
        bytes,
        dialogs,
        avatars,
        maxBytes: settings.maxBytes,
        updatedAt: updated > 0 ? new Date(updated).toISOString() : null,
      };
    },

    async readDialogs(companyId: string, accountId: string): Promise<DialogCacheRow[] | null> {
      const settings = await readSettings(companyId);
      if (!settings.enabled) return null;
      const dir = accountDir(companyId, accountId);
      if (!dir) return null;
      const parsed = await readJson(join(dir, "dialogs.json"));
      if (!parsed || typeof parsed !== "object") return null;
      const rows = (parsed as { dialogs?: unknown }).dialogs;
      if (!Array.isArray(rows)) return null;
      const dialogs: DialogCacheRow[] = [];
      for (const row of rows) {
        const clean = sanitizeDialog(row);
        if (clean) dialogs.push(clean);
      }
      return dialogs;
    },

    async writeDialogs(companyId: string, accountId: string, rows: readonly unknown[]): Promise<void> {
      const settings = await readSettings(companyId);
      if (!settings.enabled) return;
      const dir = accountDir(companyId, accountId);
      if (!dir) return;
      const dialogs: DialogCacheRow[] = [];
      for (const row of rows) {
        const clean = sanitizeDialog(row);
        if (clean) dialogs.push(clean);
      }
      if (dialogs.length === 0) return;
      await enqueue(companyId, async () => {
        const file = join(dir, "dialogs.json");
        await writeJson(file, { v: CACHE_VERSION, dialogs });
        await enforceCap(companyId, file);
      });
    },

    readAvatar,

    async writeAvatar(companyId: string, accountId: string, peerId: string, avatar: CachedAvatar): Promise<void> {
      await enqueue(companyId, () => writeAvatarFile(companyId, accountId, peerId, avatar));
    },

    async readHistory(companyId: string, accountId: string, peerId: string): Promise<CachedHistoryMessage[] | null> {
      const settings = await readSettings(companyId);
      if (!settings.enabled) return null;
      const dir = accountDir(companyId, accountId);
      const id = numericId(peerId);
      if (!dir || !id) return null;
      const parsed = await readJson(join(dir, "history", `${id}.json`));
      if (!parsed || typeof parsed !== "object") return null;
      const rows = (parsed as { messages?: unknown }).messages;
      if (!Array.isArray(rows)) return null;
      const messages: CachedHistoryMessage[] = [];
      for (const row of rows) {
        const clean = sanitizeHistoryMessage(row);
        if (clean) messages.push(clean);
      }
      return messages.slice(-40);
    },

    async writeHistory(companyId: string, accountId: string, peerId: string, rows: readonly unknown[]): Promise<void> {
      const settings = await readSettings(companyId);
      if (!settings.enabled) return;
      const dir = accountDir(companyId, accountId);
      const id = numericId(peerId);
      if (!dir || !id) return;
      const messages: CachedHistoryMessage[] = [];
      for (const row of rows) {
        const clean = sanitizeHistoryMessage(row);
        if (clean) messages.push(clean);
      }
      await enqueue(companyId, async () => {
        const file = join(dir, "history", `${id}.json`);
        await writeJson(file, { v: CACHE_VERSION, messages: messages.slice(-40) });
        if (messages.length > 0) await enforceCap(companyId, file);
      });
    },

    async clear(companyId: string, scope: CacheScope): Promise<void> {
      const dir = companyDir(companyId);
      if (!dir || (scope !== "all" && scope !== "avatars" && scope !== "dialogs")) return;
      await enqueue(companyId, async () => {
        let accounts: string[] = [];
        try {
          accounts = (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && numericId(entry.name))
            .map((entry) => entry.name);
        } catch {
          accounts = [];
        }
        for (const accountId of accounts) {
          const account = join(dir, accountId);
          if (scope === "all") {
            await rm(account, { recursive: true, force: true });
            continue;
          }
          if (scope === "avatars") await rm(join(account, "avatars"), { recursive: true, force: true });
          if (scope === "dialogs") {
            await rm(join(account, "dialogs.json"), { force: true });
            await rm(join(account, "history"), { recursive: true, force: true });
          }
        }
      });
    },

    fileKind,
  };
}
