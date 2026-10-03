// `crypto.randomUUID()` is a [SecureContext] API, so it is undefined on
// non-HTTPS, non-localhost origins (for example a LAN IP served over plain
// HTTP). Fall back to a JavaScript-generated RFC 4122 version 4 UUID there:
// consumers validate the value with `z.string().uuid()` (comment request
// schemas) and a UUID-shaped regex (persisted draft submissions), so the
// fallback must keep the UUID shape, not just be unique. Uniqueness only needs
// to hold within one browser session for attempt/idempotency bookkeeping.
function fallbackUuidV4(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  );
}

export function randomUuidOrFallback(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return fallbackUuidV4();
}
