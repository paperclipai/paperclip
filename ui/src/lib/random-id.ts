/**
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or localhost).
 * Self-hosted boards commonly run at `http://<lan-ip>:<port>`, where that API
 * is `undefined` and any render that calls it throws — surfacing to users as
 * "Couldn't open <overlay>" error dialogs. Use `randomId()` for UI ids so an
 * insecure origin keeps working; the fallback stays fully random and
 * unguessable (`getRandomValues` has no secure-context restriction).
 */
export type RandomId = `${string}-${string}-${string}-${string}-${string}`;

export function randomId(): RandomId {
  const native = typeof crypto !== "undefined" ? crypto.randomUUID : undefined;
  if (typeof native === "function") {
    return native.call(crypto);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
