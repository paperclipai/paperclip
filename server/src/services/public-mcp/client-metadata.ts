import { z } from "zod";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";

export function validMcpRedirect(value: string) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
/** RFC 8252: native loopback listeners choose an ephemeral port, not a new callback. */
export function mcpRedirectMatches(registered: string[], requested: string, native: boolean) {
  if (registered.includes(requested)) return true;
  if (!native || !validMcpRedirect(requested)) return false;
  const loopbackAuthority = /^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(?::[0-9]+)?(?=\/|$)/;
  if (!loopbackAuthority.test(requested)) return false;
  return registered.some(uri => validMcpRedirect(uri) && loopbackAuthority.test(uri)
    && uri.replace(loopbackAuthority, "$1") === requested.replace(loopbackAuthority, "$1"));
}
const metadataSchema = z.object({
  client_id: z.string().max(2048), client_name: z.string().trim().min(1).max(100),
  application_type: z.enum(["native", "web"]).optional(),
  redirect_uris: z.array(z.string().max(2048).refine(validMcpRedirect)).max(10),
  token_endpoint_auth_method: z.literal("none").default("none"),
  // CIMD describes a client's capabilities across authorization servers. An
  // extra capability (Claude web publishes jwt-bearer) must not disable PKCE.
  // Retain only grants this server implements; token dispatch still rejects others.
  grant_types: z.array(z.string().min(1).max(2048)).max(20).default(["authorization_code"])
    .transform(grants => [...new Set(grants)].filter(grant =>
      ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"].includes(grant))),
  response_types: z.array(z.literal("code")).default(["code"]),
});
type Metadata = z.infer<typeof metadataSchema>;
export type MetadataFetch = (url: URL, init: RequestInit) => Promise<Response>;
const guardedFetch: MetadataFetch = (url, init) => guardedRemoteHttpFetch(url, init, {
  allowPrivateNetwork: false, error: () => new Error("Client metadata URL is unavailable."),
  connectTimeoutMs: 5000, responseTimeoutMs: 5000,
});

/** Client names are descriptive, not a verified brand identity. */
export function createClientMetadataResolver(fetcher: MetadataFetch = guardedFetch) {
  const cache = new Map<string, { value: Metadata; expiresAt: number }>();
  return async (id: string, admitFetch?: () => Promise<void>): Promise<Metadata> => {
    const url = new URL(id);
    if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.hash || id.length > 2048) throw new Error("Invalid client metadata URL.");
    const now = Date.now();
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
    const hit = cache.get(id);
    if (hit) return hit.value;
    // Cached, already-validated metadata performs no outbound work. Charge only
    // cache misses so users sharing a proxy can reconnect to known clients.
    await admitFetch?.();
    const response = await fetcher(url, { redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok || response.status >= 300 || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel(); throw new Error("Invalid client metadata response.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty client metadata.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 32_768) throw new Error("Client metadata is too large.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const value = metadataSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (value.client_id !== id) throw new Error("Client metadata ID mismatch.");
    // Older public clients (including Claude Code) omit the OIDC application_type.
    // Infer native only when every declared callback is an HTTP loopback listener.
    if (!value.application_type && value.redirect_uris.length > 0 && value.redirect_uris.every(uri => {
      const redirect = new URL(uri);
      return redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
    })) value.application_type = "native";
    const control = response.headers.get("cache-control") ?? "";
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(control)?.[1];
    const ttl = /(?:no-store|no-cache)/i.test(control) ? 0 : Math.min(300, maxAge ? Number(maxAge) : 60) * 1000;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    if (ttl > 0) cache.set(id, { value, expiresAt: now + ttl });
    return value;
  };
}
