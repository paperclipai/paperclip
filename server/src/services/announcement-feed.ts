import { createHash } from "node:crypto";
import {
  ANNOUNCEMENT_IMAGE_MAX_BYTES, ANNOUNCEMENT_MANIFEST_MAX_BYTES, ANNOUNCEMENT_ANIMATION_MAX_BYTES,
  DEFAULT_ANNOUNCEMENT_FEED_URL, announcementManifestSchema, isAnnouncementEligible,
  type AnnouncementManifest,
} from "@paperclipai/shared";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { validateAnnouncementAnimation } from "./announcement-animation.js";
import { logger } from "../middleware/logger.js";

export const ANNOUNCEMENT_CACHE_MS = 60 * 60 * 1000;
export const ANNOUNCEMENT_FAILURE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 3000;
type AnnouncementAsset = { path: string; bytes: Buffer; contentType: string };
function assetSlot() {
  return {
    cache: null as AnnouncementAsset | null,
    pending: null as { path: string; promise: Promise<AnnouncementAsset | null> } | null,
    failure: null as { path: string; retryAt: number } | null,
  };
}
export interface AnnouncementFeedOptions {
  enabled?: boolean;
  feedUrl?: string;
  version: string;
  now?: () => number;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

export async function readAnnouncementBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("Announcement response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error("Announcement response is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function announcementFeedService(options: AnnouncementFeedOptions) {
  const now = options.now ?? Date.now;
  const fetchRemote = options.fetch ?? ((url, init) => guardedRemoteHttpFetch(url, init, {
    error: (message) => new Error(message), dnsTimeoutMs: TIMEOUT_MS,
    connectTimeoutMs: TIMEOUT_MS, responseTimeoutMs: TIMEOUT_MS,
  }));
  let manifest: AnnouncementManifest | null = null;
  let etag: string | null = null;
  let nextCheck = 0;
  let available = false;
  let pending: Promise<void> | null = null;
  // One bounded cache slot per media kind, shared across board users.
  const assets = {
    image: assetSlot(),
    animation: assetSlot(),
  };

  function endpoint() {
    const url = new URL(options.feedUrl ?? DEFAULT_ANNOUNCEMENT_FEED_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
      throw new Error("Announcement feed must be an HTTPS URL without credentials, query, or fragment");
    }
    return url;
  }

  async function request<T>(url: URL, headers: Record<string, string>, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Announcement request timed out"));
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        fetchRemote(url, { method: "GET", headers, signal: controller.signal, redirect: "error", credentials: "omit" })
          .then(consume),
        deadline,
      ]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }

  async function refresh() {
    try {
      const result = await request(endpoint(), {
        Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}),
      }, async (response) => {
        if (response.status === 304 && manifest) return { manifest, etag, ttl: ANNOUNCEMENT_CACHE_MS };
        if (response.status === 404) {
          await response.body?.cancel();
          // An unpublished/removed feed is an expected empty state. Forget the
          // previous ETag so recovery cannot resurrect a stale cached card.
          return { manifest: { schemaVersion: 1, announcement: null } as AnnouncementManifest, etag: null, ttl: ANNOUNCEMENT_FAILURE_MS };
        }
        if (!response.ok || response.status >= 300) {
          await response.body?.cancel();
          throw new Error("Announcement feed unavailable");
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
          await response.body?.cancel();
          throw new Error("Announcement feed is not JSON");
        }
        const bytes = await readAnnouncementBytes(response, ANNOUNCEMENT_MANIFEST_MAX_BYTES);
        return { manifest: announcementManifestSchema.parse(JSON.parse(bytes.toString("utf8"))), etag: response.headers.get("etag"), ttl: ANNOUNCEMENT_CACHE_MS };
      });
      manifest = result.manifest;
      etag = result.etag;
      available = true;
      nextCheck = now() + result.ttl;
    } catch {
      available = false;
      nextCheck = now() + ANNOUNCEMENT_FAILURE_MS;
      // Do not log remote content or operator URLs (which can carry secrets).
      logger.warn("Announcement feed unavailable; retrying on demand after cooldown");
    }
  }

  async function current() {
    if (options.enabled === false) return null;
    if (pending) await pending;
    else if (now() >= nextCheck) {
      pending = refresh().finally(() => { pending = null; });
      await pending;
    }
    const announcement = available ? manifest?.announcement : null;
    return announcement && isAnnouncementEligible(announcement, options.version, now()) ? announcement : null;
  }

  async function asset(id: string, kind: "image" | "animation") {
    const announcement = await current();
    const media = announcement?.[kind];
    if (announcement?.id !== id || !media) return null;
    const { path } = media;
    const slot = assets[kind];
    if (slot.cache?.path === path) return slot.cache;
    if (slot.pending?.path === path) return slot.pending.promise;
    if (slot.failure?.path === path && now() < slot.failure.retryAt) return null;
    const expected = kind === "animation" ? "text/html" : path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "image/webp";
    const promise = (async () => {
      try {
        const result = await request(new URL(path, endpoint()), { Accept: expected }, async (response) => {
          const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
          if (!response.ok || contentType !== expected) {
            await response.body?.cancel();
            throw new Error("Invalid announcement asset response");
          }
          const bytes = await readAnnouncementBytes(response, kind === "animation" ? ANNOUNCEMENT_ANIMATION_MAX_BYTES : ANNOUNCEMENT_IMAGE_MAX_BYTES);
          const hash = createHash("sha256").update(bytes).digest("hex");
          if (!path.startsWith(`assets/${hash}.`)) throw new Error("Announcement asset digest mismatch");
          return { path, bytes: kind === "animation" ? Buffer.from(validateAnnouncementAnimation(bytes)) : bytes, contentType };
        });
        slot.cache = result;
        slot.failure = null;
        return result;
      } catch {
        slot.failure = { path, retryAt: now() + ANNOUNCEMENT_FAILURE_MS };
        return null;
      }
    })();
    const entry = { path, promise };
    slot.pending = entry;
    try { return await promise; }
    finally { if (slot.pending === entry) slot.pending = null; }
  }

  return { current, image: (id: string) => asset(id, "image"), animation: (id: string) => asset(id, "animation") };
}
