export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

// Compare two strings in constant time so an attacker can't infer the expected
// token character-by-character via response-latency timing. We hash both sides
// to SHA-256 first so the byte-by-byte comparison length is fixed (and doesn't
// leak the token's length), then walk the buffers with a constant-time XOR
// reduction. This avoids `crypto.subtle.timingSafeEqual` because that helper
// is not portable: it exists on Cloudflare Workers but is missing from Node's
// `crypto.subtle` (which would break unit tests). The manual XOR reduction on
// a fixed-length hash output is the same algorithm the helper uses internally.
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHashBuf, bHashBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aBytes = new Uint8Array(aHashBuf);
  const bBytes = new Uint8Array(bHashBuf);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function isAuthorizedRequest(
  request: Request,
  expectedToken: string | undefined,
): Promise<boolean> {
  if (!expectedToken || expectedToken.trim().length === 0) return false;
  const presented = readBearerToken(request);
  if (!presented) return false;
  return timingSafeStringEqual(presented, expectedToken);
}
