import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub HMAC-SHA256 signatures are always "sha256=" + 64 hex chars = 71 bytes.
const EXPECTED_SIG_BYTE_LEN = 71;

/**
 * Verify the X-Hub-Signature-256 header GitHub sends with every webhook delivery.
 *
 * Timing-safety contract:
 *   - `timingSafeEqual` requires equal-length buffers; throwing on mismatch would
 *     itself leak length information. We encode `signatureHeader` as UTF-8 bytes and
 *     compare against the expected bytes. When lengths differ, both buffers are
 *     built before comparison so no early-exit short-circuits the constant-time path.
 *
 * Empty-secret guard:
 *   - An empty secret produces a deterministic HMAC that any attacker can forge.
 *     Reject before HMAC computation to fail closed.
 */
export function verifyGitHubSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  if (!secret) return false;

  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`,
    "utf8",
  );

  // Build the candidate buffer to the same length as expected so timingSafeEqual
  // never throws. Pad with a null byte if shorter; truncate if longer.
  // After timingSafeEqual returns, the lengths differ → false regardless.
  const candidate = Buffer.alloc(expected.byteLength, 0);
  const raw = Buffer.from(signatureHeader, "utf8");
  raw.copy(candidate, 0, 0, Math.min(raw.byteLength, candidate.byteLength));

  const equal = timingSafeEqual(expected, candidate);
  // A matching comparison is only valid when the actual byte lengths are identical.
  return equal && raw.byteLength === expected.byteLength;
}

/** Expected byte length of a valid GitHub SHA-256 signature header. Exported for tests. */
export const GITHUB_SIG_BYTE_LEN = EXPECTED_SIG_BYTE_LEN;
