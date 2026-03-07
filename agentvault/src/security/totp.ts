/**
 * TOTP (Time-based One-Time Password) — RFC 6238
 *
 * Pure-Node implementation using only node:crypto.
 * Compatible with Authy, Google Authenticator, and any RFC 6238 client.
 *
 * Algorithm:
 *   counter = floor(unixTime / period)
 *   code    = HOTP(secret, counter)   ← RFC 4226
 *   HOTP    = truncate(HMAC-SHA1(secret, counter_be64))
 */

import crypto from 'node:crypto';

// ─── Base32 ─────────────────────────────────────────────────────────────────
// RFC 4648 §6 alphabet (uppercase A-Z + digits 2-7, no padding chars in lookups)

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer as a Base32 string (with padding).
 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = '';

  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_CHARS[(acc >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += BASE32_CHARS[(acc << (5 - bits)) & 0x1f];
  }

  // Pad to a multiple of 8 characters
  while (out.length % 8 !== 0) {
    out += '=';
  }

  return out;
}

/**
 * Decode a Base32 string to a Buffer.
 * Case-insensitive; strips padding before processing.
 */
export function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=/g, '');
  let bits = 0;
  let acc = 0;
  const out: number[] = [];

  for (const ch of s) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: '${ch}'`);
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

// ─── HOTP — RFC 4226 ────────────────────────────────────────────────────────

/**
 * Compute an HOTP code for the given secret and counter.
 *
 * @param secret  - HMAC-SHA1 key (raw bytes)
 * @param counter - 64-bit unsigned integer counter
 * @param digits  - output length (default 6)
 */
function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  // Pack counter as 8-byte big-endian (unsigned)
  const cb = Buffer.alloc(8);
  cb.writeBigUInt64BE(counter);

  const mac = crypto.createHmac('sha1', secret).update(cb).digest();

  // Dynamic truncation per §5.3 of RFC 4226
  // Buffer indexing is always in-range for a 20-byte HMAC-SHA1 digest
  const offset = mac[19]! & 0x0f;
  const code =
    (((mac[offset]! & 0x7f) << 24) |
      ((mac[offset + 1]! & 0xff) << 16) |
      ((mac[offset + 2]! & 0xff) << 8) |
      (mac[offset + 3]! & 0xff)) %
    10 ** digits;

  return code.toString().padStart(digits, '0');
}

// ─── TOTP — RFC 6238 ────────────────────────────────────────────────────────

/**
 * Generate a TOTP code for the current (or provided) time.
 *
 * @param secret  - TOTP secret (raw bytes, typically 20 bytes)
 * @param opts.digits  - code length (default 6)
 * @param opts.period  - time step in seconds (default 30)
 * @param opts.nowMs   - Unix timestamp in milliseconds (default Date.now())
 */
export function generateTotp(
  secret: Buffer,
  opts: { digits?: number; period?: number; nowMs?: number } = {},
): string {
  const { digits = 6, period = 30, nowMs = Date.now() } = opts;
  const counter = BigInt(Math.floor(nowMs / 1000 / period));
  return hotp(secret, counter, digits);
}

/**
 * Verify a TOTP code against the current time.
 *
 * Accepts codes from `window` periods before and after the current step
 * to tolerate minor clock drift between the user's device and the server.
 *
 * @param secret  - TOTP secret (raw bytes)
 * @param code    - 6-digit code string to verify
 * @param opts.digits  - code length (default 6)
 * @param opts.period  - time step in seconds (default 30)
 * @param opts.window  - number of steps to check on each side (default 1)
 * @param opts.nowMs   - Unix timestamp in milliseconds (default Date.now())
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: { digits?: number; period?: number; window?: number; nowMs?: number } = {},
): boolean {
  const { digits = 6, period = 30, window = 1, nowMs = Date.now() } = opts;

  for (let w = -window; w <= window; w++) {
    const t = nowMs + w * period * 1000;
    if (generateTotp(secret, { digits, period, nowMs: t }) === code) {
      return true;
    }
  }

  return false;
}

// ─── Key Generation ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 20-byte TOTP secret.
 * The secret never leaves the local machine — only the Base32 form is
 * displayed once so the user can enroll it in their authenticator app.
 */
export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(20);
}

// ─── otpauth URI ─────────────────────────────────────────────────────────────

/**
 * Build an `otpauth://totp/…` URI that authenticator apps can scan as a QR code.
 *
 * @param secret  - TOTP secret (raw bytes)
 * @param label   - Human-readable account label (e.g. "AgentVault:pending-001")
 * @param issuer  - App / service name shown in the authenticator (default "AgentVault")
 */
export function otpAuthUri(secret: Buffer, label: string, issuer = 'AgentVault'): string {
  const s = base32Encode(secret);
  return (
    `otpauth://totp/${encodeURIComponent(label)}` +
    `?secret=${s}` +
    `&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1` +
    `&digits=6` +
    `&period=30`
  );
}
