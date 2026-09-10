import { createHash } from "node:crypto";
import type { AgentAppearance, AgentAvatarSize, CharacterState } from "@paperclipai/shared";
import type { StorageProvider } from "../storage/types.js";
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
type CacheMetadata = { sha256: string; byteSize: number };
export function createAgentAvatarService(storage: StorageProvider, render?: (request: AgentAvatarRequest) => Promise<Buffer>) {
  const pool = render ? undefined : createAgentAvatarPool();
  const pending = new Map<string, Promise<CacheMetadata>>();
  async function ensure(request: AgentAvatarRequest, key: string): Promise<CacheMetadata> {
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
    const bytes = await (render ?? pool!.render)(request);
    const result = { sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
    // Both providers publish whole objects atomically. Publish metadata last so
    // readers never consider an unfinished image a completed cache entry.
    await storage.putObject({ objectKey: key, body: bytes, contentLength: bytes.length, contentType: "image/png" });
    const encoded = Buffer.from(JSON.stringify(result));
    await storage.putObject({ objectKey: metadataKey, body: encoded, contentLength: encoded.length, contentType: "application/json" });
    return result;
  }
  return {
    async get(request: AgentAvatarRequest) {
      const key = avatarCacheKey(request);
      let result = pending.get(key);
      if (!result) {
        result = ensure(request, key).finally(() => pending.delete(key));
        pending.set(key, result);
      }
      const metadata = await result;
      const object = await storage.getObject({ objectKey: key });
      return { stream: object.stream, byteSize: metadata.byteSize, etag: `"${metadata.sha256}"` };
    },
    async close() { await pool?.close(); },
  };
}
