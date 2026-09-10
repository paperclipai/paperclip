import { createHash } from "node:crypto";
import type { AgentAppearance, AgentAvatarSize, CharacterState } from "@paperclipai/shared";
import type { StorageProvider } from "../storage/types.js";
import { createInviteRateLimiter } from "./invite-rate-limit.js";
import { createAgentAvatarPool } from "./agent-avatar-pool.js";

export interface AgentAvatarRequest {
  appearance: AgentAppearance;
  size: AgentAvatarSize;
  scale: 1 | 2;
  pose: CharacterState;
  muted: boolean;
}
export function avatarCacheKey(request: AgentAvatarRequest) {
  const { appearance, size, scale, pose, muted } = request;
  return `generated-agent-avatars/${appearance.characterVersion}/${muted ? "muted-dream" : appearance.paletteId}/${pose}-${size}-${scale}.png`;
}
export class AvatarAdmissionError extends Error {
  constructor(public readonly retryAfterSeconds: number) { super("Too many cold avatar requests"); }
}
type CacheMetadata = { sha256: string; byteSize: number };
export function createAgentAvatarService(storage: StorageProvider, render?: (request: AgentAvatarRequest) => Promise<Buffer>) {
  const pool = render ? undefined : createAgentAvatarPool();
  const pending = new Map<string, Promise<CacheMetadata>>();
  // Only cold keys consume admission; warm images and single-flight joiners
  // remain available. Leave at least half the pool queue for other clients.
  const activeByClient = new Map<string, number>();
  const limiter = createInviteRateLimiter({ maxRequests: 256 });
  async function ensure(request: AgentAvatarRequest, key: string, client: string): Promise<CacheMetadata> {
    const metadataKey = `${key}.json`;
    const [image, metadata] = await Promise.all([
      storage.headObject({ objectKey: key }), storage.headObject({ objectKey: metadataKey }),
    ]);
    if (image.exists && metadata.exists) {
      const object = await storage.getObject({ objectKey: metadataKey });
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
      try {
        const cached = JSON.parse(Buffer.concat(chunks).toString()) as CacheMetadata;
        if (/^[a-f0-9]{64}$/.test(cached.sha256) && cached.byteSize > 0 && cached.byteSize === image.contentLength) return cached;
      } catch { /* Disposable metadata: regenerate a corrupt or old cache entry. */ }
    }
    const active = activeByClient.get(client) ?? 0;
    if (active >= 32) throw new AvatarAdmissionError(5);
    const admission = limiter.consume(client);
    if (!admission.allowed) throw new AvatarAdmissionError(admission.retryAfterSeconds);
    activeByClient.set(client, active + 1);
    try {
      const bytes = await (render ?? pool!.render)(request);
      const result = { sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
      // Both providers publish whole objects atomically. Publish metadata last so
      // readers never consider an unfinished image a completed cache entry.
      await storage.putObject({ objectKey: key, body: bytes, contentLength: bytes.length, contentType: "image/png" });
      const encoded = Buffer.from(JSON.stringify(result));
      await storage.putObject({ objectKey: metadataKey, body: encoded, contentLength: encoded.length, contentType: "application/json" });
      return result;
    } finally {
      const remaining = (activeByClient.get(client) ?? 1) - 1;
      if (remaining) activeByClient.set(client, remaining);
      else activeByClient.delete(client);
    }
  }
  return {
    async get(request: AgentAvatarRequest, client = "unknown") {
      const key = avatarCacheKey(request);
      let result = pending.get(key);
      if (!result) {
        result = ensure(request, key, client).finally(() => pending.delete(key));
        pending.set(key, result);
      }
      const metadata = await result;
      const object = await storage.getObject({ objectKey: key });
      return { stream: object.stream, byteSize: metadata.byteSize, etag: `"${metadata.sha256}"` };
    },
    async close() { await pool?.close(); },
  };
}
