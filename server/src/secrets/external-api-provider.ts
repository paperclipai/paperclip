import { createHash } from "node:crypto";
import type { SecretProviderModule } from "./types.js";

const apiUrl = process.env.PAPERCLIP_SECRETS_API_URL;
const secret = process.env.PAPERCLIP_MANAGEMENT_SECRET;

function headers() {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (secret) h["x-paperclip-management-secret"] = secret;
  return h;
}

export const externalApiProvider: SecretProviderModule = {
  id: "external_api",
  descriptor: { id: "external_api", label: "External API", requiresExternalRef: false },
  async createVersion({ value, externalRef }) {
    if (!apiUrl) throw new Error("PAPERCLIP_SECRETS_API_URL is not configured");
    const res = await fetch(`${apiUrl}/secrets`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ value, externalRef }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`External secrets API returned ${res.status}`);
    const body = (await res.json()) as { ref: string };
    return {
      material: { ref: body.ref },
      valueSha256: createHash("sha256").update(value).digest("hex"),
      externalRef: body.ref,
    };
  },
  async resolveVersion({ material }) {
    if (!apiUrl) throw new Error("PAPERCLIP_SECRETS_API_URL is not configured");
    const ref = (material as { ref?: string }).ref;
    if (!ref) throw new Error("Missing secret ref in material");
    const res = await fetch(`${apiUrl}/secrets/${encodeURIComponent(ref)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`External secrets API returned ${res.status}`);
    const body = (await res.json()) as { value: string };
    return body.value;
  },
};
