import { randomBytes } from "node:crypto";

/**
 * Crockford base32 — used by ULID for the timestamp + randomness encoding.
 * Excludes I, L, O, U so encoded IDs are unambiguous when read aloud.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes: Uint8Array, length: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  // Pad/truncate to exactly `length` characters of 5-bit symbols.
  const totalBits = BigInt(length * 5);
  if (BigInt(bytes.length * 8) < totalBits) {
    bits <<= totalBits - BigInt(bytes.length * 8);
  } else if (BigInt(bytes.length * 8) > totalBits) {
    bits >>= BigInt(bytes.length * 8) - totalBits;
  }
  const out: string[] = [];
  for (let i = length - 1; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 31n);
    out.push(CROCKFORD[idx]);
  }
  return out.join("");
}

/**
 * Generate a ULID — 48-bit timestamp + 80-bit random, encoded as 26-char
 * Crockford base32. Lexicographically sortable by creation time.
 *
 * `now` is injectable for deterministic tests.
 */
export function newRunUlid(now?: () => number): string {
  const ts = (now ?? (() => Date.now()))();
  const tsBytes = new Uint8Array(6);
  let n = BigInt(ts);
  for (let i = 5; i >= 0; i--) {
    tsBytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const tsPart = encodeBase32(tsBytes, 10);
  const randomPart = encodeBase32(new Uint8Array(randomBytes(10)), 16);
  return `${tsPart}${randomPart}`;
}

/**
 * Lowercased ULID for use in DNS-1123 names (Job/Secret names). K8s names
 * must be lowercase alphanumeric+hyphen so we lowercase the Crockford output.
 */
export function newRunUlidDns(now?: () => number): string {
  return newRunUlid(now).toLowerCase();
}
