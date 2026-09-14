import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { forbidden } from "../../errors.js";
import { getCloudStackContext } from "../cloud-instance.js";
import type { RuntimeServicePreviewConfig } from "./preview-config.js";

export const PREVIEW_AUTHORIZED_HEADER = "x-paperclip-preview-authorized";
export const PREVIEW_INGRESS_HEADERS = ["x-paperclip-preview-host", "x-paperclip-preview-ingress-time", "x-paperclip-preview-ingress-signature"] as const;
export const previewIngressPayload = (stackId: string, method: string, path: string, host: string, time: string) =>
  JSON.stringify(["paperclip-preview-ingress-v1", stackId, method, path, host, time]);

/** The signature establishes the edge-selected route, never the viewer's authority. */
export function createPreviewIngressVerifier(config: RuntimeServicePreviewConfig, value = process.env.PAPERCLIP_SERVICE_PREVIEW_INGRESS_PUBLIC_KEYS) {
  let keys: KeyObject[] = [];
  if (value !== undefined) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2 || parsed.some((key) => typeof key !== "string")) throw new Error();
      keys = parsed.map((key: string) => createPublicKey(key));
      if (keys.some((key) => key.asymmetricKeyType !== "ed25519")) throw new Error();
    } catch { throw new Error("Preview ingress requires one or two Ed25519 public keys as a JSON array"); }
  }
  const stackId = getCloudStackContext()?.stackId;
  if (keys.length && !stackId) throw new Error("Preview ingress requires the Cloud stack identity");
  return {
    claims(req: IncomingMessage) { return PREVIEW_INGRESS_HEADERS.some((name) => req.headers[name] !== undefined); },
    host(req: IncomingMessage): string | undefined {
      const claimed = this.claims(req);
      if (!claimed) {
        // Once an authenticated ingress is configured, direct preview requests
        // cannot bypass it. Ordinary board hosts still use their own auth path.
        if (keys.length && config.match(req.headers.host)) throw forbidden("Preview ingress verification required");
        return req.headers.host;
      }
      const [host, time, signature] = PREVIEW_INGRESS_HEADERS.map((name) => req.headers[name]);
      if (!stackId || !keys.length || typeof host !== "string" || !config.match(host)
        || typeof time !== "string" || !/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 30_000
        || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)
        || !req.url?.startsWith("/") || req.url.startsWith("//") || /[\\\r\n\0#]/.test(req.url)) throw forbidden("Invalid preview ingress proof");
      const payload = Buffer.from(previewIngressPayload(stackId, req.method ?? "GET", req.url, host, time));
      if (!keys.some((key) => verify(null, payload, key, Buffer.from(signature, "base64url")))) throw forbidden("Invalid preview ingress proof");
      return host;
    },
  };
}
