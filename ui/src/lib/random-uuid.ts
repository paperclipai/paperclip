/**
 * RFC 4122 v4 UUID for client request IDs, idempotency keys, and local ids.
 *
 * `crypto.randomUUID` exists only in secure contexts (https or localhost). A
 * Paperclip instance reached over plain http on a LAN or tailnet host has no
 * such function, so every call site that needs a UUID must fall back to
 * `getRandomValues`, which browsers expose everywhere. The output stays valid
 * for the server's `z.string().uuid()` validators. Without any CSPRNG the
 * helper throws instead of producing predictable identifiers.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  // These IDs serve as idempotency keys and secret-definition suffixes, so
  // they must come from a CSPRNG. Every browser exposes getRandomValues, in
  // insecure contexts too; refuse to guess rather than emit predictable IDs.
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("Secure random number generation is unavailable in this browser.");
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
