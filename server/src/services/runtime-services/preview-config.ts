import { createHash } from "node:crypto";
import { parse } from "tldts";
import { resolvePaperclipInstanceId } from "../../home-paths.js";
import { getCloudStackContext } from "../cloud-instance.js";

export function previewInstanceIdentity(): string {
  const cloud = getCloudStackContext();
  if (cloud && !cloud.stackId) throw new Error("Hosted previews require PAPERCLIP_CLOUD_STACK_ID for stable instance routing");
  return cloud ? `cloud:${cloud.stackId}` : resolvePaperclipInstanceId();
}

export interface RuntimeServicePreviewConfig {
  base: URL;
  local: boolean;
  origin(serviceId: string, endpoint: string): string;
  match(host: string | undefined): { serviceId: string; endpoint: string } | null;
}

/** Each endpoint is a separate registrable domain, not just a sibling origin. */
export function runtimeServicePreviewConfig(value: string | undefined, allowLocal: boolean): RuntimeServicePreviewConfig | null {
  if (!value?.trim()) return null;
  const base = new URL(value.trim());
  const local = base.hostname === "localhost";
  const parsed = parse(base.hostname, { allowPrivateDomains: true });
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || (!local && (base.protocol !== "https:" || !parsed.isPrivate || parsed.publicSuffix !== base.hostname))
    || (local && (!allowLocal || !["http:", "https:"].includes(base.protocol)))) {
    throw new Error("Preview base must be an HTTPS private public suffix with wildcard DNS/TLS; localhost is available only for local development");
  }
  const instance = createHash("sha256").update(previewInstanceIdentity()).digest("hex").slice(0, 12);
  // UUID without hyphens, endpoint name, and instance hash all fit one DNS
  // label using an endpoint digest. The declared endpoint is resolved from DB.
  const endpointKey = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 10);
  return {
    base, local,
    origin(serviceId, endpoint) {
      const host = `${instance}-${serviceId.replaceAll("-", "")}-${endpointKey(endpoint)}.${base.host}`;
      return `${base.protocol}//${host}`;
    },
    match(host) {
      if (!host || host !== host.toLowerCase()) return null;
      const suffix = `.${base.host}`;
      if (!host.endsWith(suffix)) return null;
      const label = host.slice(0, -suffix.length);
      const match = new RegExp(`^${instance}-([a-f0-9]{32})-([a-f0-9]{10})$`).exec(label);
      if (!match) return null;
      const id = match[1]!;
      return { serviceId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, endpoint: match[2]! };
    },
  };
}

export function previewPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
    || /[\\\r\n\0]/.test(value) || value.length > 8192) return "/";
  const parsed = new URL(value, "https://preview.invalid");
  if (parsed.origin !== "https://preview.invalid" || parsed.pathname.startsWith("/.paperclip/")) return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
