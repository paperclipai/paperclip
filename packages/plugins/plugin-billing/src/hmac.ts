import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function signStubPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyStubSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  // Require exactly the canonical SHA-256 hex length (64 chars). This is deliberately
  // stricter than "looks like hex": Buffer.from(str, "hex") silently drops a trailing
  // unpaired nibble instead of throwing, so without this check a 65-char string made
  // of a genuine signature plus one extra hex digit decodes to the same 32 bytes as
  // the real signature and would incorrectly verify. Accept case-insensitively (headers
  // may arrive uppercased) and normalize before decoding.
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signStubPayload(secret, rawBody), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.toLowerCase(), "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Node lowercases inbound header names, but be defensive: case-insensitive lookup, first value wins. */
export function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const SECRET_STATE_KEY = "stub-webhook-secret";

/**
 * Per-install stub webhook secret: generated once, persisted in
 * instance-scoped plugin state. Never logged, never placed in config JSON.
 */
export async function ensureStubWebhookSecret(state: PluginStateClient): Promise<string> {
  const existing = await state.get({ scopeKind: "instance", stateKey: SECRET_STATE_KEY });
  if (typeof existing === "string" && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const secret = randomBytes(32).toString("hex");
  await state.set({ scopeKind: "instance", stateKey: SECRET_STATE_KEY }, secret);
  // ctx.state.set() is a last-write-wins upsert; there is no compare-and-swap
  // available plugin-side. Two concurrent first-boot callers can each read `null`,
  // each mint their own secret, and each call set() — whichever write lands last
  // wins in storage, but both callers would otherwise return their own (possibly
  // losing) locally-minted secret, causing them to disagree about the "real"
  // secret used to verify future webhooks. Re-read immediately after writing so
  // every caller converges on whatever actually ended up persisted, rather than
  // trusting its own local value.
  //
  // This narrows the race to the tiny window between this set() and the re-get()
  // below, it does not eliminate it. A host-side setIfAbsent/CAS primitive would
  // close that window entirely; tracked as a follow-up.
  const stored = await state.get({ scopeKind: "instance", stateKey: SECRET_STATE_KEY });
  if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) return stored;
  return secret;
}
